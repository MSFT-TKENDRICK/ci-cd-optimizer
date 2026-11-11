import { describe, expect, it } from "vitest";
import { attributeRun } from "../../src/telemetry/attribution.js";
import { BENCHMARK_SCHEMA, benchmarkRun, decodeBenchmark, encodeBenchmark, reworkSummary, type RunBenchmark } from "../../src/telemetry/benchmark.js";
import type { WorkflowSnapshot } from "../../src/telemetry/types.js";

const start = "2026-11-11T00:00:00.000Z";
const end = "2026-11-11T00:01:00.000Z";
function snapshot(): WorkflowSnapshot {
  return {
    owner: "acme", repo: "widgets", workflowId: 7, workflowName: "CI", path: ".github/workflows/ci.yml",
    runId: 2000, runAttempt: 1, headSha: "a".repeat(40), branch: "main", event: "push", conclusion: "success",
    createdAt: start, startedAt: start, completedAt: end, queueMs: 2000, durationMs: 60000,
    provenance: { version: 1, collector: "github-actions-rest", collectedAt: end, jobsComplete: true, definitionKnown: true },
    jobs: [{ id: 1, key: "test", name: "test", conclusion: "success", startedAt: start, completedAt: end, durationMs: 60000, needs: [] }],
  };
}
function benchmark(): RunBenchmark {
  const run = snapshot();
  return { schema: BENCHMARK_SCHEMA, repositoryId: 42, collectedAt: end, ...benchmarkRun(run, attributeRun(run), undefined, []) };
}
const log = (frames: string) => frames.split("\n").map((frame) => `${end} ${frame}`).join("\n");

describe("bounded benchmark transport", () => {
  it("roundtrips timestamped multi-frame logs without inventing log completeness", () => {
    const value = benchmark();
    value.gaps = Array.from({ length: 10 }, (_, index) => `${index}:${"x".repeat(1000)}`);
    const frames = encodeBenchmark(value);
    expect(frames.split("\n").length).toBeGreaterThan(1);
    expect(decodeBenchmark(log(frames))).toEqual(value);
    expect(value.analysisStatus).toBe("partial");
    expect(value.jobs[0]?.observedRunnerSharePct).toBe(100);
    expect(value.metrics?.queueInclusiveMs).toBe(62000);
  });

  it("rejects missing, duplicate, corrupt and mixed frames", () => {
    const value = benchmark();
    value.gaps = Array.from({ length: 10 }, () => "x".repeat(1000));
    const frames = encodeBenchmark(value).split("\n");
    expect(() => decodeBenchmark(log(frames.slice(1).join("\n")))).toThrow(/incomplete/);
    expect(() => decodeBenchmark(log([...frames, frames[0]!].join("\n")))).toThrow(/Inconsistent/);
    expect(() => decodeBenchmark(log(frames.join("\n").replace(/.$/, "A")))).toThrow(/integrity/);
    const other = encodeBenchmark({ ...value, runAttempt: 2 }).split("\n");
    expect(() => decodeBenchmark(log([frames[0]!, ...other.slice(1)].join("\n")))).toThrow(/Inconsistent/);
    expect(() => decodeBenchmark("No producer output")).toThrow(/missing/);
  });

  it("rejects oversized payloads instead of silently publishing partial evidence", () => {
    const value = benchmark();
    value.gaps = Array.from({ length: 100 }, () => "x".repeat(1200));
    expect(() => encodeBenchmark(value)).toThrow(/bounded broadcast/);
  });

  it("fits large collected evidence into a publishable summary with explicit omissions", () => {
    const run = snapshot();
    const attribution = attributeRun(run);
    attribution.gaps = Array.from({ length: 100 }, () => ({ ...attribution.gaps[0]!, detail: "x".repeat(1200) }));
    const value = { schema: BENCHMARK_SCHEMA, repositoryId: 42, collectedAt: end, ...benchmarkRun(run, attribution, undefined, []) };
    expect(value.omittedGaps).toBeGreaterThan(0);
    expect(value.analysisStatus).toBe("partial");
    expect(value.gaps.at(-1)).toMatch(/Publication size limit/);
    expect(decodeBenchmark(log(encodeBenchmark(value)))).toEqual(value);
  });

  it("withholds full-run metrics and comparisons for incomplete collection", () => {
    const run = snapshot();
    run.provenance!.jobsComplete = false;
    const value = benchmarkRun(run, undefined, snapshot(), []);
    expect(value).toMatchObject({
      analysisStatus: "unavailable", previous: null,
      metrics: { elapsedMs: null, queueInclusiveMs: null, runnerMs: null, observedRunnerMs: 60000 },
    });
  });

  it("counts failed attempts separately from successful retries and labels exposure, not savings", () => {
    const failed = { ...snapshot(), conclusion: "failure", failureAnalysis: { categories: ["generated-artifact-drift"], jobsWithLogs: 1, jobs: 1 } };
    const retried = { ...snapshot(), runAttempt: 2 };
    const unknown = { ...snapshot(), runId: 2001, conclusion: "failure" };
    expect(reworkSummary([failed, retried, failed, unknown])).toEqual({
      observedAttempts: 3, failedAttempts: 2, artifactDriftAttempts: 1,
      artifactDriftRunnerMs: 60000, unclassifiedFailedAttempts: 1,
    });
  });
});
