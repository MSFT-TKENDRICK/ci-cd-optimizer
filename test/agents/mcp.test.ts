import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer, MCP_TOOLS, type McpServerOptions } from "../../src/agents/mcp.js";
import type { LintSummary } from "../../src/agents/workspace.js";
import type { WorkflowRunPayload } from "../../src/telemetry/snapshot.js";
import { PROJECT_YAML } from "../review/fixtures.js";
import { callsTo, fakeApi, TIMEOUT_ONLY, writes } from "../service/api.js";
import { forbiddenLocalRule, MISSING_TIMEOUT, tempDirs, WORKFLOW, write } from "./helpers.js";
import { LIMITS } from "../../src/agents/safety.js";
import { githubReader } from "../../src/agents/github.js";
import type { RemoteScanSummary, RunReport } from "../../src/agents/remote.js";
import { cappedJobs, fanoutFiles, remoteFixture } from "./remote-fixtures.js";

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

const dirs = tempDirs();
const clients: Client[] = [];
let repo: string;
let other: string;

beforeEach(async () => {
  repo = await dirs.make("cicd-mcp-repo-");
  other = await dirs.make("cicd-mcp-other-");
  await write(repo, WORKFLOW, MISSING_TIMEOUT);
  await write(other, WORKFLOW, MISSING_TIMEOUT);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await dirs.cleanup();
});

