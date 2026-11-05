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
  close?(): Promise<void>;
}
