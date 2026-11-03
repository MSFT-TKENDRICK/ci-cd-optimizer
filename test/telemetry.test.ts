import { describe, expect, it } from "vitest";
import { calculateCriticalPath, createTelemetryReport } from "../src/telemetry/report.js";
import { MemoryTelemetryStore } from "../src/telemetry/store.js";
import type { WorkflowSnapshot } from "../src/types.js";

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

  it("persists and compares historical snapshots", async () => {
    const store = new MemoryTelemetryStore();
    await store.save({ ...snapshot, runId: 99, durationMs: 100_000 });
    const baseline = await store.baseline(snapshot);
    expect(baseline).toMatchObject({ sampleCount: 1, medianDurationMs: 100_000 });
  });
});
