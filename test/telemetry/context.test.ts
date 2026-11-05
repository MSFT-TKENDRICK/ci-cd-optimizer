import { describe, expect, it } from "vitest";
import { buildSeries } from "../../src/alerts/anomaly.js";
import { computeBaseline } from "../../src/telemetry/baseline.js";
import { comparableHistory, comparisonKey, comparisonProblem } from "../../src/telemetry/context.js";
import { createTelemetryReport } from "../../src/telemetry/report.js";
import type { WorkflowSnapshot } from "../../src/telemetry/types.js";
import { snapshot } from "../alerts/fixtures.js";

const current = snapshot(2000, 120, [["build", 60], ["test", 50]]);
const prior = { ...current, runId: 1001, durationMs: 100_000 };

describe("workload comparison contract", () => {
  it("ignores source SHA, job IDs, volatile runner names, ordering and label duplicates", () => {
    const changed = {
      ...prior, headSha: "another-source-revision",
      jobs: [...prior.jobs].reverse().map((job) => ({ ...job, id: job.id + 10, runnerName: "new-ephemeral-runner", labels: [...job.labels!, ...job.labels!] })),
    };
    expect(comparisonKey(changed)).toBe(comparisonKey(current));
    expect(comparableHistory([changed, changed], current)).toEqual([changed]);
  });

  const different: Array<[string, (run: WorkflowSnapshot) => WorkflowSnapshot]> = [
    ["repository", (run) => ({ ...run, repo: "other" })],
    ["owner", (run) => ({ ...run, owner: "other" })],
    ["workflow", (run) => ({ ...run, workflowId: 8 })],
    ["branch", (run) => ({ ...run, branch: "release" })],
    ["trigger", (run) => ({ ...run, event: "schedule" })],
    ["runner labels", (run) => ({ ...run, jobs: run.jobs.map((job) => ({ ...job, labels: ["self-hosted", "linux"] })) })],
    ["runner group", (run) => ({ ...run, jobs: run.jobs.map((job) => ({ ...job, runnerGroupId: 42 })) })],
    ["job set", (run) => ({ ...run, jobs: run.jobs.slice(0, 1) })],
    ["matrix leg", (run) => ({ ...run, jobs: run.jobs.map((job) => ({ ...job, name: `${job.name} (arm64)` })) })],
    ["dependency graph", (run) => ({ ...run, jobs: run.jobs.map((job) => ({ ...job, needs: [] })) })],
  ];
  it.each(different)("does not mix %s contexts", (_, change) => {
    expect(comparableHistory([change(prior)], current)).toEqual([]);
    expect(comparisonKey(change(prior))).not.toBe(comparisonKey(current));
  });

  const uncertain: Array<[string, (run: WorkflowSnapshot) => WorkflowSnapshot]> = [
    ["retry", (run) => ({ ...run, runAttempt: 2 })],
    ["failure", (run) => ({ ...run, conclusion: "failure" })],
    ["legacy evidence", (run) => { const legacy = { ...run }; delete legacy.provenance; return legacy; }],
    ["incomplete jobs", (run) => ({ ...run, provenance: { ...run.provenance!, jobsComplete: false } })],
    ["unknown definition", (run) => ({ ...run, provenance: { ...run.provenance!, definitionKnown: false } })],
    ["empty jobs", (run) => ({ ...run, jobs: [] })],
    ["failed job", (run) => ({ ...run, jobs: run.jobs.map((job) => ({ ...job, conclusion: "failure" })) })],
    ["unknown runner", (run) => ({ ...run, jobs: run.jobs.map((job) => ({ ...job, labels: [] })) })],
  ];
  it.each(uncertain)("abstains on %s rather than assigning a comparison context", (_, change) => {
    expect(comparisonProblem(change(prior))).toBeTruthy();
    expect(comparisonKey(change(prior))).toBeUndefined();
    expect(computeBaseline([change(prior)], current)).toBeUndefined();
    expect(computeBaseline([prior], change(current))).toBeUndefined();
  });

  it("does not resurrect first-attempt success after a retry or count duplicate deliveries twice", () => {
    expect(comparableHistory([prior, { ...prior, runAttempt: 2 }, prior], current)).toEqual([]);
    expect(computeBaseline([prior, prior], current)?.sampleCount).toBe(1);
  });

  it("keeps unknown queue measurements distinct from zero", () => {
    expect(computeBaseline([{ ...prior, queueMs: null }], current)?.medianQueueMs).toBeNull();
    expect(computeBaseline([{ ...prior, queueMs: null }, { ...prior, runId: 1002, queueMs: 2000 }], current)?.medianQueueMs).toBe(2000);
  });

  it("keeps workload contexts in separate duration series", () => {
    const other = { ...prior, runId: 1002, event: "schedule" };
    const series = buildSeries([prior, other, current]).filter((series) => !series.jobKey);
    expect(series).toHaveLength(2);
    expect(series.map((series) => series.points.length).sort()).toEqual([1, 2]);
    expect(new Set(series.map((series) => series.contextKey)).size).toBe(2);
  });

  it("explains abstention and does not mislabel inter-attempt delay as runner queueing", () => {
    const report = createTelemetryReport({ ...current, runAttempt: 2, queueMs: 86_400_000 });
    expect(report).toContain("Performance comparison withheld: Reruns");
    expect(report).toContain("**Queue:** unavailable");
    expect(report).not.toContain("Runner queueing added");
  });
});
