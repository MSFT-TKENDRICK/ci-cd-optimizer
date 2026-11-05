import type { WorkflowSnapshot } from "./types.js";

export interface HistoryQuery {
  owner: string;
  repo: string;
  workflowId: number;
  /** Narrow to a logical run, including runs older than a general history window. */
  runId?: number;
  /** `undefined` matches every branch; `null` matches runs without a branch. */
  branch?: string | null;
  /** Defaults to one latest attempt per run. `all` returns retained attempt evidence. */
  attempts?: "latest" | "all";
  limit: number;
}

export function validateRunAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Run attempt must be a positive safe integer");
}

export function validateHistoryQuery(query: HistoryQuery): void {
  if (!Number.isSafeInteger(query.limit) || query.limit < 0) throw new Error("History limit must be a nonnegative safe integer");
  if (query.runId !== undefined && (!Number.isSafeInteger(query.runId) || query.runId < 1)) throw new Error("History run ID must be a positive safe integer");
  if (query.attempts !== undefined && query.attempts !== "latest" && query.attempts !== "all") throw new Error("Unknown history attempt selection");
}

export const runIdentity = (snapshot: WorkflowSnapshot): string => JSON.stringify([snapshot.owner, snapshot.repo, snapshot.runId]);
export const attemptIdentity = (snapshot: WorkflowSnapshot): string => JSON.stringify([snapshot.owner, snapshot.repo, snapshot.runId, snapshot.runAttempt]);
export const byCompletion = (a: WorkflowSnapshot, b: WorkflowSnapshot): number =>
  Date.parse(a.completedAt) - Date.parse(b.completedAt) || a.runId - b.runId || a.runAttempt - b.runAttempt;

/** Select before filtering successful runs, so a failed latest attempt cannot resurrect an earlier success. */
export function latestAttempts(snapshots: readonly WorkflowSnapshot[]): WorkflowSnapshot[] {
  const runs = new Map<string, WorkflowSnapshot>();
  for (const snapshot of snapshots) {
    validateRunAttempt(snapshot.runAttempt);
    const key = runIdentity(snapshot);
    const previous = runs.get(key);
    if (!previous || snapshot.runAttempt >= previous.runAttempt) runs.set(key, snapshot);
  }
  return [...runs.values()];
}

export function selectHistory(snapshots: readonly WorkflowSnapshot[], query: HistoryQuery): WorkflowSnapshot[] {
  validateHistoryQuery(query);
  if (query.limit === 0) return [];
  const scoped = snapshots.filter((item) => item.owner === query.owner && item.repo === query.repo && (query.runId === undefined || item.runId === query.runId));
  return (query.attempts === "all" ? scoped : latestAttempts(scoped))
    .filter((item) => item.workflowId === query.workflowId && (query.branch === undefined || item.branch === query.branch))
    .sort(byCompletion).slice(-query.limit);
}
