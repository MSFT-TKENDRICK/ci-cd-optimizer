import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/index.js";
import type { CliIO } from "../../src/cli/io.js";
import { FileTelemetryStore } from "../../src/telemetry/store.js";
import { decodeBenchmark } from "../../src/telemetry/benchmark.js";
import { snapshot, stable } from "../alerts/fixtures.js";
import { callsTo, CLEAN, fakeApi, MISSING_TIMEOUT, TIMEOUT_ONLY, WORKFLOW, writes, type FakeApi } from "../service/api.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cicd-cli-service-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function cli(client: FakeApi, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    cwd: root,
    env: { GITHUB_REPOSITORY: "acme/widgets", ...env },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    github: () => client,
    now: () => new Date("2026-11-01T00:11:00Z"),
  };
  return {
    run: (...argv: string[]) => run(argv, io),
    json: () => JSON.parse(out.join("\n")),
    get stdout() {
      return out.join("\n");
    },
    get stderr() {
      return err.join("\n");
    },
  };
}

describe("scan command", () => {
  it("includes opt-in knowledge in JSON without writing to a database or GitHub", async () => {
    const client = fakeApi({
      config: TIMEOUT_ONLY, commitSha: "a".repeat(40),
      repositoryMetadata: { id: 42, html_url: "https://github.com/acme/widgets", name: "widgets", owner: { login: "acme" } },
      refs: { main: { "package.json": '{"name":"root","devDependencies":{"turbo":"^2.0.0"}}' } },
    });
    const session = cli(client);
    expect(await session.run("scan", "--knowledge", "--dry-run", "--format", "json")).toBe(0);
    expect(session.json().knowledge).toMatchObject({ persistence: "dry-run", snapshot: {
      repository: { repositoryId: "42", host: "https://github.com" },
      technologies: [expect.objectContaining({ technology: "turborepo", basis: "dependency" })],
    } });
    expect(writes(client)).toEqual([]);
  });

  it("prints help", async () => {
    const session = cli(fakeApi());
    expect(await session.run("scan", "--help")).toBe(0);
    expect(session.stdout).toContain("Usage: ci-cd-optimizer scan");
    expect(await session.run("help", "scan")).toBe(0);
  });

  it("summarizes findings without writing in dry-run mode", async () => {
    const client = fakeApi({ config: `${TIMEOUT_ONLY}issues:\n  enabled: true\n`, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } } });
    const session = cli(client);
    expect(await session.run("scan", "--dry-run", "--upload-sarif")).toBe(0);
    expect(session.stdout).toBe("acme/widgets@main: 1 error(s), 0 warning(s), 0 info · SARIF skipped · issues: 1 create");
    expect(writes(client)).toEqual([]);
  });

  it("syncs issues and uploads SARIF, reporting them as JSON", async () => {
    const client = fakeApi({ config: `${TIMEOUT_ONLY}issues:\n  enabled: true\n`, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } } });
    const session = cli(client);
    expect(await session.run("scan", "--repo", "acme/widgets", "--upload-sarif", "--no-fixes", "-f", "json")).toBe(0);
    const output = session.json();
    expect(output).toMatchObject({ repo: "acme/widgets", ref: "main", sha: "main-sha", status: "scanned", sarif: { status: "uploaded" } });
    expect(output.diagnostics.map((d: { ruleId: string }) => d.ruleId)).toEqual(["workflow/job-timeout"]);
    expect(output.issues.actions).toEqual([expect.objectContaining({ type: "create", fingerprint: "rule:workflow/job-timeout" })]);
    expect(output.issues.applied).toEqual([{ type: "create", number: 101 }]);
    expect(callsTo(client, "POST /repos/{owner}/{repo}/code-scanning/sarifs")).toHaveLength(1);
    expect(output.fixes).toBeUndefined();
  });

  it("skips issues with --no-issues and writes output to a file", async () => {
    const client = fakeApi({ config: `${TIMEOUT_ONLY}issues:\n  enabled: true\n`, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } } });
    const session = cli(client);
    expect(await session.run("scan", "--no-issues", "-o", "out/scan.txt")).toBe(0);
    expect(await readFile(join(root, "out", "scan.txt"), "utf8")).toBe("acme/widgets@main: 1 error(s), 0 warning(s), 0 info\n");
    expect(writes(client)).toEqual([]);
  });

  it("fails on findings at the requested severity", async () => {
    const failing = cli(fakeApi({ config: TIMEOUT_ONLY, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } } }));
    expect(await failing.run("scan", "--fail-on", "error")).toBe(1);
    const clean = cli(fakeApi({ config: TIMEOUT_ONLY, refs: { main: { [WORKFLOW]: CLEAN } } }));
    expect(await clean.run("scan", "--fail-on", "error")).toBe(0);
  });

  it("exits 2 for invalid repository configuration and bad arguments", async () => {
    const invalid = cli(fakeApi({ config: "rules:\n  workflow/job-timout: error\n", refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } } }));
    expect(await invalid.run("scan")).toBe(2);
    expect(invalid.stdout).toContain("invalid configuration");

    const session = cli(fakeApi(), { GITHUB_REPOSITORY: "" });
    expect(await session.run("scan")).toBe(2);
    expect(await session.run("scan", "--repo", "acme/widgets", "--fail-on", "sometimes")).toBe(2);
    expect(await session.run("scan", "--repo", "acme/widgets", "-f", "sarif")).toBe(2);
    expect(session.stderr).toContain("--fail-on must be");
  });
});

