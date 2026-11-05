import { slowestPerKey } from "../alerts/anomaly.js";
import { median } from "../alerts/stats.js";
import type { WorkflowBaseline, WorkflowSnapshot } from "./types.js";
import { comparableHistory } from "./context.js";
import { byCompletion } from "./history.js";

export { median };

/** Median of the last `limit` eligible runs in the same observed workload context, excluding the run itself. */
export function computeBaseline(history: readonly WorkflowSnapshot[], snapshot: WorkflowSnapshot, limit = 20): WorkflowBaseline | undefined {
  const runs = comparableHistory(history, snapshot)
    .sort(byCompletion)
    .slice(-limit);
  if (runs.length === 0) return undefined;
  const jobDurations = new Map<string, number[]>();
  const queues = runs.flatMap((run) => run.queueMs === null ? [] : [run.queueMs]);
  for (const run of runs) {
    for (const job of slowestPerKey(run.jobs)) {
      jobDurations.set(job.key, [...(jobDurations.get(job.key) ?? []), job.durationMs]);
    }
  }
  return {
    sampleCount: runs.length,
    medianDurationMs: median(runs.map((item) => item.durationMs)),
    medianQueueMs: queues.length ? median(queues) : null,
    jobs: Object.fromEntries([...jobDurations].map(([key, values]) => [key, median(values)])),
  };
}
