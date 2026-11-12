import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import { run } from "../../src/cli/index.js";
import type { CliIO } from "../../src/cli/io.js";
import { diagnoseWorkflow, tabIndentRepair, type DoctorReport } from "../../src/doctor/doctor.js";
import type { GitHubClient } from "../../src/github/client.js";

const WORKFLOW = ".github/workflows/ci.yml";
const BROKEN = "name: CI\non: push\npermissions: read-all\njobs:\n\tcheck:\n\t\truns-on: ubuntu-24.04\n\t\ttimeout-minutes: 10\n\t\tsteps:\n\t\t\t- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n\t\t\t- run: echo ok\n";
const fixed = BROKEN.replace(/\t/g, "  ");
const REPO = { owner: "acme", repo: "service" };
const execute = promisify(execFile);
const BIN = resolve("src/bin.ts");
const LOADER = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
let root: string;
let sha: string;
let server: Server | undefined;
let evidence: ReturnType<typeof mockEvidence>;

function git(...args: string[]) {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

function mockEvidence() {
  const current = { id: 17, run_attempt: 2, head_sha: sha, path: WORKFLOW, status: "completed", conclusion: "failure", check_suite_id: 50 };
  const job = { id: 101, run_id: 17, run_attempt: 2, head_sha: sha, name: "private-name", status: "completed", conclusion: "failure", steps: [{ number: 3, name: "private-step", conclusion: "failure" }] };
  const calls: { route: string; args: Record<string, unknown> }[] = [];
  let log: string | undefined = `${WORKFLOW}: Tabs are not allowed as indentation\nprivate-secret $(touch PWNED); echo evil`;
  let jobs: unknown[] = [job];
  let total = 1;
  let annotations: unknown[] = [{ path: WORKFLOW, start_line: 5, annotation_level: "failure", message: "You have an error in your yaml syntax on line 5" }];
  const check = { id: 60, head_sha: sha, check_suite: { id: 50 }, app: { slug: "github-actions" }, status: "completed", conclusion: "failure" };
  const request = vi.fn(async (route: string, args: Record<string, unknown> = {}) => {
    calls.push({ route, args });
    if (route.endsWith("/runs")) return { status: 200, data: { total_count: 1, workflow_runs: [current] } };
    if (route.endsWith("/runs/{run_id}") || route.endsWith("/attempts/{attempt_number}")) return { status: 200, data: { ...current } };
    if (route.endsWith("/jobs")) {
      const page = Number(args.page);
      return { status: 200, data: { total_count: total, jobs: jobs.slice((page - 1) * 100, page * 100) } };
    }
    if (route.endsWith("/logs")) {
      if (log === undefined) throw Object.assign(new Error("expired secret"), { status: 410 });
      return { status: 200, data: log };
    }
    if (route.endsWith("/contents/{path}")) return { status: 200, data: { encoding: "base64", content: Buffer.from(BROKEN).toString("base64") } };
    if (route.endsWith("/check-runs")) return { status: 200, data: { total_count: 1, check_runs: [check] } };
    if (route.endsWith("/annotations")) return { status: 200, data: annotations };
    throw new Error(`Unexpected route ${route}`);
  });
  return {
    current, job, check, calls, request,
    client: { request } as GitHubClient,
    setLog(value: string | undefined) { log = value; },
    setJobs(value: unknown[], count = value.length) { jobs = value; total = count; },
    setAnnotations(value: unknown[]) { annotations = value; },
  };
}

describe("workflow doctor", () => {
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cicd-doctor-")));
  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  await writeFile(join(root, WORKFLOW), BROKEN);
  git("init", "--quiet");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Doctor fixture");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("-c", "core.hooksPath=", "commit", "--quiet", "-m", "Broken workflow fixture");
  git("remote", "add", "origin", "https://github.com/acme/service.git");
  sha = git("rev-parse", "HEAD");
  evidence = mockEvidence();
}, 30_000);

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) { await new Promise<void>((done) => server!.close(() => done())); server = undefined; }
  await rm(root, { force: true, recursive: true });
});

const diagnose = (observe = false) => diagnoseWorkflow(evidence.client, REPO, { cwd: root, observe, runId: 17, attempt: 2 });
const workflow = () => readFile(join(root, WORKFLOW), "utf8");

