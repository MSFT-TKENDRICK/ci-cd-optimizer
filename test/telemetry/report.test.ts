import { describe, expect, it } from "vitest";
import { computeBaseline, median } from "../../src/telemetry/baseline.js";
import { attributeRun } from "../../src/telemetry/attribution.js";
import { calculateCriticalPath, createTelemetryReport } from "../../src/telemetry/report.js";
import { MemoryTelemetryStore } from "../../src/telemetry/store.js";
import type { WorkflowSnapshot } from "../../src/telemetry/types.js";

const snapshot: WorkflowSnapshot = {
  owner: "octo",
  repo: "example",
  workflowId: 10,
  workflowName: "CI",
  runId: 100,
  runAttempt: 1,
  headSha: "abc",
  branch: "main",
  event: "push",
  conclusion: "success",
  createdAt: "2026-01-01T00:00:00Z",
  startedAt: "2026-01-01T00:00:05Z",
  completedAt: "2026-01-01T00:02:05Z",
  queueMs: 5_000,
  durationMs: 120_000,
  provenance: { version: 1, collector: "github-actions-rest", collectedAt: "2026-01-01T00:02:05Z", jobsComplete: true, definitionKnown: true },
  jobs: [
    {
      id: 1,
      key: "build",
      name: "Build",
      conclusion: "success",
      startedAt: "2026-01-01T00:00:05Z",
      completedAt: "2026-01-01T00:01:05Z",
      durationMs: 60_000,
      needs: [],
      labels: ["ubuntu-24.04"],
    },
    {
      id: 2,
      key: "test",
      name: "Test",
      conclusion: "success",
      startedAt: "2026-01-01T00:01:05Z",
      completedAt: "2026-01-01T00:02:05Z",
      durationMs: 60_000,
      needs: ["build"],
      labels: ["ubuntu-24.04"],
    },
  ],
};

