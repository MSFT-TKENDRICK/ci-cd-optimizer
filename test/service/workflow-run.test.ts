import { describe, expect, it } from "vitest";
import { parseMarker } from "../../src/issues/markers.js";
import { alertsApply, processWorkflowRun } from "../../src/service/workflow-run.js";
import type { WorkflowRunPayload } from "../../src/telemetry/snapshot.js";
import { MemoryTelemetryStore } from "../../src/telemetry/store.js";
import { snapshot, stable } from "../alerts/fixtures.js";
import { repo } from "../experiments/fixtures.js";
import { callsTo, fakeApi, routes, writes } from "./api.js";

const workflowFile = "name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps: [{ run: make }]\n  test:\n    needs: build\n    runs-on: ubuntu-24.04\n    steps: [{ run: make test }]\n";

const run = (overrides: Partial<WorkflowRunPayload> = {}): WorkflowRunPayload => ({
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
  ...overrides,
});

const at = (time: string) => `2026-11-01T00:${time}Z`;
/** build 00:10 -> 02:10, test 02:15 -> 10:05: about 600 s end to end. */
const jobs = [
  { id: 1, name: "build", conclusion: "success", labels: ["ubuntu-24.04"], created_at: at("00:05"), started_at: at("00:10"), completed_at: at("02:10"), steps: [] },
  { id: 2, name: "test", conclusion: "success", labels: ["ubuntu-24.04"], created_at: at("02:10"), started_at: at("02:15"), completed_at: at("10:05"), steps: [] },
];

/** Twelve stable ~300 s runs of the same workflow on main. */
function seeded(): MemoryTelemetryStore {
  const store = new MemoryTelemetryStore();
  stable(12, 300).forEach((seconds, index) => {
    store.snapshots.push(snapshot(1000 + index, Math.round(seconds), [["build", 100], ["test", Math.round(seconds) - 110]]));
  });
  return store;
}

const api = (overrides: Parameters<typeof fakeApi>[0] = {}) => fakeApi({ refs: { abc: { ".github/workflows/ci.yml": workflowFile } }, jobs: { 2000: jobs }, ...overrides });

describe("alertsApply", () => {
  it("defaults to the default branch and excludes pull request runs", () => {
    expect(alertsApply({ event: "push", head_branch: "main" }, [], "main")).toBe(true);
    expect(alertsApply({ event: "push", head_branch: "feature" }, [], "main")).toBe(false);
    expect(alertsApply({ event: "pull_request", head_branch: "main" }, [], "main")).toBe(false);
    expect(alertsApply({ event: "pull_request_target", head_branch: "main" }, ["**"], "main")).toBe(false);
    expect(alertsApply({ event: "schedule", head_branch: null }, ["**"], "main")).toBe(false);
  });

  it("matches configured branch globs", () => {
    expect(alertsApply({ event: "push", head_branch: "release/1.2" }, ["main", "release/*"], "main")).toBe(true);
    expect(alertsApply({ event: "merge_group", head_branch: "gh-readonly-queue/main/pr-1" }, ["main"], "main")).toBe(false);
  });
});

