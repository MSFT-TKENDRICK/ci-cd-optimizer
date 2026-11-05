import type { WorkflowSnapshot } from "../telemetry/types.js";
import { identity, validateRevision, validateScope } from "./identity.js";
import type { KnowledgeSnapshot, RepositoryIdentity, RunObservation, RunObservationQuery, RunObservationSummary, RunProjectContext } from "./types.js";

function provenanceFacts({ collectedAt: _collectedAt, ...facts }: NonNullable<WorkflowSnapshot["provenance"]>) { return facts; }

function runtimeFacts(run: WorkflowSnapshot) {
  return {
    ...run,
    ...(run.provenance ? { provenance: provenanceFacts(run.provenance) } : {}),
    jobs: run.jobs.map((job) => ({
      ...job, needs: [...new Set(job.needs)].sort(),
      ...(job.labels ? { labels: [...new Set(job.labels)].sort() } : {}),
      ...(job.steps ? { steps: [...job.steps].sort((a, b) => a.number - b.number) } : {}),
    })).sort((a, b) => a.id - b.id),
  };
}

export function runtimeFactsIdentity(run: WorkflowSnapshot): string {
  return identity(["knowledge-runtime-facts-v1", runtimeFacts(run)]);
}

export function runObservationIdentity(observation: Omit<RunObservation, "id"> | RunObservation): string {
  return identity(["knowledge-run-observation-v1", observation.version, observation.repository, observation.source, runtimeFacts(observation.run)]);
}

const positive = (value: number, field: string) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
};
const timestamp = (value: string) => {
  if (!Number.isFinite(Date.parse(value))) throw new Error("Run evidence timestamp is invalid");
};
const duration = (value: number) => {
  if (!Number.isFinite(value) || value < 0) throw new Error("Run evidence duration must be finite and nonnegative");
};

export function validateRunObservation(observation: RunObservation): void {
  validateScope(observation.repository);
  validateRevision(observation.run.headSha);
  if (observation.version !== 1 || observation.id !== runObservationIdentity(observation)) throw new Error("Run observation identity does not match its evidence");
  const run = observation.run;
  if (run.branch !== null && (typeof run.branch !== "string" || !run.branch)) throw new Error("Run evidence branch must be a nonempty string or null");
  positive(run.runId, "Run ID"); positive(run.runAttempt, "Run attempt"); positive(run.workflowId, "Workflow ID");
  [observation.observedAt, run.createdAt, run.startedAt, run.completedAt].forEach(timestamp);
  duration(run.durationMs);
  if (run.queueMs !== null) duration(run.queueMs);
  if (run.provenance) timestamp(run.provenance.collectedAt);
  if (new Set(run.jobs.map((job) => job.id)).size !== run.jobs.length) throw new Error("Run evidence contains duplicate job IDs");
  for (const job of run.jobs) {
    positive(job.id, "Job ID"); timestamp(job.startedAt); timestamp(job.completedAt); duration(job.durationMs);
    if (job.queuedAt !== undefined) timestamp(job.queuedAt);
    if (job.queueMs !== undefined) duration(job.queueMs);
    for (const step of job.steps ?? []) { positive(step.number, "Step number"); timestamp(step.startedAt); timestamp(step.completedAt); duration(step.durationMs); }
  }
  if (observation.source.status === "linked") {
    if (!/^[a-f0-9]{64}$/.test(observation.source.snapshotId)) throw new Error("Invalid project context identity");
  } else if (observation.source.status !== "unavailable" || observation.source.reason !== "revision-unavailable") {
    throw new Error("Unsupported project context status");
  }
}

export function validateRunSource(observation: RunObservation, source: KnowledgeSnapshot | undefined): void {
  if (observation.source.status === "unavailable") {
    if (source) throw new Error("Unavailable run context cannot include a source snapshot");
    return;
  }
  if (!source || source.id !== observation.source.snapshotId || source.revision !== observation.run.headSha ||
      source.repository.host !== observation.repository.host || source.repository.repositoryId !== observation.repository.repositoryId) {
    throw new Error("Run context must reference the same repository and source revision");
  }
}

export function validateRunObservationQuery(query: RunObservationQuery): void {
  validateScope(query);
  if (!Number.isSafeInteger(query.limit) || query.limit < 0 || query.limit > 100) throw new Error("Run observation limit must be between 0 and 100");
  if (query.revision !== undefined) validateRevision(query.revision);
  if (query.runId !== undefined) positive(query.runId, "Run ID");
  if (query.runAttempt !== undefined) {
    if (query.runId === undefined) throw new Error("Run attempt queries require a run ID");
    positive(query.runAttempt, "Run attempt");
  }
}

export function createRunObservation(repository: RepositoryIdentity, run: WorkflowSnapshot, source: RunProjectContext, now = new Date()): RunObservation {
  const value = structuredClone({ version: 1 as const, repository, run, source, observedAt: now.toISOString() });
  const observation = { ...value, id: runObservationIdentity(value) };
  validateRunObservation(observation);
  return observation;
}

export function runObservationSummary(observation: RunObservation): RunObservationSummary {
  return {
    id: observation.id, repository: observation.repository, observedAt: observation.observedAt, source: observation.source,
    runId: observation.run.runId, runAttempt: observation.run.runAttempt, workflowId: observation.run.workflowId, revision: observation.run.headSha,
  };
}
