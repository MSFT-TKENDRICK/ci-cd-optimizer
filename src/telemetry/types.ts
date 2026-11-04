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
  queueMs: number;
  durationMs: number;
  htmlUrl?: string;
  jobs: JobSnapshot[];
}

export interface WorkflowBaseline {
  sampleCount: number;
  medianDurationMs: number;
  medianQueueMs: number;
  /** Median duration per job key over the same runs. */
  jobs?: Record<string, number>;
}
