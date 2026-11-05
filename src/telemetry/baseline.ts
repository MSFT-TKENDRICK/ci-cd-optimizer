import { slowestPerKey } from "../alerts/anomaly.js";
import { median } from "../alerts/stats.js";
import type { WorkflowBaseline, WorkflowSnapshot } from "./types.js";
import { latestAttempts } from "./history.js";

export { median };

/** Median of the last `limit` successful runs of the same workflow and branch, excluding the run itself. */
export function computeBaseline(history: readonly WorkflowSnapshot[], snapshot: WorkflowSnapshot, limit = 20): WorkflowBaseline | undefined {
  const runs = latestAttempts(history)
    .filter(
      (item) =>
        item.runId !== snapshot.runId &&
        item.owner === snapshot.owner &&
        item.repo === snapshot.repo &&
        item.workflowId === snapshot.workflowId &&
        item.branch === snapshot.branch &&
        item.conclusion === "success",
    )
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.runId - b.runId)
    .slice(-limit);
  if (runs.length === 0) return undefined;
  const jobDurations = new Map<string, number[]>();
  for (const run of runs) {
    for (const job of slowestPerKey(run.jobs)) {
      jobDurations.set(job.key, [...(jobDurations.get(job.key) ?? []), job.durationMs]);
    }
  }
  return {
    sampleCount: runs.length,
    medianDurationMs: median(runs.map((item) => item.durationMs)),
    medianQueueMs: median(runs.map((item) => item.queueMs)),
    jobs: Object.fromEntries([...jobDurations].map(([key, values]) => [key, median(values)])),
  };
}
