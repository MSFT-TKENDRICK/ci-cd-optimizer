import { describe, expect, it } from "vitest";
import {
  buildWorkflowSnapshot,
  loadRunHistory,
  matchJobKey,
  parseJobDefinitions,
  snapshotFromRun,
  workflowPath,
  type ApiJob,
  type WorkflowRunPayload,
} from "../../src/telemetry/snapshot.js";
import { fakeClient, httpError, repo } from "../experiments/fixtures.js";

const workflow = `
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{ run: make }]
  test:
    name: Test \${{ matrix.os }}
    needs: build
    strategy: { matrix: { os: [linux, windows] } }
    runs-on: ubuntu-latest
    steps: [{ run: make test }]
  deploy:
    needs: [build, test]
    uses: ./.github/workflows/deploy.yml
`;

const run = (overrides: Partial<WorkflowRunPayload> = {}): WorkflowRunPayload => ({
  id: 500,
  name: "CI",
  path: ".github/workflows/ci.yml",
  workflow_id: 7,
  run_attempt: 1,
  head_sha: "abc",
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  created_at: "2026-01-01T00:00:00Z",
  run_started_at: "2026-01-01T00:00:10Z",
  updated_at: "2026-01-01T00:10:00Z",
  html_url: "https://github.com/acme/widgets/actions/runs/500",
  ...overrides,
});

const job = (id: number, name: string, start: string, end: string, extra: Partial<ApiJob> = {}): ApiJob => ({
  id,
  name,
  conclusion: "success",
  started_at: `2026-01-01T00:${start}Z`,
  completed_at: `2026-01-01T00:${end}Z`,
  ...extra,
});

const jobs: ApiJob[] = [
  job(1, "build", "00:15", "02:15", {
    created_at: "2026-01-01T00:00:12Z",
    runner_name: "GitHub Actions 1",
    labels: ["ubuntu-latest"],
    steps: [
      { number: 1, name: "Set up job", conclusion: "success", started_at: "2026-01-01T00:00:15Z", completed_at: "2026-01-01T00:00:17Z" },
      { number: 2, name: "make", conclusion: "success", started_at: "2026-01-01T00:00:17Z", completed_at: "2026-01-01T00:02:15Z" },
      { number: 3, name: "Skipped", conclusion: "skipped", started_at: null, completed_at: null },
    ],
  }),
  job(2, "Test linux", "02:20", "05:00"),
  job(3, "Test windows (2)", "02:20", "06:00"),
  job(4, "deploy / publish", "06:05", "07:00"),
  job(5, "never started", "00:00", "00:00", { started_at: null }),
];

describe("job definitions", () => {
  it("parses keys, names, and needs", () => {
    const definitions = parseJobDefinitions(workflow);
    expect([...definitions.keys()]).toEqual(["build", "test", "deploy"]);
    expect(definitions.get("test")).toEqual({ name: "Test ${{ matrix.os }}", needs: ["build"] });
    expect(definitions.get("deploy")?.needs).toEqual(["build", "test"]);
  });

  it("tolerates invalid YAML and missing jobs", () => {
    expect(parseJobDefinitions("jobs: [").size).toBe(0);
    expect(parseJobDefinitions("on: push").size).toBe(0);
  });

  it("matches display names back to job keys", () => {
    const definitions = parseJobDefinitions(workflow);
    expect(matchJobKey("build", definitions)).toBe("build");
    expect(matchJobKey("build (ubuntu, 20)", definitions)).toBe("build");
    expect(matchJobKey("Test linux", definitions)).toBe("test");
    expect(matchJobKey("Test windows (2)", definitions)).toBe("test");
    expect(matchJobKey("deploy / publish", definitions)).toBe("deploy");
    expect(matchJobKey("unknown", definitions)).toBeUndefined();
  });

  it("strips the ref suffix from reusable workflow paths", () => {
    expect(workflowPath(".github/workflows/ci.yml@refs/heads/main")).toBe(".github/workflows/ci.yml");
  });
});

