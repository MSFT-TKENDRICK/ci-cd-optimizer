import type { WorkflowSnapshot } from "../telemetry/types.js";

export interface KnowledgeScope {
  /** Canonical HTTPS origin of the GitHub instance, not an organization name. */
  host: string;
  repositoryId: string;
}

export interface RepositoryIdentity extends KnowledgeScope {
  owner: string;
  repo: string;
}

export type Technology = "node" | "npm" | "pnpm" | "yarn" | "bun" | "typescript" | "nx" | "turborepo" | "lerna" | "rush" | "bazel" | "pants" | "gradle";

export interface EvidenceSource {
  path: string;
  /** JSON pointer, or an empty string for file-presence evidence. */
  pointer: string;
  digest: string;
}

export interface DeclaredSpec {
  /** This is never an installed/resolved/runtime version. */
  kind: "version-expression" | "workspace-expression" | "opaque";
  value?: string;
  digest: string;
}

export interface ProjectEvidence {
  id: string;
  kind: "repository" | "npm-package" | "configuration-root";
  path: string;
  name?: string;
}

export interface TechnologyEvidence {
  id: string;
  projectId: string;
  technology: Technology;
  basis: "dependency" | "package-manager" | "engine" | "configuration-file";
  source: EvidenceSource;
  spec?: DeclaredSpec;
}

export interface ProjectRelationship {
  id: string;
  kind: "contains" | "workspace-member" | "declares-dependency";
  from: string;
  to?: string;
  targetName?: string;
  scope?: "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";
  resolution?: "workspace-name" | "ambiguous" | "unresolved";
  source: EvidenceSource;
  spec?: DeclaredSpec;
}

export interface KnowledgeSnapshot {
  version: 1;
  id: string;
  repository: RepositoryIdentity;
  revision: string;
  collectedAt: string;
  coverage: {
    scope: "configured-node-manifests-and-tool-configs";
    inventoryComplete: boolean;
    /** Selection-policy digest; legacy observations without it cannot satisfy a reuse request. */
    inventoryPolicyDigest?: string;
    declarationsComplete: boolean;
    ignorePaths: string[];
    truncated: string[];
    problems: Array<{ path: string; code: string }>;
  };
  projects: ProjectEvidence[];
  technologies: TechnologyEvidence[];
  relationships: ProjectRelationship[];
}

export interface KnowledgeQuery extends KnowledgeScope {
  revision?: string;
  technology?: Technology;
  projectId?: string;
  limit: number;
}

export type KnowledgeSummary = Pick<KnowledgeSnapshot, "id" | "repository" | "revision" | "collectedAt" | "coverage">;

export type RunProjectContext =
  | { status: "linked"; snapshotId: string }
  | { status: "unavailable"; reason: "revision-unavailable" };

export interface RunObservation {
  version: 1;
  id: string;
  repository: RepositoryIdentity;
  observedAt: string;
  /** Measurements reported by Actions, not proof of what revision a checkout step executed. */
  run: WorkflowSnapshot;
  source: RunProjectContext;
}

export interface RunObservationQuery extends KnowledgeScope {
  runId?: number;
  /** Requires runId; all observations/corrections are retained, not just the latest attempt. */
  runAttempt?: number;
  revision?: string;
  limit: number;
}

export interface RunObservationSummary {
  id: string;
  repository: RepositoryIdentity;
  observedAt: string;
  runId: number;
  runAttempt: number;
  workflowId: number;
  revision: string;
  source: RunProjectContext;
}

export interface RunEvidenceWindowQuery extends KnowledgeScope {
  workflowId: number;
  branch: string | null;
  referenceRunId: number;
  /** Logical runs, including the pinned reference run; 0-100. */
  limit: number;
}

export interface RunEvidenceWindow {
  /** All matching logical runs currently stored fit in the window, not proof of complete Actions history. */
  complete: boolean;
  groups: Array<{
    runId: number;
    /** Incomplete groups expose no observations and must not contribute samples. */
    complete: boolean;
    observations: RunObservation[];
  }>;
}

export type MitigationRisk = "low" | "medium" | "high";

