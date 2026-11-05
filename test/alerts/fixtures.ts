import type { DurationSeries } from "../../src/alerts/anomaly.js";
import type { WorkflowSnapshot } from "../../src/telemetry/types.js";

/** Deterministic jitter so values are distinct (the exact Mann-Whitney path requires no ties). */
export function jitter(index: number, amplitude = 5): number {
  return ((index * 7919) % 11) - 5 + (index % 3) * 0.1 * (amplitude / 5);
}

export function seriesOf(seconds: readonly number[], options: { jobKey?: string; workflowId?: number; startRun?: number } = {}): DurationSeries {
  const start = options.startRun ?? 1000;
  return {
    workflowId: options.workflowId ?? 7,
    workflowName: "CI",
    ...(options.jobKey !== undefined ? { jobKey: options.jobKey, jobName: options.jobKey } : {}),
    points: seconds.map((value, index) => ({
      runId: start + index,
      completedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
      durationMs: Math.round(value * 1000),
      headSha: `sha${String(start + index).padStart(5, "0")}`,
    })),
  };
}

export function stable(count: number, center: number, offset = 0): number[] {
  return Array.from({ length: count }, (_, index) => center + jitter(index + offset));
}

export function snapshot(runId: number, durationSeconds: number, jobs: Array<[string, number, string?]>, conclusion = "success"): WorkflowSnapshot {
  const completedAt = new Date(Date.UTC(2026, 9, 1, 0, runId % 1000)).toISOString();
  return {
    owner: "acme",
    repo: "widgets",
    workflowId: 7,
    workflowName: "CI",
    runId,
    runAttempt: 1,
    headSha: `sha${runId}`,
    branch: "main",
    event: "push",
    conclusion,
    createdAt: completedAt,
    startedAt: completedAt,
    completedAt,
    queueMs: 1000,
    durationMs: durationSeconds * 1000,
    provenance: { version: 1, collector: "github-actions-rest", collectedAt: completedAt, jobsComplete: true, definitionKnown: true },
    jobs: jobs.map(([key, seconds, jobConclusion], index) => ({
      id: runId * 10 + index,
      key,
      name: key,
      conclusion: jobConclusion ?? "success",
      startedAt: completedAt,
      completedAt,
      durationMs: seconds * 1000,
      needs: key === "test" && jobs.some(([key]) => key === "build") ? ["build"] : [],
      labels: ["ubuntu-24.04"],
    })),
  };
}
