import { describe, expect, it } from "vitest";
import { buildSeries } from "../../src/alerts/anomaly.js";
import { computeBaseline } from "../../src/telemetry/baseline.js";
import {
  comparableHistory, comparisonExclusion, comparisonKey, comparisonProblem, diagnoseBaseline, jobBaselines, jobHistoryApplies,
  summarizeBaselineGap, thinJobHistory,
} from "../../src/telemetry/context.js";
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

  it("does not use future completions as historical baseline evidence", () => {
    const future = { ...prior, completedAt: "2027-01-01T00:00:00Z" };
    expect(comparableHistory([future], current)).toEqual([]);
    expect(computeBaseline([future], current)).toBeUndefined();
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

describe("baseline diagnostics and per-job history", () => {
  const history = [1001, 1002, 1003].map((id, index) => snapshot(id, 100, [["build", 40 + index], ["test", 50 + index]]));
  const grown = snapshot(1010, 130, [["build", 41], ["test", 52], ["formal", 30]]);

  it("classifies the first applicable exclusion in a stable order", () => {
    const run = snapshot(1001, 100, [["build", 40]]);
    expect(comparisonExclusion({ ...run, runAttempt: 2, conclusion: "failure" })).toBe("rerun");
    expect(comparisonExclusion({ ...run, conclusion: "failure" })).toBe("unsuccessful");
    expect(comparisonExclusion({ ...run, provenance: { ...run.provenance!, definitionKnown: false } })).toBe("definition-unknown");
    expect(comparisonExclusion(run)).toBeUndefined();
  });

  it("explains that adding a job made every earlier run incomparable instead of reporting no history", () => {
    expect(comparableHistory(history, grown)).toEqual([]);
    expect(diagnoseBaseline(history, grown)).toEqual({ examined: 3, eligible: 3, comparable: 0, excluded: { "job-set-changed": 3 } });
    expect(summarizeBaselineGap(diagnoseBaseline(history, grown))).toBe("no baseline: 3 of 3 earlier runs had a different job set");
  });

  it("counts each excluded run once, by its first reason, and ignores later or same-run evidence", () => {
    const mixed = [
      ...history,
      { ...snapshot(1004, 100, [["build", 40]]), runAttempt: 2 },
      snapshot(1005, 100, [["build", 40]], "failure"),
      { ...snapshot(1006, 100, [["build", 40]]), event: "schedule" },
      snapshot(1020, 100, [["build", 40]]),
      { ...grown, runAttempt: 1 },
    ];
    const reference = snapshot(1010, 100, [["build", 41], ["test", 52]]);
    expect(diagnoseBaseline(mixed, reference)).toEqual({
      examined: 6, eligible: 3, comparable: 3, excluded: { rerun: 1, unsuccessful: 1, "context-changed": 1 },
    });
  });

  it("reports the current run's own problem rather than blaming history", () => {
    const diagnostic = diagnoseBaseline(history, { ...grown, runAttempt: 2 });
    expect(diagnostic.currentProblem).toBe("rerun");
    expect(diagnostic.comparable).toBe(0);
    expect(summarizeBaselineGap(diagnostic)).toMatch(/^no baseline: reruns may execute/);
    expect(summarizeBaselineGap(diagnoseBaseline([], grown))).toBe("no baseline yet: no earlier runs in history");
    expect(summarizeBaselineGap(undefined)).toBe("no baseline yet");
  });

  it("keeps per-job medians across unrelated job-set changes and failures elsewhere in the run", () => {
    const failedElsewhere = snapshot(1004, 100, [["build", 60], ["test", 10, "failure"]], "failure");
    expect(jobBaselines([...history, failedElsewhere], grown)).toEqual([
      { key: "build", name: "build", sampleCount: 4, medianDurationMs: 41_500 },
      { key: "test", name: "test", sampleCount: 3, medianDurationMs: 51_000 },
    ]);
    expect(jobBaselines(history, grown, 2).map((entry) => entry.sampleCount)).toEqual([2, 2]);
  });

  it("does not compare jobs whose name, needs, runner or definition changed, or that are ambiguous", () => {
    const relabeled = history.map((run) => ({ ...run, jobs: run.jobs.map((job) => ({ ...job, labels: ["self-hosted"] })) }));
    expect(jobBaselines(relabeled, grown)).toEqual([]);
    const unknown = history.map((run) => ({ ...run, provenance: { ...run.provenance!, definitionKnown: false } }));
    expect(jobBaselines(unknown, grown)).toEqual([]);
    const duplicated = { ...grown, jobs: [...grown.jobs, { ...grown.jobs[0]!, id: 99 }] };
    expect(jobBaselines(history, duplicated).map((entry) => entry.key)).toEqual(["test"]);
  });

  it("asks for more history only while a comparable job is short of samples", () => {
    expect(jobHistoryApplies(grown)).toBe(true);
    expect(jobHistoryApplies({ ...grown, runAttempt: 2 })).toBe(false);
    expect(thinJobHistory(history, snapshot(1010, 100, [["build", 41], ["test", 52]]), 3)).toBe(false);
    expect(thinJobHistory(history, snapshot(1010, 100, [["build", 41], ["test", 52]]), 4)).toBe(true);
    expect(thinJobHistory(history, grown, 3)).toBe(true);
  });

  it("renders exclusion reasons and per-job history when no run-level baseline exists", () => {
    const report = createTelemetryReport(grown, undefined, { diagnostic: diagnoseBaseline(history, grown), jobBaselines: jobBaselines(history, grown) });
    expect(report).toContain("No run-level baseline: 3 earlier run(s) examined, 0 comparable.");
    expect(report).toContain("- 3 excluded — The workflow's job set");
    expect(report).toContain("### Per-job history");
    expect(report).toMatch(/\| test \| 52s \| 51s \| 3 \| \+1s \|/);
    const perJob = report.slice(report.indexOf("### Per-job history"), report.indexOf("### Observations"));
    expect(perJob).toContain("| build | 41s | 41s | 3 | +0s |");
    expect(perJob).not.toContain("formal");
  });
});
