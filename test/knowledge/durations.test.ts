import { beforeEach, describe, expect, it } from "vitest";
import { analyzeDurations, describeDurations } from "../../src/knowledge/durations.js";
import { createRunObservation } from "../../src/knowledge/run-observation.js";
import { MemoryKnowledgeStore } from "../../src/knowledge/store.js";
import type { RunEvidenceWindow, RunObservation } from "../../src/knowledge/types.js";
import { now, repository } from "./fixtures.js";
import { observation, runWindowCases } from "./run-window-cases.js";

const policy = { minSamples: 2, objectives: [] };
function window(...items: RunObservation[]): RunEvidenceWindow {
  const groups = new Map<number, RunObservation[]>();
  for (const item of items) groups.set(item.run.runId, [...(groups.get(item.run.runId) ?? []), item]);
  return { complete: true, groups: [...groups].map(([runId, observations]) => ({ runId, observations, complete: true })) };
}

describe("memory logical-run window", () => {
  let store: MemoryKnowledgeStore;
  beforeEach(() => { store = new MemoryKnowledgeStore(); });
  runWindowCases(() => store);
});

describe("immutable duration distributions", () => {
  it("computes exact R7 quantiles without using a configured budget as an inferred expectation", () => {
    const reference = observation(10, 25);
    const evidence = window(observation(1, 10), observation(2, 30), reference);
    const config = { minSamples: 2, objectives: [
      { workflow: ".github/workflows/ci.yml", maxDurationMs: 25_000 },
      { workflow: ".github/workflows/ci.yml", job: "build", maxDurationMs: 20_000 },
      { workflow: ".github/workflows/ci.yml", job: "missing", maxDurationMs: 1000 },
    ] };
    const result = analyzeDurations(reference, evidence, config);
    expect(result.report.status).toBe("ready");
    expect(result.report.workflow?.distribution).toEqual({ sampleCount: 2, minMs: 10_000, p50Ms: 20_000, p90Ms: 28_000, p95Ms: 29_000, maxMs: 30_000 });
    expect(result.report.workflow?.objective).toMatchObject({ currentStatus: "within-budget", historicalOverBudget: 1, historicalSamples: 2 });
    expect(result.report.jobs[0]?.metric.objective?.currentStatus).toBe("over-budget");
    expect(result.report.unmatchedObjectives).toEqual([config.objectives[2]]);
    const changed = analyzeDurations(reference, evidence, { ...config, objectives: [{ workflow: ".github/workflows/ci.yml", maxDurationMs: 40_000 }] });
    expect(changed.report.workflow?.distribution).toEqual(result.report.workflow?.distribution);
    expect(changed.report.workflow?.objective?.definitionId).not.toBe(result.report.workflow?.objective?.definitionId);
    expect(describeDurations(result.report)).toContain("not prediction bounds");
  });

  it("does not inflate samples for source-context changes or input ordering", () => {
    const reference = observation(10);
    const first = observation(1);
    const otherSource = createRunObservation(repository, first.run, { status: "linked", snapshotId: "b".repeat(64) }, now);
    const result = analyzeDurations(reference, window(reference, otherSource, first, observation(2)), policy);
    expect(result.history.map((run) => run.runId)).toEqual([1, 2]);
    expect(result.report.samples[0]?.observationIds).toHaveLength(2);
    expect(result.report.workflow?.distribution?.sampleCount).toBe(2);
    result.history[0]!.durationMs = 99;
    expect(first.run.durationMs).toBe(10_000);
  });

  it("excludes conflicting corrections and all retries without resurrecting first-attempt successes", () => {
    const reference = observation(10);
    const result = analyzeDurations(reference, window(reference,
      observation(1), observation(1, 20),
      observation(2), observation(2, 15, { runAttempt: 2, conclusion: "failure" }),
      observation(3)), policy);
    expect(result.history.map((run) => run.runId)).toEqual([3]);
    expect(result.report.excluded).toEqual([
      { runId: 1, reason: "conflicting-runtime-observations" }, { runId: 2, reason: "retry-observed" },
    ]);
    expect(result.report.status).toBe("insufficient-history");
    expect(result.report.workflow?.distribution).toBeUndefined();
  });

  it("withholds conflicted, superseded or unrecorded references", () => {
    const reference = observation(10);
    expect(analyzeDurations(reference, window(observation(1)), policy).report.reason).toBe("reference-not-recorded");
    const conflict = analyzeDurations(reference, window(reference, observation(10, 20), observation(1)), policy);
    expect(conflict.report).toMatchObject({ status: "reference-excluded", reason: "conflicting-runtime-observations", samples: [] });
    expect(conflict.report.workflow).toBeUndefined();
    expect(analyzeDurations(reference, window(reference, observation(10, 10, { runAttempt: 2 })), policy).newerAttemptObserved).toBe(true);
  });

  it("holds incomplete groups, failed workloads, future completions and mismatched contexts", () => {
    const reference = observation(10);
    const routed = observation(4);
    const differentRunner = observation(4, 10, { jobs: routed.run.jobs.map((job) => ({ ...job, labels: ["windows-2025"] })) });
    const evidence = window(reference, observation(1, 10, { conclusion: "failure" }), observation(2, 10, { event: "schedule" }),
      observation(3, 10, { provenance: { ...reference.run.provenance!, jobsComplete: false } }), differentRunner, observation(20));
    evidence.groups.push({ runId: 5, complete: false, observations: [] });
    const result = analyzeDurations(reference, evidence, policy);
    expect(result.history).toEqual([]);
    expect(result.newerRunObserved).toBe(true);
    expect(result.alertHistoryUncertain).toBe(true);
    expect(result.report.excluded.map((item) => item.reason)).toEqual([
      "ineligible-workload", "different-workload-context", "ineligible-workload", "different-workload-context", "not-prior", "incomplete-run-evidence",
    ]);
  });

  it("keeps matrix legs separate and rejects indistinguishable job identities", () => {
    const matrix = (id: number, one: number, two: number) => {
      const item = observation(id, two);
      return observation(id, two, { jobs: [
        { ...item.run.jobs[0]!, name: "build (18)", durationMs: one * 1000 },
        { ...item.run.jobs[0]!, id: id * 10 + 1, name: "build (20)", durationMs: two * 1000 },
      ] });
    };
    const reference = matrix(10, 12, 22);
    const result = analyzeDurations(reference, window(reference, matrix(1, 10, 20), matrix(2, 14, 24)), policy);
    expect(Object.fromEntries(result.report.jobs.map((job) => [job.name, job.metric.distribution?.p50Ms]))).toEqual({ "build (18)": 12_000, "build (20)": 22_000 });
    const ambiguous = observation(10, 10, { jobs: reference.run.jobs.map((job) => ({ ...job, name: "build" })) });
    expect(analyzeDurations(ambiguous, window(ambiguous), policy).report.reason).toBe("ambiguous-job-identity");
  });

  it("preserves zero and finite large durations rather than producing NaN or Infinity", () => {
    const reference = observation(10, 1);
    const result = analyzeDurations(reference, window(reference, observation(1, 0), observation(2, 0)), policy);
    expect(result.report.workflow?.distribution?.p95Ms).toBe(0);
    const large = analyzeDurations(reference, window(reference, observation(1, 1, { durationMs: 1e308 }), observation(2, 1, { durationMs: 1.5e308 })), policy);
    expect(Number.isFinite(large.report.workflow?.distribution?.p50Ms)).toBe(true);
  });

  it("rejects scope mixing, duplicate logical groups and invalid statistical policy", () => {
    expect(() => observation(1, 10, { branch: "" })).toThrow("branch");
    const reference = observation(10);
    expect(() => analyzeDurations(reference, window(reference, observation(1, 10, {}, { ...repository, repositoryId: "43" })), policy)).toThrow("scope");
    const evidence = window(reference);
    evidence.groups.push(evidence.groups[0]!);
    expect(() => analyzeDurations(reference, evidence, policy)).toThrow("Duplicate");
    expect(() => analyzeDurations(reference, window(reference), { ...policy, minSamples: 1 })).toThrow("policy");
  });
});