/** A host connected in memory; `roots` makes it advertise and answer MCP roots. */
async function connect(options: McpServerOptions, roots?: { dirs: string[] }) {
  const server = createMcpServer(options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-host", version: "1.0.0" }, { capabilities: roots ? { roots: { listChanged: true } } : {} });
  if (roots) client.setRequestHandler("roots/list", async () => ({ roots: roots.dirs.map((dir) => ({ uri: pathToFileURL(dir).href })) }));
  await server.connect(serverSide);
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

const text = (result: ToolResult) => result.content.map((block) => block.text ?? "").join("\n");

async function data<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await call(client, name, args);
  if (result.isError) throw new Error(`${name} failed: ${text(result)}`);
  expect(JSON.parse(text(result))).toEqual(result.structuredContent);
  return result.structuredContent as T;
}

async function failure(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await call(client, name, args);
  expect(result.isError).toBe(true);
  return text(result);
}

describe("MCP server", () => {
  it("lists read-only, closed-world tools, resources, and prompts", async () => {
    const client = await connect({ fallbackRoot: repo });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ["effective_config", "explain_rule", "fix_preview", "lint", "lint_content", "list_rules", "validate_review_project"],
    );
    for (const tool of tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(tools.find((tool) => tool.name === MCP_TOOLS.lint)?.inputSchema.properties).toHaveProperty("root");
    expect(client.getInstructions()).toContain("pass `root`");
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(["optimize-pipeline", "triage-findings"]);
    const prompt = await client.getPrompt({ name: "optimize-pipeline", arguments: { focus: "caching" } });
    expect(JSON.stringify(prompt.messages)).toContain("focusing on caching");
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toContain("cicd://rules/workflow/job-timeout");
  });

  it("runs every workspace tool against the default workspace", async () => {
    const client = await connect({ fallbackRoot: repo });
    const lint = await data<LintSummary>(client, MCP_TOOLS.lint, { minSeverity: "warn" });
    expect(lint.root).toBe(repo);
    expect(lint.diagnostics.map((diagnostic) => diagnostic.ruleId)).toContain("workflow/job-timeout");
    const fixed = MISSING_TIMEOUT.replace("    steps:", "    timeout-minutes: 15\n    steps:");
    const content = await data<LintSummary>(client, MCP_TOOLS.lintContent, { content: [{ path: WORKFLOW, text: fixed }] });
    expect(content.diagnostics.some((diagnostic) => diagnostic.ruleId === "workflow/job-timeout")).toBe(false);
    const preview = await data(client, MCP_TOOLS.fixPreview, { ruleIds: ["workflow/job-timeout"] });
    expect(preview).toMatchObject({ written: false, applied: 1 });
    expect(await data(client, MCP_TOOLS.listRules, { ruleset: "workflow", fixable: true })).toMatchObject({ total: expect.any(Number) });
    expect(await data(client, MCP_TOOLS.explainRule, { id: "workflow/job-timeout" })).toMatchObject({ effectiveSeverity: "warn" });
    expect(await data(client, MCP_TOOLS.effectiveConfig, { rules: { "workflow/job-timeout": "error" } }))
      .toMatchObject({ rules: { "workflow/job-timeout": "error" } });
    await write(repo, "projects/widget/project.yaml", PROJECT_YAML);
    expect(await data(client, MCP_TOOLS.validateReviewProject, { path: "projects/widget/project.yaml" })).toMatchObject({ valid: true });
    const config = await client.readResource({ uri: "cicd://config" });
    expect(JSON.parse((config.contents[0] as { text: string }).text)).toMatchObject({ root: repo });
  });

  it("returns actionable tool errors instead of protocol failures", async () => {
    const client = await connect({ fallbackRoot: repo });
    expect(await failure(client, MCP_TOOLS.explainRule, { id: "workflow/job-timout" })).toMatch(/Did you mean "workflow\/job-timeout"/i);
    expect(await failure(client, MCP_TOOLS.lint, { paths: ["../escape"] })).toMatch(/outside the lint root/);
    expect(await failure(client, MCP_TOOLS.lint, { root: "relative/dir" })).toMatch(/must be an absolute directory path/);
    expect(await failure(client, MCP_TOOLS.lint, { root: join(repo, "missing") })).toMatch(/is not a directory/);
  });

  it("never executes local rules across tools and resources and bounds all tool envelopes", async () => {
    const marker = await forbiddenLocalRule(repo);
    const client = await connect({ fallbackRoot: repo });
    await write(repo, "projects/widget/project.yaml", PROJECT_YAML);
    for (const [name, args] of [
      [MCP_TOOLS.lint, {}], [MCP_TOOLS.fixPreview, {}], [MCP_TOOLS.effectiveConfig, {}],
      [MCP_TOOLS.explainRule, { id: "workflow/job-timeout" }], [MCP_TOOLS.listRules, {}],
      [MCP_TOOLS.lintContent, { content: [{ path: WORKFLOW, text: MISSING_TIMEOUT }] }],
      [MCP_TOOLS.validateReviewProject, { path: "projects/widget/project.yaml" }],
    ] as const) {
      const result = await call(client, name, args);
      expect(result.isError).not.toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(LIMITS.outputBytes);
    }
    for (const uri of ["cicd://config", "cicd://rules/workflow/job-timeout"]) await client.readResource({ uri });
    await expect(client.readResource({ uri: "cicd://rules/%ZZ" })).rejects.toThrow("percent encoding");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const rules = await data<{ total: number; omittedRules: number; rules: unknown[] }>(client, MCP_TOOLS.listRules, { limit: 1 });
    expect(rules.omittedRules).toBe(rules.total - 1);
    expect(rules.rules).toHaveLength(1);
  });

  it("analyzes any absolute root when neither --root nor client roots constrain it", async () => {
    const client = await connect({ fallbackRoot: repo });
    expect((await data<LintSummary>(client, MCP_TOOLS.lint, { root: other })).root).toBe(other);
  });

  it("refuses the plugin install directory and explains how to pass root", async () => {
    const client = await connect({ fallbackRoot: other, pluginRoot: other });
    const message = await failure(client, MCP_TOOLS.lint);
    expect(message).toContain("The default workspace");
    expect(message).toContain("is the plugin's install directory");
    expect(message).toContain("pass `root`");
    expect(await failure(client, MCP_TOOLS.lint, { root: join(other, ".github") })).toContain("plugin's install directory");
    expect((await data<LintSummary>(client, MCP_TOOLS.lint, { root: repo })).root).toBe(repo);
    // Rule documentation needs no workspace, so it still works from the plugin directory.
    const rule = await client.readResource({ uri: "cicd://rules/workflow/job-timeout" });
    expect(JSON.parse((rule.contents[0] as { text: string }).text)).toMatchObject({ id: "workflow/job-timeout", effectiveSeverity: "warn" });
  });

  it("keeps explicit roots inside the server's --root", async () => {
    const nested = join(repo, "service");
    await mkdir(nested);
    const client = await connect({ root: repo, fallbackRoot: other }, { dirs: [other] });
    expect((await data<LintSummary>(client, MCP_TOOLS.lint)).root).toBe(repo);
    expect((await data<LintSummary>(client, MCP_TOOLS.lint, { root: nested })).root).toBe(nested);
    expect(await failure(client, MCP_TOOLS.lint, { root: other })).toMatch(/is outside the server's --root/);
  });

  it("defaults to the client's roots, confines explicit roots to them, and follows root changes", async () => {
    const roots = { dirs: [repo] };
    const client = await connect({ fallbackRoot: other }, roots);
    expect((await data<LintSummary>(client, MCP_TOOLS.lint)).root).toBe(repo);
    expect(await failure(client, MCP_TOOLS.lint, { root: other })).toMatch(/outside the workspace roots this client shared/);
    roots.dirs = [other];
    await client.sendRootsListChanged();
    expect((await data<LintSummary>(client, MCP_TOOLS.lint)).root).toBe(other);
    expect(await failure(client, MCP_TOOLS.lint, { root: repo })).toMatch(/outside the workspace roots/);
  });

  it("falls back when the client's roots are not local directories", async () => {
    const client = await connect({ fallbackRoot: repo }, { dirs: [join(other, "missing")] });
    expect((await data<LintSummary>(client, MCP_TOOLS.lint)).root).toBe(repo);
  });
});

const REPOSITORY = { id: 42, full_name: "acme/widgets" };
const at = (time: string) => `2026-11-01T00:${time}Z`;
const RUN: WorkflowRunPayload = {
  id: 2000,
  name: "CI",
  path: ".github/workflows/ci.yml",
  workflow_id: 7,
  run_attempt: 1,
  head_sha: "abc",
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  created_at: at("00:00"),
  run_started_at: at("00:05"),
  updated_at: at("10:00"),
  html_url: "https://github.com/acme/widgets/actions/runs/2000",
};
const JOBS = [
  { id: 1, name: "build", conclusion: "success", labels: ["ubuntu-24.04"], created_at: at("00:05"), started_at: at("00:10"), completed_at: at("02:10"), steps: [] },
  { id: 2, name: "test", conclusion: "success", labels: ["ubuntu-24.04"], created_at: at("02:10"), started_at: at("02:15"), completed_at: at("10:05"), steps: [] },
];
const CI = "name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps: [{ run: make }]\n  test:\n    needs: build\n    runs-on: ubuntu-24.04\n    steps: [{ run: make test }]\n";

const github = (metadata: Record<string, unknown> = REPOSITORY) => fakeApi({
  repositoryMetadata: metadata,
  config: TIMEOUT_ONLY,
  refs: { main: { [WORKFLOW]: MISSING_TIMEOUT }, abc: { [WORKFLOW]: CI } },
  runs: { 2000: RUN },
  jobs: { 2000: JOBS },
});

describe("MCP server GitHub tools", () => {
  it.each([
    { error: new DOMException("private URL and credential", "TimeoutError"), message: "Upstream read timed out." },
    { error: new DOMException("private URL and credential", "AbortError"), message: "Operation failed or was cancelled." },
    { error: Object.assign(new Error("private URL and credential"), { name: "TimeoutError" }), message: "Operation failed or was cancelled." },
  ])("reports $error.name safely as $message", async ({ error, message }) => {
    const client = await connect({ fallbackRoot: repo, remote: {
      allow: ["acme/widgets"], createClient: (signal) => githubReader("test-token", {
        signal, fetch: async () => { throw error; },
      }),
    } });
    const result = await call(client, MCP_TOOLS.workflowRunReport, { repo: "acme/widgets", runId: 2000, runAttempt: 1 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(text(result)).toContain(message);
    expect(text(result)).not.toMatch(/private|credential|test-token/);
  });

  it("are absent unless enabled", async () => {
    const client = await connect({ fallbackRoot: repo });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain(MCP_TOOLS.scanRepository);
    expect(names).not.toContain(MCP_TOOLS.workflowRunReport);
  });

  it("scan an allowed repository as a dry run", async () => {
    const api = github();
    const client = await connect({ fallbackRoot: repo, remote: { createClient: () => api, allow: ["acme/widgets"] } });
    const tool = (await client.listTools()).tools.find((entry) => entry.name === MCP_TOOLS.scanRepository);
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tool?.description).toContain("acme/widgets");
    const scan = await data(client, MCP_TOOLS.scanRepository, { repo: "ACME/widgets" });
    expect(scan).toMatchObject({ repo: "acme/widgets", status: "scanned", dryRun: true, counts: { error: 1 } });
    expect(writes(api)).toEqual([]);
  });

  it.each(["fail", "malformed"] as const)("drains %s scan siblings before the next MCP operation and cancels in-flight reads", async (mode) => {
    const api = remoteFixture({ files: fanoutFiles() });
    const client = await connect({ fallbackRoot: repo, remote: {
      allow: ["acme/widgets"], createClient: (signal) => githubReader("test-token", { signal, fetch: api.fetcher }),
    } });
    api.state.mode = mode;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await failure(client, MCP_TOOLS.scanRepository, { repo: "acme/widgets" })).not.toContain("deadline");
      expect(api.state).toMatchObject({ active: 0, started: attempt * 8, aborted: attempt * 7, maximumActive: 8 });
    }
    api.state.mode = "stall";
    const stop = new AbortController();
    const pending = client.callTool({ name: MCP_TOOLS.scanRepository, arguments: { repo: "acme/widgets" } }, { signal: stop.signal });
    const cancelled = expect(pending).rejects.toBeDefined();
    await expect.poll(() => api.state.active).toBe(8);
    stop.abort();
    await cancelled;
    await expect.poll(() => api.state.active).toBe(0);
    expect(api.state.aborted).toBe(29);
    api.state.mode = "normal";
    expect(await data(client, MCP_TOOLS.scanRepository, { repo: "acme/widgets" })).toMatchObject({ status: "scanned", analysisComplete: true });
  });

  it("does not treat an optional missing configuration file as a fatal child failure", async () => {
    const api = fakeApi({ repositoryMetadata: REPOSITORY, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } } });
    const client = await connect({ fallbackRoot: repo, remote: { allow: ["acme/widgets"], createClient: () => api } });
    expect(await data(client, MCP_TOOLS.scanRepository, { repo: "acme/widgets" })).toMatchObject({ status: "scanned", analysisComplete: true });
  });

  it.each([1, 105])("reports %i remote parse failures as bounded partial analysis, not a clean scan", async (count) => {
    const files = Object.fromEntries(Array.from({ length: count }, (_, index) =>
      [`.github/workflows/broken-${index}.yml`, "jobs: [unterminated\n"]));
    const api = remoteFixture({ files });
    const client = await connect({ fallbackRoot: repo, remote: {
      allow: ["acme/widgets"], createClient: (signal) => githubReader("test-token", { signal, fetch: api.fetcher }),
    } });
    const scan = await data<RemoteScanSummary>(client, MCP_TOOLS.scanRepository, { repo: "acme/widgets" });
    expect(scan).toMatchObject({
      status: "partial", analysisComplete: false, inventoryComplete: true, parseProblemCount: count,
      omittedParseProblems: Math.max(0, count - 100), counts: { error: 0 }, dryRun: true,
    });
    expect(scan.summary).toContain("Partial analysis");
    expect(scan.parseProblems).toHaveLength(Math.min(count, 100));
    expect(scan.parseProblems?.[0]).toMatchObject({ path: expect.stringContaining(".github/workflows/broken-"), line: expect.any(Number), message: expect.any(String), omittedCharacters: 0 });
  });

  it("exposes the actual five-page collector cap without authoritative-looking partial metrics", async () => {
    const api = remoteFixture({ jobs: cappedJobs() });
    const client = await connect({ fallbackRoot: repo, remote: {
      allow: ["acme/widgets"], createClient: (signal) => githubReader("test-token", { signal, fetch: api.fetcher }),
    } });
    const report = await data<RunReport>(client, MCP_TOOLS.workflowRunReport, { repo: "acme/widgets", runId: 2000, markdown: true });
    expect(api.state.jobPages).toEqual([1, 2, 3, 4, 5]);
    expect(report).toMatchObject({
      status: "processed", analysisStatus: "partial", provenance: { collector: "github-actions-rest", jobsComplete: false, definitionKnown: true },
      jobsTotal: 501, jobsFetched: 500, jobsAnalyzed: 500, jobsNotFetched: 1, jobPagesFetched: 5, omittedJobs: 400,
      run: { durationMs: null },
    });
    expect(report.jobs).toHaveLength(100);
    expect(report).not.toHaveProperty("criticalPath");
    expect(report).not.toHaveProperty("baseline");
    expect(report.jobs?.every((job) => job.onCriticalPath === undefined && job.baselineMs === undefined)).toBe(true);
    expect(report.markdown).toContain("Incomplete job telemetry");
    expect(report.markdown).toContain("400 fetched job(s) omitted from this response");
    expect(report.markdown).toContain("1 upstream job(s) not fetched");
    expect(report.markdown).not.toContain("Estimated critical path: 60000");
  });

  it.each(["missing", "inconsistent"] as const)("keeps %s upstream totals unknown rather than substituting fetched counts", async (mode) => {
    const jobs = cappedJobs().slice(0, 200);
    const api = remoteFixture({ jobs, total: (page) => mode === "missing" ? undefined : page === 1 ? 201 : 200 });
    const client = await connect({ fallbackRoot: repo, remote: {
      allow: ["acme/widgets"], createClient: (signal) => githubReader("test-token", { signal, fetch: api.fetcher }),
    } });
    const report = await data<RunReport>(client, MCP_TOOLS.workflowRunReport, { repo: "acme/widgets", runId: 2000, markdown: true });
    expect(report).toMatchObject({ jobsTotal: null, jobsNotFetched: null, jobsFetched: 200, omittedJobs: 100 });
    expect(report.markdown).toContain("upstream total: unknown");
    if (mode === "inconsistent") expect(report).toMatchObject({ analysisStatus: "partial", run: { durationMs: null } });
  });

  it("retrieves a historical attempt instead of silently substituting the latest retry", async () => {
    const api = fakeApi({
      repositoryMetadata: REPOSITORY, config: TIMEOUT_ONLY,
      refs: { main: { [WORKFLOW]: MISSING_TIMEOUT }, abc: { [WORKFLOW]: CI } },
      runs: { 2000: { ...RUN, run_attempt: 2 } }, runAttempts: { "2000:1": RUN }, jobs: { 2000: JOBS },
    });
    const client = await connect({ fallbackRoot: repo, remote: { allow: ["acme/widgets"], createClient: () => api } });
    const report = await data<RunReport>(client, MCP_TOOLS.workflowRunReport, { repo: "acme/widgets", runId: 2000, runAttempt: 1 });
    expect(report.run?.attempt).toBe(1);
    expect(callsTo(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}")).toEqual([]);
    expect(callsTo(api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs")[0]?.parameters.attempt_number).toBe(1);
    expect(writes(api)).toEqual([]);
  });

  it.each([{ ...RUN, run_attempt: 2 }, { ...RUN, id: 2001 }])("rejects historical attempt metadata that does not match the requested identity", async (run) => {
    const api = fakeApi({ repositoryMetadata: REPOSITORY, runAttempts: { "2000:1": run } });
    const client = await connect({ fallbackRoot: repo, remote: { allow: ["acme/widgets"], createClient: () => api } });
    expect(await failure(client, MCP_TOOLS.workflowRunReport, { repo: "acme/widgets", runId: 2000, runAttempt: 1 })).toContain("identity does not match");
    expect(writes(api)).toEqual([]);
  });

  it("reports final-page omissions and renders the selected job page rather than repeating page zero", async () => {
    const api = remoteFixture({ jobs: cappedJobs().slice(0, 205) });
    const client = await connect({ fallbackRoot: repo, remote: {
      allow: ["acme/widgets"], createClient: (signal) => githubReader("test-token", { signal, fetch: api.fetcher }),
    } });
    const report = await data<RunReport>(client, MCP_TOOLS.workflowRunReport, { repo: "acme/widgets", runId: 2000, jobOffset: 200, markdown: true });
    expect(report).toMatchObject({ jobsFetched: 205, omittedJobs: 200, pages: { jobs: { offset: 200, total: 205, nextOffset: null } } });
    expect(report.jobs).toHaveLength(5);
    expect(report.jobs?.[0]?.name).toBe("test (200)");
    expect(report.markdown).toContain("| test \\(200\\) |");
    const gantt = report.markdown?.split("```mermaid")[1];
    expect(gantt).toMatch(/test\s+200\s+:j0/);
    expect(gantt).not.toMatch(/test\s+0\s+:/);
  });

  it("report a workflow run's critical path without writing", async () => {
    const api = github();
    const client = await connect({ fallbackRoot: repo, remote: { createClient: () => api, allow: ["acme/widgets"] } });
    const report = await data<RunReport>(
      client,
      MCP_TOOLS.workflowRunReport,
      { repo: "acme/widgets", runId: 2000, markdown: true },
    );
    expect(report).toMatchObject({ status: "processed", dryRun: true, criticalPath: { jobKeys: ["build", "test"] } });
    expect(report.attribution).toMatchObject({
      coverage: { jobs: 2, jobsWithLogs: 0 },
      gaps: expect.arrayContaining([expect.objectContaining({ kind: "log-unavailable" })]),
    });
    expect(report.jobs).toHaveLength(2);
    expect(report.markdown).toContain("gantt");
    expect(report.markdown).toContain("### Bottleneck evidence");
    expect(report.markdown).toContain("Evidence coverage gaps");
    expect(writes(api)).toEqual([]);
    expect(await failure(client, MCP_TOOLS.workflowRunReport, { repo: "acme/widgets", runId: 9 })).toMatch(/Workflow run 9 was not found/);
  });

  it("escapes repository-derived report Markdown and restricts Gantt labels", async () => {
    const untrusted = "<script>alert(1)</script> [click](https://bad.example) | ```\n# injected";
    const api = fakeApi({
      repositoryMetadata: REPOSITORY, config: TIMEOUT_ONLY,
      refs: { abc: { [WORKFLOW]: CI } }, runs: { 2000: { ...RUN, name: untrusted } },
      jobs: { 2000: JOBS.map((job) => ({ ...job, name: untrusted })) },
    });
    const client = await connect({ fallbackRoot: repo, remote: { createClient: () => api, allow: ["acme/widgets"] } });
    const report = await data<{ markdown: string }>(client, MCP_TOOLS.workflowRunReport, { repo: "acme/widgets", runId: 2000, markdown: true });
    expect(report.markdown).toContain("&lt;script&gt;");
    expect(report.markdown).not.toContain("<script>");
    expect(report.markdown).not.toContain("[click](");
    expect(report.markdown).not.toContain("\n# injected");
    const diagram = report.markdown.split("```mermaid\n")[1]?.split("```")[0];
    expect(diagram).toBeDefined();
    expect(diagram).not.toMatch(/[<>{}()[\]|]/);
    expect(writes(api)).toEqual([]);
  });

  it("rejects mismatched run and repository identities before reading jobs", async () => {
    for (const run of [{ ...RUN, id: 2001 }, { ...RUN, repository: { id: 999 } }]) {
      const api = fakeApi({ repositoryMetadata: REPOSITORY, runs: { 2000: run } });
      const client = await connect({ fallbackRoot: repo, remote: { createClient: () => api, allow: ["acme/widgets"] } });
      expect(await failure(client, MCP_TOOLS.workflowRunReport, { repo: "acme/widgets", runId: 2000 })).toContain("identity");
      expect(api.calls.some((call) => call.route.endsWith("/jobs"))).toBe(false);
      expect(writes(api)).toEqual([]);
    }
  });

  it("refuse repositories outside the allowlist before calling GitHub", async () => {
    const api = github();
    const client = await connect({ fallbackRoot: repo, remote: { createClient: () => api, allow: ["acme/widgets"] } });
    expect(await failure(client, MCP_TOOLS.scanRepository, { repo: "evil/exfil" })).toMatch(/is not in the allowed repositories/);
    expect(await failure(client, MCP_TOOLS.scanRepository, { repo: "not a repo" })).toMatch(/is not an owner\/repo name/);
    expect(api.calls).toEqual([]);
  });

  it("refuse a repository that was renamed or transferred", async () => {
    const client = await connect({ fallbackRoot: repo, remote: { createClient: () => github({ id: 42, full_name: "other/widgets" }), allow: ["acme/widgets"] } });
    expect(await failure(client, MCP_TOOLS.scanRepository, { repo: "acme/widgets" })).toMatch(/now resolves to other\/widgets/);
  });

  it("reject an empty allowlist instead of trusting a workspace origin", () => {
    expect(() => createMcpServer({ fallbackRoot: repo, remote: { createClient: () => github(), allow: [] } })).toThrow("explicit repository allowlist");
  });
});