function cli() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { cwd: root, env: {}, github: () => evidence.client, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
  return { run: (...args: string[]) => run(args, io), out, err };
}

  it("reproduces a real YAML failure, repairs the right file by default and validates persisted bytes", async () => {
    expect(parseDocument(await workflow()).errors.some((error) => error.code === "TAB_AS_INDENT")).toBe(true);
    const c = cli();
    expect(await c.run("doctor", "--repo", "acme/service", "--run-id", "17", "--run-attempt", "2", "-f", "json")).toBe(0);
    const report = JSON.parse(c.out[0]!) as DoctorReport;
    expect(report).toMatchObject({ status: "repaired-locally", repair: { state: "applied" } });
    expect(await workflow()).toBe(fixed);
    expect(parseDocument(await workflow()).errors).toEqual([]);
    expect(git("diff", "--name-only")).toBe(WORKFLOW);
    expect(report.repair.validation).toContain("full CI has not run");
    expect(c.out.join("")).not.toMatch(/private-secret|private-name|private-step|touch PWNED/);
    expect(evidence.calls.every((call) => call.route.startsWith("GET "))).toBe(true);
  });

  it("repairs jobless invalid workflow startup using exact-commit check annotations", async () => {
    evidence.current.conclusion = "startup_failure";
    evidence.current.run_attempt = 1;
    evidence.setJobs([]);
    const report = await diagnoseWorkflow(evidence.client, REPO, { cwd: root, observe: false, runId: 17, attempt: 1 });
    expect(report.status).toBe("repaired-locally");
    expect(report.annotations).toEqual([{ checkId: 60, line: 5, diagnosis: "yaml-syntax" }]);
    expect(await workflow()).toBe(fixed);
  });

  it("observes without writes and returns nonzero for actionable but unrepaired failure", async () => {
    const before = git("status", "--porcelain");
    const c = cli();
    expect(await c.run("doctor", "--repo", "acme/service", "--run-id", "17", "--report-only", "-f", "json")).toBe(1);
    expect(JSON.parse(c.out[0]!)).toMatchObject({ status: "unrepaired", repair: { state: "not-attempted" } });
    expect(await workflow()).toBe(BROKEN);
    expect(git("status", "--porcelain")).toBe(before);
    expect(evidence.calls.some((call) => call.route.includes("/contents/"))).toBe(false);
  });

  it("pins exact attempts and collects all job pages, not only the first page", async () => {
    evidence.setJobs([
      ...Array.from({ length: 100 }, (_, i) => ({ ...evidence.job, id: i + 200, conclusion: "success" })),
      evidence.job,
    ]);
    const report = await diagnose(true);
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0]).toMatchObject({ id: 101, failedSteps: [3] });
    expect(evidence.calls.filter((call) => call.route.endsWith("/jobs")).map((call) => call.args.page)).toEqual([1, 2]);
    expect(evidence.calls.filter((call) => call.route.includes("/attempts/")).every((call) => call.args.attempt_number === 2)).toBe(true);
  });

  it.each(["dirty", "stale", "origin", "rerun", "upstream"])("declines %s checkout without overwriting", async (kind) => {
    if (kind === "dirty") await writeFile(join(root, "dirty.txt"), "keep");
    if (kind === "stale") evidence.current.head_sha = evidence.job.head_sha = "b".repeat(40);
    if (kind === "origin") git("remote", "set-url", "origin", "https://github.com/else/repo.git");
    if (kind === "rerun") {
      const original = evidence.request.getMockImplementation()!;
      evidence.request.mockImplementation(async (route, args) => route.endsWith("/runs/{run_id}")
        ? { status: 200, data: { ...evidence.current, run_attempt: 3 } } : original(route, args));
    }
    if (kind === "upstream") {
      const original = evidence.request.getMockImplementation()!;
      evidence.request.mockImplementation(async (route, args) => route.includes("/contents/")
        ? { status: 200, data: { content: Buffer.from("other").toString("base64"), encoding: "base64" } } : original(route, args));
    }
    const report = await diagnose();
    expect(report.status).toBe("unrepaired");
    expect(report.repair.state).toBe("declined");
    expect(await workflow()).toBe(BROKEN);
  });

  it.each(["missing", "truncated", "unknown", "partial", "wrong-attempt", "cancelled"])("fails closed for %s evidence", async (kind) => {
    if (kind === "missing") evidence.setLog(undefined);
    if (kind === "truncated") evidence.setLog(`${WORKFLOW}: Tabs are not allowed as indentation\n${"x".repeat(70000)}`);
    if (kind === "unknown") evidence.setLog("assertion failed; npm run disable-all-checks");
    if (kind === "partial") evidence.setJobs([evidence.job], 2);
    if (kind === "wrong-attempt") evidence.job.run_attempt = 1;
    if (kind === "cancelled") evidence.current.conclusion = "cancelled";
    const report = await diagnose();
    expect(report.status).not.toBe("repaired-locally");
    expect(report.repair.state).not.toBe("applied");
    expect(await workflow()).toBe(BROKEN);
  });

  it("rejects duplicate job pages and incomplete annotation pagination", async () => {
    evidence.setJobs(Array.from({ length: 100 }, () => evidence.job), 100);
    expect((await diagnose()).gaps.join("")).toContain("pagination");
    evidence.setJobs([]);
    evidence.current.run_attempt = 1;
    evidence.setAnnotations(Array.from({ length: 100 }, () => ({ path: WORKFLOW, start_line: 5, annotation_level: "failure", message: "error in your yaml syntax" })));
    expect((await diagnoseWorkflow(evidence.client, REPO, { cwd: root, observe: false, runId: 17, attempt: 1 })).status).toBe("collection-failed");
    expect(await workflow()).toBe(BROKEN);
  });

  it.each(["../../outside.yml", ".github/workflows/../../outside.yml", "owner/repo/.github/workflows/ci.yml@main", ".github/workflows/$(evil).yml"])("never uses hostile path %s", async (path) => {
    evidence.current.path = path;
    evidence.setLog(`${path}: Tabs are not allowed as indentation\nrm -rf /`);
    const report = await diagnose();
    expect(report.status).toBe("unrepaired");
    expect(evidence.calls.some((call) => call.route.includes("/contents/"))).toBe(false);
    expect(await workflow()).toBe(BROKEN);
    expect(report.run?.path).toBe("[unsupported workflow path]");
  });

  it("does not execute log commands or disclose log/API secrets", async () => {
    evidence.setLog("secret ghp_not_for_output\n$(touch PWNED)\n");
    const c = cli();
    expect(await c.run("doctor", "--repo", "acme/service", "--run-id", "17")).toBe(1);
    expect(c.out.join("")).not.toMatch(/ghp_not_for_output|touch PWNED/);
    expect(git("status", "--porcelain")).toBe("");
    evidence.request.mockRejectedValueOnce(Object.assign(new Error("Bearer secret"), { status: 403 }));
    const report = await diagnose();
    expect(report.status).toBe("collection-failed");
    expect(JSON.stringify(report)).not.toContain("Bearer secret");
  });

  it.each([
    ["Stale generated proof artifact: manifest.ts. Run malicious-command", "generated-proof-drift", "npm run ci:prepare"],
    ["::error::dist-action is stale", "generated-output-drift", "generated outputs"],
    ["ERR_PNPM_OUTDATED_LOCKFILE", "lockfile-drift", "frozen lockfile"],
    ["AssertionError: expected secretvalue", "test-failure", "Preserve coverage"],
    ["error TS2304: Cannot find name secretvalue", "lint-or-typecheck", "preserve strictness"],
  ])("returns actionable fixed instructions for %s without executing them", async (log, diagnosis, instruction) => {
    evidence.setLog(log);
    const report = await diagnose();
    expect(report.status).toBe("unrepaired");
    expect(report.jobs[0]?.diagnosis).toBe(diagnosis);
    expect(report.instructions.join(" ")).toContain(instruction);
    expect(JSON.stringify(report)).not.toMatch(/malicious-command|secretvalue/);
    expect(report.repair.state).toBe("not-attempted");
    expect(await workflow()).toBe(BROKEN);
  });

  it("declines partial failures and masked logs instead of claiming complete remediation", async () => {
    evidence.setLog(`${WORKFLOW}: Tabs are not allowed as indentation\nmasked ***`);
    expect((await diagnose()).jobs[0]?.log).toBe("redacted");
    evidence.setLog(`${WORKFLOW}: Tabs are not allowed as indentation`);
    evidence.job.steps.push({ number: 4, name: "unrelated failure", conclusion: "failure" });
    expect((await diagnose()).gaps.join("")).toContain("multiple failed steps");
    expect(await workflow()).toBe(BROKEN);
  });

  it("reports uncertain local state when validation fails after a write", async () => {
    const handle = await fs.open(join(root, WORKFLOW), "r");
    const prototype = Object.getPrototypeOf(handle) as { sync(): Promise<void> };
    await handle.close();
    vi.spyOn(prototype, "sync").mockRejectedValue(new Error("secret filesystem details"));
    const report = await diagnose();
    expect(report).toMatchObject({ status: "unrepaired", repair: { state: "local-state-unknown" } });
    expect(report.repair.reason).toContain("checkout may be modified");
    expect(JSON.stringify(report)).not.toContain("secret filesystem details");
    expect(await workflow()).toBe(fixed);
  });

  it("detects dirty-file races and invalid UTF-8 before any write", async () => {
    const original = evidence.request.getMockImplementation()!;
    evidence.request.mockImplementation(async (route, args) => {
      if (route.includes("/contents/")) await writeFile(join(root, WORKFLOW), `${BROKEN}# user edit\n`);
      return original(route, args);
    });
    const raced = await diagnose();
    expect(raced.repair.state).toBe("declined");
    expect(await workflow()).toBe(`${BROKEN}# user edit\n`);
    const invalid = Buffer.concat([Buffer.from(BROKEN), Buffer.from([0xff])]);
    await writeFile(join(root, WORKFLOW), invalid);
    git("add", ".");
    git("-c", "core.hooksPath=", "commit", "--quiet", "-m", "Invalid UTF-8 fixture");
    sha = git("rev-parse", "HEAD");
    evidence = mockEvidence();
    expect((await diagnose()).repair.state).toBe("declined");
    expect(await readFile(join(root, WORKFLOW))).toEqual(invalid);
  });

  it("declines untrusted symlink and hardlink paths", async () => {
    const external = join(root, "external.yml");
    await writeFile(external, BROKEN);
    await rm(join(root, WORKFLOW));
    try { await symlink(external, join(root, WORKFLOW)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      // Windows without developer-mode symlink permission still exercises tracked symlink mode.
      git("update-index", "--cacheinfo", `120000,${git("rev-parse", `HEAD:${WORKFLOW}`)},${WORKFLOW}`);
    }
    const report = await diagnose();
    expect(report.status).not.toBe("repaired-locally");
    expect(await readFile(external, "utf8")).toBe(BROKEN);
  });

  it("declines a clean tracked hardlink without modifying either path", async () => {
    await fs.link(join(root, WORKFLOW), join(root, "hardlink.yml"));
    git("add", ".");
    git("-c", "core.hooksPath=", "commit", "--quiet", "-m", "Hardlink fixture");
    evidence.current.head_sha = evidence.job.head_sha = git("rev-parse", "HEAD");
    const report = await diagnose();
    expect(report.repair.state).toBe("declined");
    expect(report.repair.reason).toContain("hard-linked");
    expect(await workflow()).toBe(BROKEN);
    expect(await readFile(join(root, "hardlink.yml"), "utf8")).toBe(BROKEN);
  });

  it("selects startup/timeouts as failures and paginates latest completed runs", async () => {
    const original = evidence.request.getMockImplementation()!;
    evidence.request.mockImplementation(async (route, args = {}) => {
      if (route.endsWith("/runs")) {
        return { status: 200, data: { total_count: 101, workflow_runs: Number(args.page) === 1
          ? Array.from({ length: 100 }, (_, i) => ({ ...evidence.current, id: i + 200, conclusion: "success" }))
          : [{ ...evidence.current, conclusion: "timed_out" }] } };
      }
      return original(route, args);
    });
    const report = await diagnoseWorkflow(evidence.client, REPO, { cwd: root, observe: true });
    expect(report.run?.id).toBe(17);
    expect(evidence.calls.filter((call) => call.route.endsWith("/jobs"))[0]?.args.attempt_number).toBe(2);
  });

  it("reports no matching failed runs only after a complete empty selection", async () => {
    evidence.request.mockResolvedValueOnce({ status: 200, data: { total_count: 0, workflow_runs: [] } });
    const c = cli();
    expect(await c.run("doctor", "--repo", "acme/service", "-f", "json")).toBe(0);
    expect(JSON.parse(c.out[0]!)).toMatchObject({ status: "no-failed-run" });
    expect(await workflow()).toBe(BROKEN);
  });

  it("handles check identity mismatch and unsupported failure annotations honestly", async () => {
    evidence.setJobs([]);
    evidence.current.run_attempt = 1;
    evidence.check.head_sha = "b".repeat(40);
    const collect = () => diagnoseWorkflow(evidence.client, REPO, { cwd: root, observe: false, runId: 17, attempt: 1 });
    expect((await collect()).status).toBe("collection-failed");
    evidence.check.head_sha = sha;
    evidence.setAnnotations([{ path: WORKFLOW, start_line: 5, annotation_level: "failure", message: "permission denied" }]);
    const report = await collect();
    expect(report.status).toBe("unrepaired");
    expect(report.annotations[0]?.diagnosis).toBe("unknown");
  });

  it("does not attribute unnumbered check annotations to rerun attempts", async () => {
    evidence.setJobs([]);
    const report = await diagnose();
    expect(report.status).toBe("unrepaired");
    expect(report.annotations).toEqual([]);
    expect(evidence.calls.some((call) => call.route.endsWith("/check-runs"))).toBe(false);
  });

  it("provides real subprocess help, usage, JSON and unresolved exit status", async () => {
    const help = await execute(process.execPath, ["--import", LOADER, BIN, "doctor", "--help"], { cwd: root, env: process.env });
    expect(help.stdout).toContain("--report-only");
    await expect(execute(process.execPath, ["--import", LOADER, BIN, "doctor", "--run-attempt", "2"], { cwd: root, env: process.env }))
      .rejects.toMatchObject({ code: 2 });
    let startup = false;
    server = createServer((request, response) => {
      const path = new URL(request.url!, "http://localhost").pathname;
      response.setHeader("content-type", "application/json");
      if (path.endsWith("/attempts/2") || path.endsWith("/attempts/1") || path.endsWith("/runs/17")) response.end(JSON.stringify(evidence.current));
      else if (path.endsWith("/jobs")) response.end(JSON.stringify({ total_count: startup ? 0 : 1, jobs: startup ? [] : [evidence.job] }));
      else if (path.endsWith("/logs")) response.end(JSON.stringify("private token\nassertion failed"));
      else if (path.endsWith("/check-runs")) response.end(JSON.stringify({ total_count: 1, check_runs: [evidence.check] }));
      else if (path.endsWith("/annotations")) response.end(JSON.stringify([{ path: WORKFLOW, start_line: 5, annotation_level: "failure", message: "You have an error in your yaml syntax on line 5" }]));
      else if (path.includes("/contents/")) response.end(JSON.stringify({ encoding: "base64", content: Buffer.from(BROKEN).toString("base64") }));
      else { response.statusCode = 404; response.end("{}"); }
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    try {
      await execute(process.execPath, ["--import", LOADER, BIN, "doctor", "--repo", "acme/service", "--run-id", "17", "--run-attempt", "2", "--report-only", "-f", "json"], {
        cwd: root, env: { ...process.env, GITHUB_API_URL: `http://127.0.0.1:${address.port}` },
      });
      throw new Error("Expected unresolved exit code");
    } catch (error) {
      const failed = error as { code: number; stdout: string };
      expect(failed.code).toBe(1);
      expect(JSON.parse(failed.stdout)).toMatchObject({ status: "unrepaired", run: { id: 17, run_attempt: 2 } });
      expect(failed.stdout).not.toContain("private token");
    }
    startup = true;
    evidence.current.run_attempt = 1;
    evidence.current.conclusion = "startup_failure";
    git("remote", "set-url", "origin", "https://127.0.0.1/acme/service.git");
    const repaired = await execute(process.execPath, ["--import", LOADER, BIN, "doctor", "--repo", "acme/service", "--run-id", "17", "--run-attempt", "1", "-f", "json"], {
      cwd: root, env: { ...process.env, GITHUB_API_URL: `http://127.0.0.1:${address.port}` },
    });
    expect(JSON.parse(repaired.stdout)).toMatchObject({ status: "repaired-locally", repair: { state: "applied" } });
    expect(await workflow()).toBe(fixed);
  }, 60_000);
});

describe("tab repair boundaries", () => {
  it.each([
    fixed, BROKEN.replace("\tcheck:", "  \tcheck:"), BROKEN.replace("echo ok", "|2-\n\t\t\t\tignored"),
    BROKEN.replace("echo ok", "'first\n\t\t\t\tkey: second'"),
    BROKEN.replace("echo ok", "*alias"), BROKEN.replace("steps:", "invalid:"),
    BROKEN.replace("echo ok", "[broken"), BROKEN.replace("timeout-minutes: 10", "timeout-minutes: 10\n\t\trun: bypass"),
  ])("declines ambiguous or unsupported YAML %s", (source) => {
    expect(tabIndentRepair(source)).toBeUndefined();
  });
});
