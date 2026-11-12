import { describe, expect, it } from "vitest";
import { attributeRun } from "../../src/telemetry/attribution.js";
import { projectDashboardMetrics } from "../../src/telemetry/dashboard-metrics.js";
import type { WorkflowSnapshot } from "../../src/telemetry/types.js";

const start = "2026-11-11T00:00:00.000Z";
const middle = "2026-11-11T00:01:00.000Z";
const end = "2026-11-11T00:02:00.000Z";

function snapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    owner: "acme",
    repo: "widgets",
    workflowId: 7,
    workflowName: "CI",
    path: ".github/workflows/ci.yml",
    runId: 2000,
    runAttempt: 1,
    headSha: "a".repeat(40),
    branch: "main",
    event: "push",
    conclusion: "success",
    createdAt: "2026-11-10T23:59:55.000Z",
    startedAt: start,
    completedAt: end,
    queueMs: 5_000,
    durationMs: 120_000,
    provenance: {
      version: 1,
      collector: "github-actions-rest",
      collectedAt: "2026-11-11T00:02:05.000Z",
      jobsComplete: true,
      definitionKnown: true,
    },
    jobs: [
      {
        id: 1,
        key: "build",
        name: "Build",
        conclusion: "success",
        startedAt: start,
        completedAt: middle,
        durationMs: 60_000,
        needs: [],
        queuedAt: "2026-11-10T23:59:58.000Z",
        queueMs: 2_000,
        labels: ["ubuntu-latest"],
        steps: [
          { number: 2, name: "Compile", conclusion: "success", startedAt: "2026-11-11T00:00:30.000Z", completedAt: middle, durationMs: 30_000 },
          { number: 1, name: "Install", conclusion: "success", startedAt: start, completedAt: "2026-11-11T00:00:30.000Z", durationMs: 30_000 },
        ],
      },
      {
        id: 2,
        key: "test",
        name: "Test",
        conclusion: "success",
        startedAt: middle,
        completedAt: end,
        durationMs: 60_000,
        needs: ["build"],
        labels: ["ubuntu-latest"],
      },
    ],
    ...overrides,
  };
}