const workflowFile = "name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps: [{ run: make }]\n  test:\n    needs: build\n    runs-on: ubuntu-24.04\n    steps: [{ run: make test }]\n";
const at = (time: string) => `2026-11-01T00:${time}Z`;
const workflowRun = {
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
  created_at: "2026-11-01T00:00:00Z",
  run_started_at: "2026-11-01T00:00:05Z",
  updated_at: "2026-11-01T00:10:00Z",
  html_url: "https://github.com/acme/widgets/actions/runs/2000",
};
const jobs = [
  { id: 1, name: "build", conclusion: "success", labels: ["ubuntu-24.04"], created_at: at("00:05"), started_at: at("00:10"), completed_at: at("02:10"), steps: [] },
  { id: 2, name: "test", conclusion: "success", labels: ["ubuntu-24.04"], created_at: at("02:10"), started_at: at("02:15"), completed_at: at("10:05"), steps: [] },
];
const telemetryApi = (overrides: Parameters<typeof fakeApi>[0] = {}) =>
  fakeApi({ refs: { abc: { ".github/workflows/ci.yml": workflowFile } }, jobs: { 2000: jobs }, runs: { 2000: workflowRun }, ...overrides });

/** A JSON Lines store holding twelve stable ~300 s runs of the same workflow on main. */
async function seededStore(): Promise<string> {
  const path = join(root, "telemetry", "snapshots.jsonl");
  const store = new FileTelemetryStore(path);
  for (const [index, seconds] of stable(12, 300).entries()) {
    await store.save(snapshot(1000 + index, Math.round(seconds), [["build", 100], ["test", Math.round(seconds) - 110]]));
  }
  return path;
}

const lines = async (path: string) => (await readFile(path, "utf8")).split("\n").filter(Boolean);

