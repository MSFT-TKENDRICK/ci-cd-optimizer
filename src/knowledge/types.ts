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

export interface KnowledgeStore {
  initialize(): Promise<void>;
  save(snapshot: KnowledgeSnapshot): Promise<void>;
  load(scope: KnowledgeScope, id: string): Promise<KnowledgeSnapshot | undefined>;
  list(query: KnowledgeQuery): Promise<KnowledgeSummary[]>;
  close?(): Promise<void>;
}