describe("dashboard metrics projection", () => {
  it("preserves exact run provenance and separates queue, elapsed, and runner work", () => {
    const result = projectDashboardMetrics({ snapshot: snapshot() });
    expect(result.provenance).toMatchObject({
      runId: 2000,
      runAttempt: 1,
      headSha: "a".repeat(40),
      event: "push",
      collectedAt: "2026-11-11T00:02:05.000Z",
      collector: "github-actions-rest",
    });
    expect(result.metrics).toMatchObject({
      queueInclusiveLatencyMs: 125_000,
      executionElapsedMs: 120_000,
      initialQueueMs: 5_000,
      observedRunnerWorkMs: 120_000,
      completeRunnerWorkMs: 120_000,
      completeness: {
        runTiming: true,
        initialQueue: true,
        jobInventory: true,
        runnerWork: true,
        criticalPath: true,
      },
    });
    expect(result.jobs.map((job) => job.name)).toEqual(["Build", "Test"]);
    expect(result.jobs.map((job) => job.critical)).toEqual([true, true]);
    expect(result.jobs[0]?.steps.map((step) => step.name)).toEqual(["Install", "Compile"]);
    expect(result.jobs[0]?.steps[0]).toMatchObject({
      startedAt: start,
      completedAt: "2026-11-11T00:00:30.000Z",
      intervalDurationMs: 30_000,
    });
  });

  it("does not infer queue-inclusive latency or complete work for retries and incomplete collection", () => {
    const retried = snapshot({
      runAttempt: 2,
      queueMs: null,
      provenance: { ...snapshot().provenance!, jobsComplete: false, definitionKnown: false },
    });
    const result = projectDashboardMetrics({ snapshot: retried });
    expect(result.metrics).toMatchObject({
      queueInclusiveLatencyMs: null,
      executionElapsedMs: null,
      initialQueueMs: null,
      observedRunnerWorkMs: 120_000,
      completeRunnerWorkMs: null,
      completeness: { runTiming: false, initialQueue: false, jobInventory: false, runnerWork: false, definitions: false, criticalPath: false },
    });
    expect(result.jobs.every((job) => job.critical === null && job.slackMs === null && job.readyQueueMs === null)).toBe(true);
    expect(result.attribution).toMatchObject({
      available: false,
      unavailableReason: "job-inventory-incomplete",
      logCoverage: null,
      findings: [],
      technologyEvidence: [],
    });
    expect(result.attribution.gaps).toEqual([]);
  });

  it("does not report zero runner work for an empty incomplete or unproven inventory", () => {
    for (const provenance of [
      { ...snapshot().provenance!, jobsComplete: false },
      undefined,
    ]) {
      const result = projectDashboardMetrics({ snapshot: snapshot({ jobs: [], provenance }) });
      expect(result.metrics.observedRunnerWorkMs).toBeNull();
      expect(result.metrics.completeRunnerWorkMs).toBeNull();
      expect(result.metrics.executionElapsedMs).toBeNull();
      expect(result.metrics.queueInclusiveLatencyMs).toBeNull();
      expect(result.attribution).toMatchObject({
        available: false,
        unavailableReason: "job-inventory-incomplete",
        logCoverage: null,
        findings: [],
      });
    }
    const complete = projectDashboardMetrics({
      snapshot: snapshot({ jobs: [], provenance: { ...snapshot().provenance!, jobsComplete: true } }),
    });
    expect(complete.metrics).toMatchObject({
      observedRunnerWorkMs: 0,
      completeRunnerWorkMs: 0,
      executionElapsedMs: 120_000,
      queueInclusiveLatencyMs: 125_000,
    });
  });

  it("retains every job and step for drilldown without report top-N truncation", () => {
    const jobs = Array.from({ length: 14 }, (_, index) => ({
      id: index + 1,
      key: `job-${index}`,
      name: `Job ${index}`,
      conclusion: "success",
      startedAt: start,
      completedAt: end,
      durationMs: 120_000,
      needs: [],
      steps: Array.from({ length: 13 }, (__, stepIndex) => ({
        number: stepIndex + 1,
        name: `Step ${stepIndex}`,
        conclusion: "success",
        startedAt: start,
        completedAt: end,
        durationMs: 120_000,
      })),
    }));
    const result = projectDashboardMetrics({
      snapshot: snapshot({ jobs, provenance: { ...snapshot().provenance!, jobsComplete: true, definitionKnown: true } }),
    });
    expect(result.jobs).toHaveLength(14);
    expect(result.jobs.every((job) => job.steps.length === 13)).toBe(true);
  });

  it("marks failed-attempt work as observed exposure and exposes matching-comparable history only", () => {
    const failed = snapshot({
      conclusion: "failure",
      runAttempt: 1,
      provenance: { ...snapshot().provenance!, jobsComplete: true, definitionKnown: true },
    });
    const retry = snapshot({ runAttempt: 2, queueMs: null });
    const earlier = snapshot({ runId: 1999, completedAt: "2026-11-10T00:00:00.000Z" });
    const result = projectDashboardMetrics({ snapshot: retry, history: [failed, earlier] });
    expect(result.reworkExposure).toMatchObject({
      label: "exposure-not-savings",
      failedAttempts: 1,
      failedAttemptRunnerWorkMs: 120_000,
      failedAttemptsWithKnownWork: 1,
      failedAttemptsWithUnknownWork: 0,
      workCoverage: "complete",
      allFailedAttemptInventoriesComplete: true,
    });
    expect(result.reworkExposure.failedAttemptsDetail[0]).toMatchObject({ runId: 2000, runAttempt: 1 });
    expect(result.comparison.sampleCount).toBe(0);
    const firstAttempt = snapshot({ runId: 2001, createdAt: "2026-11-11T00:00:00.000Z" });
    expect(projectDashboardMetrics({ snapshot: firstAttempt, history: [failed, earlier] }).comparison).toMatchObject({
      sampleCount: 1,
      medianExecutionElapsedMs: 120_000,
      medianInitialQueueMs: 5_000,
      comparableRunIds: [1999],
    });
  });

  it("keeps unknown failed-attempt work null and labels observed work from incomplete attempts as partial", () => {
    const unknown = snapshot({
      runId: 2001,
      conclusion: "failure",
      jobs: [],
      provenance: { ...snapshot().provenance!, jobsComplete: false },
    });
    const unknownExposure = projectDashboardMetrics({ snapshot: snapshot(), history: [unknown] }).reworkExposure;
    expect(unknownExposure).toMatchObject({
      failedAttempts: 1,
      failedAttemptRunnerWorkMs: null,
      failedAttemptsWithKnownWork: 0,
      failedAttemptsWithUnknownWork: 1,
      workCoverage: "unknown",
      allFailedAttemptInventoriesComplete: false,
    });

    const partial = snapshot({
      runId: 2002,
      conclusion: "failure",
      provenance: { ...snapshot().provenance!, jobsComplete: false },
    });
    const partialExposure = projectDashboardMetrics({ snapshot: snapshot(), history: [partial] }).reworkExposure;
    expect(partialExposure).toMatchObject({
      failedAttempts: 1,
      failedAttemptRunnerWorkMs: 120_000,
      failedAttemptsWithKnownWork: 1,
      failedAttemptsWithUnknownWork: 0,
      workCoverage: "partial",
      allFailedAttemptInventoriesComplete: false,
    });
  });

  it("preserves complete cache/install/container evidence without inventing log findings", () => {
    const run = snapshot();
    const attribution = attributeRun(run);
    attribution.bottlenecks.push({
      id: "package-cache:1:install",
      category: "package-cache",
      jobKey: "build",
      jobName: "Build",
      observedMs: 30_000,
      elapsedSavingsBoundMs: 0,
      runnerSavingsBoundMs: 0,
      onCriticalPath: true,
      summary: "Observed dependency-cache hit and install step.",
      recommendation: "Inspect installation separately.",
      evidence: ["npm ci took 30 seconds."],
    });
    const result = projectDashboardMetrics({ snapshot: run, attribution });
    expect(result.attribution.technologyEvidence).toHaveLength(1);
    expect(result.attribution.technologyEvidence[0]?.evidence).toEqual(["npm ci took 30 seconds."]);
    expect(projectDashboardMetrics({ snapshot: run }).attribution.technologyEvidence).toEqual([]);
  });

  it("rejects unbounded or invalid history limits", () => {
    expect(() => projectDashboardMetrics({ snapshot: snapshot(), historyLimit: 0 })).toThrow(/history limit/);
    expect(() => projectDashboardMetrics({ snapshot: snapshot(), historyLimit: 101 })).toThrow(/history limit/);
  });
});