describe("telemetry command", () => {
  it("benchmarks the completion event's historical attempt when a newer retry has started", async () => {
    const sha = "a".repeat(40);
    const historical = { ...workflowRun, head_sha: sha };
    const client = telemetryApi({
      repositoryMetadata: { id: 42, full_name: "acme/widgets", owner: { login: "acme" }, name: "widgets" },
      refs: { [sha]: { ".github/workflows/ci.yml": workflowFile } },
      runs: { 2000: { ...historical, run_attempt: 2, status: "in_progress", conclusion: null } },
      runAttempts: { "2000:1": historical },
    });
    const session = cli(client);
    expect(await session.run("telemetry", "--run-id", "2000", "--run-attempt", "1", "--broadcast", "--dry-run")).toBe(0);
    const benchmark = decodeBenchmark(session.stdout.split("\n").map((line) => `${at("11:00")} ${line}`).join("\n"));
    expect(benchmark).toMatchObject({ runId: 2000, runAttempt: 1, conclusion: "success" });
    expect(callsTo(client, "GET /repos/{owner}/{repo}/actions/runs/{run_id}")).toEqual([]);
    expect(callsTo(client, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs")[0]?.parameters.attempt_number).toBe(1);
    expect(writes(client)).toEqual([]);
  });

  it("rejects invalid attempt selectors and mismatched metadata before writing", async () => {
    const client = telemetryApi({ runAttempts: { "2000:1": { ...workflowRun, run_attempt: 2 } } });
    const session = cli(client);
    for (const attempt of ["0", "-1", "1.5", "bad", "1"]) {
      expect(await session.run("telemetry", "--run-id", "2000", "--run-attempt", attempt)).toBe(2);
    }
    expect(session.stderr).toContain("identity does not match");
    expect(writes(client)).toEqual([]);
  });

  it("broadcasts a verified benchmark without GitHub writes, including cancelled empty runs", async () => {
    const sha = "a".repeat(40);
    for (const empty of [false, true]) {
      const client = telemetryApi({
        repositoryMetadata: { id: 42, full_name: "acme/widgets", owner: { login: "acme" }, name: "widgets" },
        refs: { [sha]: { ".github/workflows/ci.yml": workflowFile } },
        jobs: { 2000: empty ? [] : jobs },
        runs: { 2000: { ...workflowRun, head_sha: sha, conclusion: empty ? "cancelled" : "success" } },
      });
      const session = cli(client);
      expect(await session.run("telemetry", "--run-id", "2000", "--broadcast", "--dry-run")).toBe(0);
      const benchmark = decodeBenchmark(session.stdout.split("\n").map((line) => `${at("11:00")} ${line}`).join("\n"));
      expect(benchmark).toMatchObject({ repositoryId: 42, runId: 2000, headSha: sha });
      expect(benchmark.analysisStatus).not.toBe("complete");
      if (empty) expect(benchmark.gaps.length).toBeGreaterThan(0);
      else expect(benchmark.metrics?.observedRunnerMs).toBeGreaterThan(0);
      expect(writes(client)).toEqual([]);
    }
  });

  it("prints requested source context even when a cancelled run has no completed jobs", async () => {
    const sha = "a".repeat(40);
    const client = telemetryApi({
      repositoryMetadata: { id: 42, html_url: "https://github.com/acme/widgets", owner: { login: "acme" }, name: "widgets" },
      refs: { [sha]: { "package.json": "{}" } }, jobs: { 2000: [] },
      runs: { 2000: { ...workflowRun, head_sha: sha, conclusion: "cancelled" } },
    });
    const session = cli(client);
    expect(await session.run("telemetry", "--run-id", "2000", "--knowledge", "--dry-run")).toBe(0);
    expect(session.stdout).toContain("The run has no completed jobs");
    expect(session.stdout).toContain("Project declaration context");
    expect(session.stdout).toContain("preview only");
    expect(writes(client)).toEqual([]);
  });

  it("previews run-linked source context without knowledge database writes", async () => {
    const sha = "a".repeat(40);
    const client = telemetryApi({
      config: "durations:\n  minSamples: 2\n  objectives:\n    - workflow: .github/workflows/ci.yml\n      job: build\n      maxDurationMs: 120000\n",
      repositoryMetadata: { id: 42, html_url: "https://github.com/acme/widgets", owner: { login: "acme" }, name: "widgets" },
      refs: { [sha]: { ".github/workflows/ci.yml": workflowFile, "package.json": '{"devDependencies":{"turbo":"2"}}' } },
      runs: { 2000: { ...workflowRun, head_sha: sha } },
    });
    const session = cli(client);
    expect(await session.run("telemetry", "--run-id", "2000", "--knowledge", "--dry-run", "--format", "json")).toBe(0);
    expect(session.json().knowledge).toMatchObject({
      persistence: "preview", observation: { run: { headSha: sha }, source: { status: "linked" } },
      project: { revision: sha, technologies: [expect.objectContaining({ technology: "turborepo" })] },
      durations: {
        status: "insufficient-history", samples: [],
        jobs: expect.arrayContaining([expect.objectContaining({
          key: "build", metric: expect.objectContaining({ objective: expect.objectContaining({ maxDurationMs: 120000, currentStatus: "within-budget" }) }),
        })]),
      },
    });
    expect(session.json().knowledge).not.toHaveProperty("comparison");
    expect(writes(client)).toEqual([]);
  });

  it("requires a valid run id", async () => {
    const session = cli(telemetryApi());
    expect(await session.run("telemetry")).toBe(2);
    expect(await session.run("telemetry", "--run-id", "abc")).toBe(2);
    expect(await session.run("telemetry", "--run-id", "404")).toBe(2);
    expect(session.stderr).toContain("Workflow run 404 not found in acme/widgets");
  });

  it("reports against the persisted history, appends the step summary, and opens a spike alert", async () => {
    const storePath = await seededStore();
    const summaryPath = join(root, "summary.md");
    await writeFile(summaryPath, "# Earlier step\n", "utf8");
    const client = telemetryApi();
    const session = cli(client, { GITHUB_STEP_SUMMARY: summaryPath });

    expect(await session.run("telemetry", "--run-id", "2000", "--store", "telemetry/snapshots.jsonl")).toBe(0);
    expect(session.stdout).toContain("```mermaid\ngantt");
    expect(session.stdout).toContain("median of 12 prior successful runs");
    const summary = await readFile(summaryPath, "utf8");
    expect(summary.startsWith("# Earlier step\n## CI performance snapshot")).toBe(true);
    expect(await lines(storePath)).toHaveLength(13);
    expect(callsTo(client, "POST /repos/{owner}/{repo}/issues").length).toBeGreaterThan(0);
    expect(callsTo(client, "POST /repos/{owner}/{repo}/check-runs")).toHaveLength(0);
    // The store had enough history, so nothing was backfilled from the Actions API.
    expect(callsTo(client, "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs")).toHaveLength(0);
  });

  it("writes nothing in dry-run mode and reports JSON", async () => {
    const storePath = await seededStore();
    const client = telemetryApi();
    const session = cli(client);
    expect(await session.run("telemetry", "--run-id", "2000", "--store", storePath, "--dry-run", "--check", "-f", "json")).toBe(0);
    const output = session.json();
    expect(output).toMatchObject({ repo: "acme/widgets", status: "processed", samples: 12, snapshot: { runId: 2000 } });
    expect(output.attribution).toMatchObject({ coverage: { jobs: 2, jobsWithLogs: 0 }, gaps: expect.arrayContaining([expect.objectContaining({ kind: "log-unavailable" })]) });
    expect(output.alerts.detected.length).toBeGreaterThan(0);
    expect(output.alerts.applied).toEqual([]);
    expect(writes(client)).toEqual([]);
    expect(await lines(storePath)).toHaveLength(12);
  });

  it("publishes a check run with --check and skips alerts with --no-alerts", async () => {
    const client = telemetryApi();
    const session = cli(client);
    expect(await session.run("telemetry", "--run-id", "2000", "--check", "--no-alerts", "--summary", "-")).toBe(0);
    expect(callsTo(client, "POST /repos/{owner}/{repo}/check-runs")).toEqual([
      expect.objectContaining({ parameters: expect.objectContaining({ name: "CI/CD Telemetry (CI)", head_sha: "abc", conclusion: "neutral" }) }),
    ]);
    expect(callsTo(client, "POST /repos/{owner}/{repo}/issues")).toHaveLength(0);
  });

  it("explains skipped runs", async () => {
    const session = cli(telemetryApi({ runs: { 2000: { ...workflowRun, status: "in_progress" } } }));
    expect(await session.run("telemetry", "--run-id", "2000")).toBe(0);
    expect(session.stdout).toBe("Telemetry skipped for run 2000: Run is in_progress.");
  });
});

describe("FileTelemetryStore", () => {
  it("round-trips attempts, prunes whole runs per workflow and branch, and ignores corrupt lines", async () => {
    const path = join(root, "store.jsonl");
    await writeFile(path, "not json\n", "utf8");
    const store = new FileTelemetryStore(path, 3);
    await store.initialize();
    for (let index = 0; index < 5; index += 1) await store.save(snapshot(1000 + index, 300, [["build", 100]]));
    await store.save({ ...snapshot(1004, 400, [["build", 200]]), runAttempt: 2 });
    await store.save({ ...snapshot(1005, 300, [["build", 100]]), branch: "release" });

    const reopened = new FileTelemetryStore(path, 3);
    const main = await reopened.history({ owner: "acme", repo: "widgets", workflowId: 7, branch: "main", limit: 10 });
    expect(main.map((item) => item.runId)).toEqual([1002, 1003, 1004]);
    expect(main.at(-1)).toMatchObject({ runAttempt: 2, durationMs: 400_000 });
    expect((await reopened.history({ owner: "acme", repo: "widgets", workflowId: 7, limit: 10 })).map((item) => item.runId)).toEqual([1002, 1003, 1004, 1005]);
    expect(await lines(path)).toHaveLength(5);
  });
});
