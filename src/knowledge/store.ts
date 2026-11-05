import { identity, snapshotIdentity, validateRevision, validateScope } from "./identity.js";
import type { KnowledgeQuery, KnowledgeScope, KnowledgeSnapshot, KnowledgeStore, KnowledgeSummary } from "./types.js";

export function validateQuery(query: KnowledgeQuery): void {
  validateScope(query);
  if (query.revision !== undefined) validateRevision(query.revision);
  if (!Number.isSafeInteger(query.limit) || query.limit < 0 || query.limit > 100) throw new Error("Knowledge query limit must be between 0 and 100");
}

export function validateSnapshot(snapshot: KnowledgeSnapshot): void {
  validateScope(snapshot.repository);
  validateRevision(snapshot.revision);
  if (snapshot.version !== 1 || snapshot.id !== snapshotIdentity(snapshot)) throw new Error("Knowledge snapshot identity does not match its evidence");
  if (!Number.isFinite(Date.parse(snapshot.collectedAt))) throw new Error("Knowledge collection time is invalid");
  const ids = new Set(snapshot.projects.map((project) => project.id));
  if (snapshot.projects.some((project) => project.id !== identity([snapshot.repository.host, snapshot.repository.repositoryId, project.kind, project.path]))) {
    throw new Error("Knowledge project identity does not match its repository and location");
  }
  if (snapshot.projects.filter((project) => project.kind === "repository" && project.path === "").length !== 1) throw new Error("Knowledge requires one repository root");
  for (const collection of [snapshot.technologies, snapshot.relationships]) {
    if (collection.some(({ id, ...fact }) => id !== identity(fact))) throw new Error("Knowledge evidence identity does not match its declaration");
  }
  if (ids.size !== snapshot.projects.length ||
    snapshot.technologies.some((fact) => !ids.has(fact.projectId)) ||
    snapshot.relationships.some((edge) => !ids.has(edge.from) || (edge.to !== undefined && !ids.has(edge.to)))) {
    throw new Error("Knowledge relationships must reference projects in the same snapshot");
  }
  for (const collection of [snapshot.technologies, snapshot.relationships]) {
    if (new Set(collection.map((item) => item.id)).size !== collection.length) throw new Error("Knowledge contains duplicate evidence identities");
  }
}

const inScope = (snapshot: KnowledgeSnapshot, scope: KnowledgeScope) =>
  snapshot.repository.host === scope.host && snapshot.repository.repositoryId === scope.repositoryId;

export function summary(snapshot: KnowledgeSnapshot): KnowledgeSummary {
  return { id: snapshot.id, repository: snapshot.repository, revision: snapshot.revision, collectedAt: snapshot.collectedAt, coverage: snapshot.coverage };
}

/** Append-only content-addressed observations. Repeated collection is not independent corroboration. */
export class MemoryKnowledgeStore implements KnowledgeStore {
  private readonly snapshots = new Map<string, KnowledgeSnapshot>();
  async initialize(): Promise<void> {}
  async save(snapshot: KnowledgeSnapshot): Promise<void> {
    validateSnapshot(snapshot);
    if (!this.snapshots.has(snapshot.id)) this.snapshots.set(snapshot.id, structuredClone(snapshot));
  }
  async load(scope: KnowledgeScope, id: string): Promise<KnowledgeSnapshot | undefined> {
    validateScope(scope);
    const snapshot = this.snapshots.get(id);
    return snapshot && inScope(snapshot, scope) ? structuredClone(snapshot) : undefined;
  }
  async list(query: KnowledgeQuery): Promise<KnowledgeSummary[]> {
    validateQuery(query);
    return [...this.snapshots.values()].filter((snapshot) =>
      inScope(snapshot, query) &&
      (query.revision === undefined || snapshot.revision === query.revision) &&
      (query.projectId === undefined || snapshot.projects.some((project) => project.id === query.projectId)) &&
      (query.technology === undefined || snapshot.technologies.some((fact) =>
        fact.technology === query.technology && (query.projectId === undefined || fact.projectId === query.projectId))),
    ).sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, query.limit).map((snapshot) => structuredClone(summary(snapshot)));
  }
}
