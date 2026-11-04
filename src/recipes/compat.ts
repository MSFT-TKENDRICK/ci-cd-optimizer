/**
 * Lower bound of the Wilson score interval: a conservative success rate that accounts for small samples
 * (3/3 successes ≈ 0.44, 30/30 ≈ 0.89), used to gate rollouts the way Dependabot's compatibility score informs merges.
 */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = successes / total;
  const z2 = z * z;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - margin) / (1 + z2 / total));
}

export interface Compatibility {
  passed: number;
  failed: number;
  total: number;
  rate?: number;
  lowerBound: number;
  /** Whether there are enough samples for the rate to be meaningful. */
  sufficient: boolean;
  display: string;
}

export function compatibility(stats: { passed: number; failed: number }, minSamples = 5): Compatibility {
  const total = stats.passed + stats.failed;
  const lowerBound = wilsonLowerBound(stats.passed, total);
  const sufficient = total >= minSamples;
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const rate = total > 0 ? stats.passed / total : undefined;
  const display =
    total === 0
      ? "No data yet"
      : sufficient
        ? `${percent(rate as number)} (${stats.passed}/${total} repositories passed CI; 95% lower bound ${percent(lowerBound)})`
        : `Not enough data (${stats.passed}/${total} repositories passed CI)`;
  return { passed: stats.passed, failed: stats.failed, total, ...(rate !== undefined ? { rate } : {}), lowerBound, sufficient, display };
}

export type Outcome = "passed" | "failed" | "pending" | "unknown";

export interface CheckRunSummary {
  name?: string;
  status: string;
  conclusion: string | null;
}

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

/**
 * Outcome of a recipe pull request in a target repository, based on its CI (like Dependabot's compatibility score):
 * merged counts as passed; any failing check as failed; running checks as pending; no checks at all as unknown.
 */
export function classifyOutcome(checkRuns: readonly CheckRunSummary[], pr: { merged: boolean }): Outcome {
  if (pr.merged) return "passed";
  if (checkRuns.some((run) => run.conclusion !== null && FAILED.has(run.conclusion))) return "failed";
  if (checkRuns.some((run) => run.status !== "completed")) return "pending";
  if (checkRuns.length === 0) return "unknown";
  return "passed";
}

/** Adaptation issues have no CI of their own: open is pending, completed is passed, not planned is failed. */
export function classifyIssueOutcome(issue: { state: "open" | "closed"; stateReason?: string | null }): Outcome {
  if (issue.state === "open") return "pending";
  return issue.stateReason === "not_planned" ? "failed" : "passed";
}
