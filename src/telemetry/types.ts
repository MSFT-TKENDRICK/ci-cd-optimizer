export interface StepSnapshot {
  number: number;
  name: string;
  conclusion: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface JobSnapshot {
  id: number;
  /** Resolved workflow job id (`jobs.<key>`); unresolved or ambiguous jobs fall back to their display name. */
  key: string;
  name: string;
  conclusion: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  needs: string[];
  /** GitHub job creation time; may include dependency waiting. Use readyQueueMs to subtract known dependencies. */
  queuedAt?: string;
  queueMs?: number;
  runnerName?: string;
  runnerGroupId?: number;
  labels?: string[];
  steps?: StepSnapshot[];
}

export interface WorkflowSnapshot {
  owner: string;
  repo: string;
  workflowId: number;
  workflowName: string;
  /** Workflow file, for example `.github/workflows/ci.yml`. */
  path?: string;
  runId: number;
  runAttempt: number;
  headSha: string;
  branch: string | null;
  event: string;
  conclusion: string | null;
  createdAt: string;
  startedAt: string;
  completedAt: string;
  /** Unknown for retries: run creation is not an attempt's queue-entry time. */
  queueMs: number | null;
  durationMs: number;
  htmlUrl?: string;
  jobs: JobSnapshot[];
  /** Persisted classification, not an assertion that all failed-run work could have been avoided. */
  failureAnalysis?: { categories: string[]; jobsWithLogs: number; jobs: number };
  provenance?: {
    version: 1;
    collector: "github-actions-rest";
    collectedAt: string;
    jobsComplete: boolean;
    definitionKnown: boolean;
    /** Check runs listed by the jobs API that never ran on a runner (for example other integrations' checks); excluded from `jobs`. */
    externalChecks?: { id: number; name: string }[];
  };
}

export interface WorkflowBaseline {
  sampleCount: number;
  medianDurationMs: number;
  medianQueueMs: number | null;
  /** Median duration per job key over the same runs. */
  jobs?: Record<string, number>;
}

export type BaselineExclusion =
  | "rerun" | "unsuccessful" | "provenance" | "incomplete-jobs" | "definition-unknown" | "no-jobs" | "job-failed"
  | "labels-missing" | "context-changed" | "job-set-changed";

/** Why the run-level baseline has the samples it has; reported instead of a silent "no baseline yet". */
export interface BaselineDiagnostic {
  /** Earlier latest-attempt runs that were available in history. */
  examined: number;
  /** Runs that passed every run-level eligibility rule before job-set matching. */
  eligible: number;
  /** Runs with the identical comparison key. */
  comparable: number;
  excluded: Partial<Record<BaselineExclusion, number>>;
  /** Why the current run itself cannot anchor a run-level comparison. */
  currentProblem?: BaselineExclusion;
}

/** Per-job history that survives unrelated job-set changes elsewhere in the workflow. */
export interface JobBaseline {
  key: string;
  name: string;
  sampleCount: number;
  medianDurationMs: number;
}