/** A source-controlled recipe revision. Natural-language applicability is not treated as verified technology evidence. */
export interface MitigationDefinition {
  version: 1 | 2;
  id: string;
  source: RepositoryIdentity;
  key: string;
  revision: number;
  contentDigest: string;
  patchDigest: string;
  title: string;
  summary: string;
  instructions: string;
  risk: MitigationRisk;
  rules: string[];
  files: string[];
  technologies: Technology[];
  contraindications: string[];
  provenance: { experiment?: string; arm?: string; pullRequest?: number };
}

export type MitigationChange =
  | { kind: "commit"; sha: string }
  | { kind: "issue"; number: number }
  | { kind: "pull-request"; number: number; headSha?: string };

/** Immutable association of one recipe revision with a target repository change and source topology. */
export interface MitigationApplication {
  version: 1;
  id: string;
  target: RepositoryIdentity;
  definitionId: string;
  topologySnapshotId: string;
  projectIds: string[];
  change: MitigationChange;
  createdAt: string;
}

export type MitigationApplicationState = "proposed" | "applied" | "reverted" | "declined" | "failed" | "unknown";

/** State is appended as an observation; later events never rewrite earlier outcomes. */
export interface MitigationApplicationEvent {
  version: 1 | 2;
  id: string;
  target: KnowledgeScope;
  applicationId: string;
  state: MitigationApplicationState;
  observedAt: string;
  runObservationId?: string;
  note?: string;
}

export type MitigationEvaluationOutcome = "observed-faster" | "observed-slower" | "no-detected-difference" | "inconclusive" | "unknown";

export interface MitigationEvaluation {
  version: 1;
  id: string;
  target: KnowledgeScope;
  applicationId: string;
  evaluatedAt: string;
  outcome: MitigationEvaluationOutcome;
  metric: { kind: "workflow-duration" | "job-duration"; key: string };
  method: "distinct-run-mann-whitney-2s-v1";
  contextKey: string;
  alpha: number;
  controlObservationIds: string[];
  treatmentObservationIds: string[];
  controlMedianMs?: number;
  treatmentMedianMs?: number;
  pValue?: number;
  limitations: string[];
}

export interface KnowledgeStore {
  initialize(): Promise<void>;
  save(snapshot: KnowledgeSnapshot): Promise<void>;
  load(scope: KnowledgeScope, id: string): Promise<KnowledgeSnapshot | undefined>;
  list(query: KnowledgeQuery): Promise<KnowledgeSummary[]>;
  /** Atomically save runtime evidence and, when supplied, its source declaration snapshot. */
  saveRunObservation(observation: RunObservation, source?: KnowledgeSnapshot): Promise<void>;
  loadRunObservation(scope: KnowledgeScope, id: string): Promise<RunObservation | undefined>;
  listRunObservations(query: RunObservationQuery): Promise<RunObservationSummary[]>;
  /** A single consistent read includes all attempts/corrections of each selected logical run, or marks it incomplete. */
  readRunWindow(query: RunEvidenceWindowQuery): Promise<RunEvidenceWindow>;
  /** Returns the canonical stored revision, retaining legacy IDs when the content is equivalent. */
  saveMitigationDefinition(definition: MitigationDefinition): Promise<MitigationDefinition>;
  loadMitigationDefinition(scope: KnowledgeScope, id: string): Promise<MitigationDefinition | undefined>;
  listMitigationDefinitions(scope: KnowledgeScope, limit: number): Promise<MitigationDefinition[]>;
  saveMitigationApplication(application: MitigationApplication): Promise<void>;
  loadMitigationApplication(scope: KnowledgeScope, id: string): Promise<MitigationApplication | undefined>;
  listMitigationApplications(scope: KnowledgeScope, limit: number): Promise<MitigationApplication[]>;
  appendMitigationApplicationEvent(event: MitigationApplicationEvent): Promise<void>;
  listMitigationApplicationEvents(scope: KnowledgeScope, applicationId: string, limit: number): Promise<MitigationApplicationEvent[]>;
  saveMitigationEvaluation(evaluation: MitigationEvaluation): Promise<void>;
  listMitigationEvaluations(scope: KnowledgeScope, applicationId: string, limit: number): Promise<MitigationEvaluation[]>;
  close?(): Promise<void>;
}