describe("snapshotFromRun", () => {
  const snapshot = snapshotFromRun(repo, run(), jobs, parseJobDefinitions(workflow));

  it("captures run timing from the last job rather than updated_at", () => {
    expect(snapshot).toMatchObject({
      owner: "acme",
      repo: "widgets",
      workflowId: 7,
      workflowName: "CI",
      path: ".github/workflows/ci.yml",
      queueMs: 10_000,
      completedAt: "2026-01-01T00:07:00Z",
      durationMs: 410_000,
      htmlUrl: "https://github.com/acme/widgets/actions/runs/500",
    });
  });

  it("keys jobs, inherits needs, and drops jobs that never ran", () => {
    expect(snapshot.jobs.map((item) => [item.key, item.needs])).toEqual([
      ["build", []],
      ["test", ["build"]],
      ["test", ["build"]],
      ["deploy", ["build", "test"]],
    ]);
  });

  it("records runner queue time, runner identity, and executed steps", () => {
    const build = snapshot.jobs[0];
    expect(build).toMatchObject({ queuedAt: "2026-01-01T00:00:12Z", queueMs: 3_000, runnerName: "GitHub Actions 1", labels: ["ubuntu-latest"] });
    expect(build?.steps?.map((step) => [step.name, step.durationMs])).toEqual([
      ["Set up job", 2_000],
      ["make", 118_000],
    ]);
    expect(snapshot.jobs[1]).not.toHaveProperty("steps");
    expect(snapshot.jobs[1]).not.toHaveProperty("queueMs");
  });

  it("falls back to updated_at and the path when jobs or a name are missing", () => {
    const empty = snapshotFromRun(repo, run({ name: null, run_started_at: null }), [], new Map());
    expect(empty.workflowName).toBe(".github/workflows/ci.yml");
    expect(empty.startedAt).toBe("2026-01-01T00:00:00Z");
    expect(empty.durationMs).toBe(600_000);
  });
});

describe("API loading", () => {
  const content = Buffer.from(workflow).toString("base64");

  it("builds a snapshot from the jobs API and the workflow file at the head SHA", async () => {
    const client = fakeClient((route, parameters) => {
      if (route.includes("/jobs")) return { total_count: jobs.length, jobs };
      if (route.includes("/contents/")) {
        expect(parameters).toMatchObject({ path: ".github/workflows/ci.yml", ref: "abc" });
        return { content, encoding: "base64" };
      }
      throw new Error(route);
    });
    const snapshot = await buildWorkflowSnapshot(client, repo, run({ path: ".github/workflows/ci.yml@refs/heads/main" }));
    expect(snapshot.jobs.map((item) => item.key)).toEqual(["build", "test", "test", "deploy"]);
    expect(client.calls.find((call) => call.route.includes("/jobs"))?.parameters).toMatchObject({ run_id: 500, filter: "latest" });
  });

  it("degrades to display names when the workflow file is unreadable", async () => {
    const client = fakeClient((route) => {
      if (route.includes("/jobs")) return { jobs };
      throw httpError(500);
    });
    const snapshot = await buildWorkflowSnapshot(client, repo, run());
    expect(snapshot.jobs[1]?.key).toBe("Test linux");
  });

  it("paginates jobs beyond 100", async () => {
    const many = Array.from({ length: 150 }, (_, index) => job(index, `job-${index}`, "00:15", "00:20"));
    const client = fakeClient((route, parameters) => {
      if (!route.includes("/jobs")) return {};
      const page = parameters.page as number;
      return { jobs: many.slice((page - 1) * 100, page * 100) };
    });
    const snapshot = await buildWorkflowSnapshot(client, repo, run(), { definitions: new Map() });
    expect(snapshot.jobs).toHaveLength(150);
  });

  it("backfills completed run history oldest first, excluding the current run", async () => {
    const runs = [run({ id: 503, updated_at: "2026-01-03T00:00:00Z" }), run({ id: 500 }), run({ id: 502 }), run({ id: 501 })].map((item, index) => ({
      ...item,
      created_at: `2026-01-0${4 - index}T00:00:00Z`,
      run_started_at: `2026-01-0${4 - index}T00:00:00Z`,
      updated_at: `2026-01-0${4 - index}T00:05:00Z`,
    }));
    const client = fakeClient((route, parameters) => {
      if (route.endsWith("/runs")) {
        expect(parameters).toMatchObject({ workflow_id: 7, status: "completed", branch: "main" });
        return { workflow_runs: runs };
      }
      return { jobs: [] };
    });
    const history = await loadRunHistory(client, repo, { workflowId: 7, branch: "main", limit: 2, definitions: new Map(), excludeRunId: 500 });
    expect(history.map((item) => item.runId)).toEqual([502, 503]);
    expect(client.calls.filter((call) => call.route.includes("/jobs"))).toHaveLength(2);
  });
});
