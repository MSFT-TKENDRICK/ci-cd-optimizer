import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer, MCP_TOOLS, type McpServerOptions } from "../../src/agents/mcp.js";
import type { LintSummary } from "../../src/agents/workspace.js";
import type { WorkflowRunPayload } from "../../src/telemetry/snapshot.js";
import { PROJECT_YAML } from "../review/fixtures.js";
import { fakeApi, TIMEOUT_ONLY, writes } from "../service/api.js";
import { MISSING_TIMEOUT, tempDirs, WORKFLOW, write } from "./helpers.js";

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
  it("are absent unless enabled", async () => {
    const client = await connect({ fallbackRoot: repo });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain(MCP_TOOLS.scanRepository);
    expect(names).not.toContain(MCP_TOOLS.workflowRunReport);
  });

  it("scan an allowed repository as a dry run", async () => {
    const api = github();
    const client = await connect({ fallbackRoot: repo, remote: { client: api, allow: ["acme/widgets"] } });
    const tool = (await client.listTools()).tools.find((entry) => entry.name === MCP_TOOLS.scanRepository);
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tool?.description).toContain("acme/widgets");
    const scan = await data(client, MCP_TOOLS.scanRepository, { repo: "ACME/widgets" });
    expect(scan).toMatchObject({ repo: "acme/widgets", status: "scanned", dryRun: true, counts: { error: 1 } });
    expect(writes(api)).toEqual([]);
  });

  it("report a workflow run's critical path without writing", async () => {
    const api = github();
    const client = await connect({ fallbackRoot: repo, remote: { client: api, allow: ["acme/widgets"] } });
    const report = await data<{ status: string; criticalPath: { jobKeys: string[] }; jobs: unknown[]; markdown: string; dryRun: boolean }>(
      client,
      MCP_TOOLS.workflowRunReport,
      { repo: "acme/widgets", runId: 2000, markdown: true },
    );
    expect(report).toMatchObject({ status: "processed", dryRun: true, criticalPath: { jobKeys: ["build", "test"] } });
    expect(report.jobs).toHaveLength(2);
    expect(report.markdown).toContain("gantt");
    expect(writes(api)).toEqual([]);
    expect(await failure(client, MCP_TOOLS.workflowRunReport, { repo: "acme/widgets", runId: 9 })).toMatch(/Workflow run 9 was not found/);
  });

  it("refuse repositories outside the allowlist before calling GitHub", async () => {
    const api = github();
    const client = await connect({ fallbackRoot: repo, remote: { client: api, allow: ["acme/widgets"] } });
    expect(await failure(client, MCP_TOOLS.scanRepository, { repo: "evil/exfil" })).toMatch(/is not in the allowed repositories/);
    expect(await failure(client, MCP_TOOLS.scanRepository, { repo: "not a repo" })).toMatch(/is not an owner\/repo name/);
    expect(api.calls).toEqual([]);
  });

  it("refuse a repository that was renamed or transferred", async () => {
    const client = await connect({ fallbackRoot: repo, remote: { client: github({ id: 42, full_name: "other/widgets" }), allow: ["acme/widgets"] } });
    expect(await failure(client, MCP_TOOLS.scanRepository, { repo: "acme/widgets" })).toMatch(/now resolves to other\/widgets/);
  });

  it("allow only the workspace's origin remote when no allowlist is given", async () => {
    const exec = promisify(execFile);
    await exec("git", ["init", "-q", repo]);
    await exec("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    const client = await connect({ fallbackRoot: repo, remote: { client: github(), serverUrl: "https://github.com" } });
    expect(await data(client, MCP_TOOLS.scanRepository, { repo: "acme/widgets" })).toMatchObject({ status: "scanned" });
    expect(await failure(client, MCP_TOOLS.scanRepository, { repo: "acme/gadgets" })).toMatch(/is not in the allowed repositories \(acme\/widgets\)/);
    const bare = await connect({ fallbackRoot: other, remote: { client: github() } });
    expect(await failure(bare, MCP_TOOLS.scanRepository, { repo: "acme/widgets" })).toMatch(/no GitHub origin remote/);
  });
});