describe("workflow telemetry", () => {
  it("calculates the dependency critical path", () => {
    expect(calculateCriticalPath(snapshot.jobs)).toEqual({
      durationMs: 120_000,
      jobKeys: ["build", "test"],
    });
  });

  it("renders Gantt and dependency diagrams", () => {
    const report = createTelemetryReport(snapshot);
    expect(report).toContain("gantt");
    expect(report).toContain("flowchart LR");
    expect(report).toContain("build → test");
  });

  it("reports bounded bottleneck evidence and explicit coverage gaps", () => {
    const attribution = attributeRun(snapshot);
    const report = createTelemetryReport(snapshot, undefined, { attribution });
    expect(report).toContain("### Bottleneck evidence");
    expect(report).toContain("Savings are evidence-based upper bounds");
    expect(report).toContain("#### Evidence coverage gaps");
    expect(report).toContain("log-not-fetched");
  });

  it("persists and compares historical snapshots", async () => {
    const store = new MemoryTelemetryStore();
    await store.save({ ...snapshot, runId: 99, durationMs: 100_000, completedAt: "2025-12-31T00:00:00Z" });
    await store.save(snapshot);
    const history = await store.history({ owner: "octo", repo: "example", workflowId: 10, branch: "main", limit: 10 });
    expect(history.map((item) => item.runId)).toEqual([99, 100]);
    expect(computeBaseline(history, snapshot)).toMatchObject({ sampleCount: 1, medianDurationMs: 100_000, jobs: { build: 60_000, test: 60_000 } });
  });

  it("replaces a re-saved run and filters by branch", async () => {
    const store = new MemoryTelemetryStore();
    await store.save(snapshot);
    await store.save({ ...snapshot, durationMs: 1 });
    await store.save({ ...snapshot, runId: 101, branch: "feature" });
    expect(store.snapshots).toHaveLength(2);
    expect(await store.history({ owner: "octo", repo: "example", workflowId: 10, branch: "feature", limit: 5 })).toHaveLength(1);
    expect(await store.history({ owner: "octo", repo: "example", workflowId: 10, limit: 5 })).toHaveLength(2);
  });

  it("baselines only successful runs of the same workflow and branch", () => {
    const history = [
      { ...snapshot, runId: 1, durationMs: 10_000 },
      { ...snapshot, runId: 2, durationMs: 30_000 },
      { ...snapshot, runId: 3, durationMs: 999_000, conclusion: "failure" },
      { ...snapshot, runId: 4, durationMs: 999_000, branch: "other" },
      { ...snapshot, runId: 5, durationMs: 999_000, workflowId: 11 },
    ];
    expect(computeBaseline(history, snapshot)).toMatchObject({ sampleCount: 2, medianDurationMs: 20_000 });
    expect(computeBaseline([], snapshot)).toBeUndefined();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNaN();
  });

  it("marks the critical path, runner waits, slow steps, and job regressions", () => {
    const rich: WorkflowSnapshot = {
      ...snapshot,
      jobs: [
        {
          ...(snapshot.jobs[0] as WorkflowSnapshot["jobs"][number]),
          queuedAt: "2026-01-01T00:00:00Z",
          queueMs: 65_000,
          labels: ["ubuntu-latest"],
          steps: [
            { number: 1, name: "Install deps", conclusion: "success", startedAt: "2026-01-01T00:00:05Z", completedAt: "2026-01-01T00:00:50Z", durationMs: 45_000 },
            { number: 2, name: "Compile", conclusion: "success", startedAt: "2026-01-01T00:00:50Z", completedAt: "2026-01-01T00:01:05Z", durationMs: 15_000 },
          ],
        },
        snapshot.jobs[1] as WorkflowSnapshot["jobs"][number],
        { id: 3, key: "lint", name: "Lint", conclusion: "success", startedAt: "2026-01-01T00:00:05Z", completedAt: "2026-01-01T00:00:15Z", durationMs: 10_000, needs: [] },
      ],
    };
    const report = createTelemetryReport(rich, { sampleCount: 5, medianDurationMs: 100_000, medianQueueMs: 0, jobs: { build: 20_000, test: 58_000 } });
    expect(report).toContain("Build :crit, done, j");
    expect(report).toContain("Lint :done, j");
    expect(report).toContain("section Runner queue");
    expect(report).toContain("Build wait :q0, 2026-01-01T00:00:00, 2026-01-01T00:00:05");
    expect(report).toContain("| Build | Install deps | 45s | 75% |");
    expect(report).toContain("### Jobs slower than baseline");
    expect(report).toContain("| Build | 1m 0s | 20s | +40s |");
    expect(report.slice(report.indexOf("### Jobs slower than baseline"))).not.toContain("| Test |");
    expect(report).toContain("waited over a minute for a runner");
    expect(report).toContain("`ubuntu-latest`");
  });

  it("explains a missing baseline and flags per-job regressions only with enough samples", () => {
    const diagnostic = { examined: 5, eligible: 2, comparable: 0, excluded: { "job-set-changed": 2, unsuccessful: 3 } };
    const enough = [{ key: "build", name: "Build", sampleCount: 3, medianDurationMs: 20_000 }];
    const report = createTelemetryReport(snapshot, undefined, { diagnostic, jobBaselines: enough });
    expect(report).toContain("No run-level baseline: 5 earlier run(s) examined, 0 comparable.\n\n- 3 excluded — The workflow did not complete successfully.\n- 2 excluded — The workflow's job set");
    expect(report).toContain("| Build | 1m 0s | 20s | 3 | +40s |");
    expect(report).toContain("### Jobs slower than baseline");
    const thin = createTelemetryReport(snapshot, undefined, { diagnostic, jobBaselines: [{ ...enough[0]!, sampleCount: 2 }] });
    expect(thin).toContain("### Per-job history");
    expect(thin).not.toContain("### Jobs slower than baseline");
    expect(createTelemetryReport(snapshot, undefined, { diagnostic: { examined: 0, eligible: 0, comparable: 0, excluded: {} } }))
      .toContain("No comparable historical baseline is available in the retained/backfilled evidence window. No earlier runs of this workflow were found.");
    expect(createTelemetryReport(snapshot, { sampleCount: 1, medianDurationMs: 100_000, medianQueueMs: 0, jobs: {} }, { jobBaselines: enough }))
      .not.toContain("### Per-job history");
  });
});
