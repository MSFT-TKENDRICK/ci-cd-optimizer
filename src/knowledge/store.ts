import { identity, snapshotIdentity, validateRevision, validateScope } from "./identity.js";
import {
  equivalentMitigationDefinitions,
  validateMitigationApplication, validateMitigationApplicationEvent, validateMitigationDefinition,
  validateMitigationEvaluation, verifyMitigationEvaluation,
} from "./mitigation.js";
import { runObservationSummary, validateRunObservation, validateRunObservationQuery, validateRunSource } from "./run-observation.js";
import { MAX_RUN_OBSERVATIONS, MAX_RUN_OBSERVATION_BYTES, runWindowFromRows, validateRunWindowQuery } from "./run-window.js";
import type {
  KnowledgeQuery, KnowledgeScope, KnowledgeSnapshot, KnowledgeStore, KnowledgeSummary, MitigationApplication,
  MitigationApplicationEvent, MitigationDefinition, MitigationEvaluation, RunObservation, RunObservationQuery,
  RunObservationSummary, RunEvidenceWindow, RunEvidenceWindowQuery,
} from "./types.js";

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

const inScope = (snapshot: { repository: KnowledgeScope }, scope: KnowledgeScope) =>
  snapshot.repository.host === scope.host && snapshot.repository.repositoryId === scope.repositoryId;
const sameScope = (left: KnowledgeScope, right: KnowledgeScope) =>
  left.host === right.host && left.repositoryId === right.repositoryId;

export function summary(snapshot: KnowledgeSnapshot): KnowledgeSummary {
  return { id: snapshot.id, repository: snapshot.repository, revision: snapshot.revision, collectedAt: snapshot.collectedAt, coverage: snapshot.coverage };
}

