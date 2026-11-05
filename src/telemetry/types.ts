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
  /** Workflow job id (`jobs.<key>`); matrix legs and reusable-workflow jobs keep their display name. */
  key: string;
  name: string;
  conclusion: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  needs: string[];
  /** When the job became ready to run; `startedAt - queuedAt` is time spent waiting for a runner. */
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
  provenance?: {
    version: 1;
    collector: "github-actions-rest";
    collectedAt: string;
    jobsComplete: boolean;
    definitionKnown: boolean;
  };
}

export interface WorkflowBaseline {
  sampleCount: number;
  medianDurationMs: number;
  medianQueueMs: number | null;
  /** Median duration per job key over the same runs. */
  jobs?: Record<string, number>;
}