describe("processWorkflowRun", () => {
  it.each([false, true])("does not advance alerts for an old delivery when a newer run is recorded (different context: %s)", async (differentContext) => {
    const store = seeded();
    const newer = { ...snapshot(3000, 1, [["build", 1], ["test", 1]]), completedAt: "2026-11-02T00:00:00Z" };
    if (differentContext) newer.jobs = newer.jobs.map((job) => ({ ...job, labels: ["self-hosted"] }));
    await store.save(newer);
    const client = api();
    const result = await processWorkflowRun(client, repo, run(), { store });
    expect(result).toMatchObject({ status: "processed", samples: 12, baseline: { sampleCount: 12 } });
    expect(result.alerts).toBeUndefined();
    expect(callsTo(client, "GET /repos/{owner}/{repo}/issues")).toEqual([]);
  });

  it("reports retries without a baseline, backfill or alert mutations", async () => {
    const store = seeded();
    const client = api();
    const result = await processWorkflowRun(client, repo, run({ run_attempt: 2 }), { store });
    expect(result).toMatchObject({ status: "processed", samples: 0, snapshot: { queueMs: null } });
    expect(result.baseline).toBeUndefined();
    expect(result.alerts).toBeUndefined();
    expect(result.report).toContain("Performance comparison withheld: Reruns");
    expect(callsTo(client, "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs")).toEqual([]);
    expect(callsTo(client, "POST /repos/{owner}/{repo}/issues")).toEqual([]);
  });

  it("does not compare different runner labels or advance their alert lifecycle", async () => {
    const client = api({ jobs: { 2000: jobs.map((job) => ({ ...job, labels: ["self-hosted"] })) } });
    const result = await processWorkflowRun(client, repo, run(), { store: seeded() });
    expect(result.samples).toBe(0);
    expect(result.baseline).toBeUndefined();
    expect(result.alerts?.actions).toEqual([]);
  });

  it("preserves a delayed attempt without republishing stale reports or alerts", async () => {
    const store = seeded();
    const latest = { ...snapshot(2000, 300, [["build", 300]]), runAttempt: 2 };
    await store.save(latest);
    const client = api();
    const result = await processWorkflowRun(client, repo, run(), { store });
    expect(result).toMatchObject({ status: "skipped", reason: "A newer attempt is already recorded.", snapshot: { runAttempt: 1 } });
    expect(store.snapshots.filter((item) => item.runId === 2000)).toHaveLength(2);
    expect(writes(client)).toEqual([]);
  });

  it("recognizes a superseding attempt outside the recent history window", async () => {
    const store = seeded();
    await store.save({ ...snapshot(2000, 100, []), runAttempt: 2 });
    for (let id = 3001; id <= 3100; id += 1) {
      await store.save({ ...snapshot(id, 100, []), completedAt: "2027-01-01T00:00:00Z" });
    }
    const client = api();
    const result = await processWorkflowRun(client, repo, run(), { store });
    expect(result).toMatchObject({ status: "skipped", reason: "A newer attempt is already recorded." });
    expect(writes(client)).toEqual([]);
  });

  it("persists newer backfilled attempts of runs already known to a cold store", async () => {
    const store = new MemoryTelemetryStore();
    await store.save(snapshot(1999, 300, []));
    const client = api({ workflowRuns: [run({ id: 1999, run_attempt: 2, conclusion: "failure" })] });
    const result = await processWorkflowRun(client, repo, run(), { store, alerts: false });
    expect(result.baseline).toBeUndefined();
    expect(store.snapshots.filter((item) => item.runId === 1999).map((item) => item.runAttempt)).toEqual([1, 2]);
  });

  it("skips runs that are not completed", async () => {
    const client = api();
    expect(await processWorkflowRun(client, repo, run({ status: "in_progress" }))).toEqual({ status: "skipped", reason: "Run is in_progress." });
    expect(client.calls).toHaveLength(0);
  });

  it("does nothing when disabled", async () => {
    expect((await processWorkflowRun(api({ config: "enabled: false\n" }), repo, run())).status).toBe("disabled");
  });

  it("skips runs without completed jobs", async () => {
    const result = await processWorkflowRun(api({ jobs: {} }), repo, run());
    expect(result).toMatchObject({ status: "skipped", reason: "The run has no completed jobs." });
  });

  it("retains cancellation evidence even without completed jobs, but not during dry runs", async () => {
    const store = new MemoryTelemetryStore();
    await store.save(snapshot(2000, 300, [["build", 300]]));
    const cancelled = run({ run_attempt: 2, conclusion: "cancelled" });
    const client = api({ jobs: {} });
    await processWorkflowRun(client, repo, cancelled, { store, dryRun: true });
    expect(store.snapshots).toHaveLength(1);
    const result = await processWorkflowRun(client, repo, cancelled, { store });
    expect(result.status).toBe("skipped");
    expect(store.snapshots).toHaveLength(2);
    expect(await store.history({ ...repo, workflowId: 7, limit: 10 })).toMatchObject([{ runAttempt: 2, conclusion: "cancelled", jobs: [] }]);
    expect(writes(client)).toEqual([]);
  });

  it("publishes a telemetry report with a Gantt chart against the stored baseline", async () => {
    const client = api();
    const store = seeded();
    const result = await processWorkflowRun(client, repo, run(), { store, alerts: false });
    expect(result).toMatchObject({ status: "processed", samples: 12, checkRunId: 99 });
    expect(result.snapshot?.jobs.map((job) => [job.key, job.needs])).toEqual([["build", []], ["test", ["build"]]]);
    expect(result.baseline?.sampleCount).toBe(12);
    expect(result.report).toContain("gantt");
    const check = callsTo(client, "POST /repos/{owner}/{repo}/check-runs")[0]?.parameters as { name: string; conclusion: string; head_sha: string; details_url: string; output: { title: string } };
    expect(check).toMatchObject({ name: "CI/CD Telemetry (CI)", conclusion: "neutral", head_sha: "abc", details_url: run().html_url });
    expect(check.output.title).toMatch(/^10\.0 min \(\+\d+% vs 12-run median\)$/);
    expect(store.snapshots.map((item) => item.runId)).toContain(2000);
    expect(routes(client)).not.toContain("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs");
  });

  it("opens a duration alert issue for a statistically significant spike", async () => {
    const client = api();
    const result = await processWorkflowRun(client, repo, run(), { store: seeded(), now: new Date("2026-11-01T00:11:00Z") });
    expect(result.alerts?.detected.length).toBeGreaterThan(0);
    expect(result.alerts?.actions.some((action) => action.type === "create")).toBe(true);
    const issue = callsTo(client, "POST /repos/{owner}/{repo}/issues")[0]?.parameters as { title: string; body: string; labels: string[] };
    expect(parseMarker(issue.body)?.kind).toBe("alert");
    expect(issue.labels).toContain("cicd-optimizer");
  });

  it("never alerts on pull request runs", async () => {
    const client = api();
    const result = await processWorkflowRun(client, repo, run({ event: "pull_request" }), { store: seeded() });
    expect(result.status).toBe("processed");
    expect(result.alerts).toBeUndefined();
    expect(callsTo(client, "POST /repos/{owner}/{repo}/issues")).toHaveLength(0);
  });

  it("backfills a cold store from the Actions API and persists it", async () => {
    const prior = (id: number, day: string) => run({ id, created_at: `2026-10-${day}T00:00:00Z`, run_started_at: `2026-10-${day}T00:00:00Z`, updated_at: `2026-10-${day}T00:05:00Z` });
    const store = new MemoryTelemetryStore();
    const client = api({ workflowRuns: [prior(1998, "30"), prior(1999, "31")], jobs: { 1998: jobs, 1999: jobs, 2000: jobs } });
    const result = await processWorkflowRun(client, repo, run(), { store, alerts: false });
    expect(result.samples).toBe(2);
    expect(store.snapshots.map((item) => item.runId).sort()).toEqual([1998, 1999, 2000]);
    expect(callsTo(client, "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs")[0]?.parameters).toMatchObject({ workflow_id: 7, branch: "main" });
  });

  it("rebuilds history from the API when there is no store", async () => {
    const client = api({ workflowRuns: [run({ id: 1999, created_at: "2026-10-31T00:00:00Z", run_started_at: "2026-10-31T00:00:00Z", updated_at: "2026-10-31T00:05:00Z" })], jobs: { 1999: jobs, 2000: jobs } });
    const result = await processWorkflowRun(client, repo, run(), { alerts: false });
    expect(result.samples).toBe(1);
    expect(result.baseline?.sampleCount).toBe(1);
  });

  it("writes nothing in dry-run mode", async () => {
    const store = seeded();
    const client = api();
    const result = await processWorkflowRun(client, repo, run(), { store, dryRun: true });
    expect(result.alerts?.actions.length).toBeGreaterThan(0);
    expect(result.alerts?.applied).toEqual([]);
    expect(result.checkRunId).toBeUndefined();
    expect(writes(client)).toHaveLength(0);
    expect(store.snapshots).toHaveLength(12);
  });
});
