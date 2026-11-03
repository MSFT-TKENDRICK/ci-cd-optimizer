export type Severity = "low" | "medium" | "high";
export type Effort = "small" | "medium" | "large";
export type Confidence = "medium" | "high";

export interface RepositoryFile {
  path: string;
  content: string;
  size: number;
}

export interface Evidence {
  path: string;
  line?: number;
  excerpt?: string;
}

export interface Finding {
  ruleId: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  effort: Effort;
  category:
    | "caching"
    | "hermeticity"
    | "containers"
    | "monorepo"
    | "registries"
    | "workflow";
  estimatedImpact: string;
  explanation: string;
  recommendation: string;
  evidence: Evidence;
  documentationUrl?: string;
}

export interface AnalysisContext {
  files: RepositoryFile[];
  fileMap: ReadonlyMap<string, RepositoryFile>;
}

export interface Rule {
  id: string;
  description: string;
  evaluate(context: AnalysisContext): Finding[];
}

export interface OptimizerConfig {
  enabled: boolean;
  failOnSeverity: Severity | "never";
  disabledRules: string[];
  ignoredPaths: string[];
  maxFiles: number;
  maxFileBytes: number;
}

export interface JobSnapshot {
  id: number;
  key: string;
  name: string;
  conclusion: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  needs: string[];
}

export interface WorkflowSnapshot {
  owner: string;
  repo: string;
  workflowId: number;
  workflowName: string;
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
  jobs: JobSnapshot[];
}

export interface WorkflowBaseline {
  sampleCount: number;
  medianDurationMs: number;
  medianQueueMs: number;
}