/** Append-only content-addressed observations. Repeated collection is not independent corroboration. */
export class MemoryKnowledgeStore implements KnowledgeStore {
  private readonly snapshots = new Map<string, KnowledgeSnapshot>();
  private readonly observations = new Map<string, RunObservation>();
  private readonly mitigationDefinitions = new Map<string, MitigationDefinition>();
  private readonly mitigationApplications = new Map<string, MitigationApplication>();
  private readonly mitigationEvents = new Map<string, MitigationApplicationEvent>();
  private readonly mitigationEvaluations = new Map<string, MitigationEvaluation>();
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
  async saveRunObservation(input: RunObservation, sourceInput?: KnowledgeSnapshot): Promise<void> {
    const observation = structuredClone(input);
    const source = sourceInput ? structuredClone(sourceInput) : undefined;
    validateRunObservation(observation);
    if (source) validateSnapshot(source);
    validateRunSource(observation, source ?? (observation.source.status === "linked" ? this.snapshots.get(observation.source.snapshotId) : undefined));
    if (source && !this.snapshots.has(source.id)) this.snapshots.set(source.id, source);
    if (!this.observations.has(observation.id)) this.observations.set(observation.id, observation);
  }
  async loadRunObservation(scope: KnowledgeScope, id: string): Promise<RunObservation | undefined> {
    validateScope(scope);
    const observation = this.observations.get(id);
    return observation && inScope(observation, scope) ? structuredClone(observation) : undefined;
  }
  async listRunObservations(query: RunObservationQuery): Promise<RunObservationSummary[]> {
    validateRunObservationQuery(query);
    return [...this.observations.values()].filter((observation) =>
      inScope(observation, query) &&
      (query.runId === undefined || observation.run.runId === query.runId) &&
      (query.runAttempt === undefined || observation.run.runAttempt === query.runAttempt) &&
      (query.revision === undefined || observation.run.headSha === query.revision),
    ).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, query.limit).map((observation) => structuredClone(runObservationSummary(observation)));
  }
  async readRunWindow(query: RunEvidenceWindowQuery): Promise<RunEvidenceWindow> {
    validateRunWindowQuery(query);
    const grouped = new Map<number, RunObservation[]>();
    for (const observation of this.observations.values()) {
      if (!inScope(observation, query)) continue;
      const group = grouped.get(observation.run.runId) ?? [];
      group.push(observation);
      grouped.set(observation.run.runId, group);
    }
    const selected = [...grouped].filter(([id, observations]) => id === query.referenceRunId ||
      observations.some(({ run }) => run.workflowId === query.workflowId && run.branch === query.branch))
      .map(([id, observations]) => ({
        id, observations: observations.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || b.id.localeCompare(a.id)),
        latest: observations.reduce((latest, observation) => Math.max(latest, Date.parse(observation.observedAt)), -Infinity),
      }))
      .sort((a, b) => Number(b.id === query.referenceRunId) - Number(a.id === query.referenceRunId) || b.latest - a.latest || b.id - a.id)
      .slice(0, query.limit + 1);
    return runWindowFromRows(query, selected.flatMap(({ id, observations }) => observations.slice(0, MAX_RUN_OBSERVATIONS + 1).map((observation) => ({
      runId: id, id: observation.id,
      observation: Buffer.byteLength(JSON.stringify(observation)) <= MAX_RUN_OBSERVATION_BYTES ? observation : null,
    }))));
  }
  async saveMitigationDefinition(input: MitigationDefinition): Promise<MitigationDefinition> {
    const definition = structuredClone(input);
    validateMitigationDefinition(definition);
    const existing = [...this.mitigationDefinitions.values()].find((item) =>
      item.source.host === definition.source.host && item.source.repositoryId === definition.source.repositoryId &&
      item.key === definition.key && item.revision === definition.revision);
    if (existing) {
      if (!equivalentMitigationDefinitions(existing, definition)) throw new Error("Mitigation definition revision already has different immutable content");
      return structuredClone(existing);
    }
    this.mitigationDefinitions.set(definition.id, definition);
    return structuredClone(definition);
  }
  async loadMitigationDefinition(scope: KnowledgeScope, id: string): Promise<MitigationDefinition | undefined> {
    validateScope(scope);
    const definition = this.mitigationDefinitions.get(id);
    return definition && sameScope(definition.source, scope) ? structuredClone(definition) : undefined;
  }
  async listMitigationDefinitions(scope: KnowledgeScope, limit: number): Promise<MitigationDefinition[]> {
    validateScope(scope); validateEvidenceLimit(limit);
    return [...this.mitigationDefinitions.values()].filter((item) => sameScope(item.source, scope))
      .sort((a, b) => a.key.localeCompare(b.key) || b.revision - a.revision || a.id.localeCompare(b.id))
      .slice(0, limit).map((item) => structuredClone(item));
  }
  async saveMitigationApplication(input: MitigationApplication): Promise<void> {
    const application = structuredClone(input);
    validateMitigationApplication(application);
    const definition = this.mitigationDefinitions.get(application.definitionId);
    if (!definition) throw new Error("Mitigation application references an unknown definition revision");
    const topology = this.snapshots.get(application.topologySnapshotId);
    if (!topology || !sameScope(topology.repository, application.target) ||
        application.projectIds.some((projectId) => !topology.projects.some((project) => project.id === projectId))) {
      throw new Error("Mitigation application projects must belong to its target topology snapshot");
    }
    if (!this.mitigationApplications.has(application.id)) this.mitigationApplications.set(application.id, application);
  }
  async loadMitigationApplication(scope: KnowledgeScope, id: string): Promise<MitigationApplication | undefined> {
    validateScope(scope);
    const application = this.mitigationApplications.get(id);
    return application && sameScope(application.target, scope) ? structuredClone(application) : undefined;
  }
  async listMitigationApplications(scope: KnowledgeScope, limit: number): Promise<MitigationApplication[]> {
    validateScope(scope); validateEvidenceLimit(limit);
    return [...this.mitigationApplications.values()].filter((item) => sameScope(item.target, scope))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit).map((item) => structuredClone(item));
  }
  async appendMitigationApplicationEvent(input: MitigationApplicationEvent): Promise<void> {
    const event = structuredClone(input);
    validateMitigationApplicationEvent(event);
    const application = this.mitigationApplications.get(event.applicationId);
    if (!application || !sameScope(application.target, event.target)) throw new Error("Mitigation event references an unknown target application");
    if (Date.parse(event.observedAt) < Date.parse(application.createdAt)) throw new Error("Mitigation event predates its application");
    if (event.runObservationId) {
      const observation = this.observations.get(event.runObservationId);
      if (!observation || !inScope(observation, event.target)) throw new Error("Mitigation event run evidence crosses repository scope");
    }
    if (!this.mitigationEvents.has(event.id)) this.mitigationEvents.set(event.id, event);
  }
  async listMitigationApplicationEvents(scope: KnowledgeScope, applicationId: string, limit: number): Promise<MitigationApplicationEvent[]> {
    validateScope(scope); validateEvidenceLimit(limit);
    if (!/^[a-f0-9]{64}$/.test(applicationId)) throw new Error("Mitigation application identity is invalid");
    return [...this.mitigationEvents.values()].filter((item) => item.applicationId === applicationId && sameScope(item.target, scope))
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || b.id.localeCompare(a.id))
      .slice(0, limit).reverse().map((item) => structuredClone(item));
  }
  async saveMitigationEvaluation(input: MitigationEvaluation): Promise<void> {
    const evaluation = structuredClone(input);
    validateMitigationEvaluation(evaluation);
    const application = this.mitigationApplications.get(evaluation.applicationId);
    if (!application || !sameScope(application.target, evaluation.target)) throw new Error("Mitigation evaluation references an unknown target application");
    const events = [...this.mitigationEvents.values()].filter((event) => event.applicationId === application.id && sameScope(event.target, evaluation.target));
    const observations = [...this.observations.values()].filter((observation) => inScope(observation, evaluation.target));
    verifyMitigationEvaluation(application, evaluation, events, observations);
    if (!this.mitigationEvaluations.has(evaluation.id)) this.mitigationEvaluations.set(evaluation.id, evaluation);
  }
  async listMitigationEvaluations(scope: KnowledgeScope, applicationId: string, limit: number): Promise<MitigationEvaluation[]> {
    validateScope(scope); validateEvidenceLimit(limit);
    if (!/^[a-f0-9]{64}$/.test(applicationId)) throw new Error("Mitigation application identity is invalid");
    return [...this.mitigationEvaluations.values()].filter((item) => item.applicationId === applicationId && sameScope(item.target, scope))
      .sort((a, b) => Date.parse(b.evaluatedAt) - Date.parse(a.evaluatedAt) || a.id.localeCompare(b.id))
      .slice(0, limit).map((item) => structuredClone(item));
  }
}

function validateEvidenceLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100) throw new Error("Mitigation evidence limit must be between 0 and 100");
}
