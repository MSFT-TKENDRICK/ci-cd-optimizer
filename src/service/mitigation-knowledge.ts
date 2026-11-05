import type { GitHubClient, RepoRef } from "../github/client.js";
import { defaultBranch, resolveRepositoryRevision } from "../github/repository.js";
import { validateRevision } from "../knowledge/identity.js";
import { assessMitigation } from "../knowledge/mitigation.js";
import { loadKnowledgeIdentity } from "../knowledge/repository.js";
import type { KnowledgeStore, MitigationApplication, RepositoryIdentity, RunObservation } from "../knowledge/types.js";
import { refreshMitigationApplication } from "./recipe-knowledge.js";

type StoreFactory = () => Promise<KnowledgeStore>;

function limitValue(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Knowledge result limit must be between 1 and 100");
}

function evidenceId(id: string): void {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Knowledge evidence identity must be a SHA-256 digest");
}

async function authorizeRepository(client: GitHubClient, repo: RepoRef): Promise<RepositoryIdentity> {
  const identity = await loadKnowledgeIdentity(client, repo);
  const revision = await resolveRepositoryRevision(client, repo, await defaultBranch(client, repo, Number(identity.repositoryId)));
  validateRevision(revision.sha);
  return identity;
}

function authorization(client: GitHubClient, repo: RepoRef, identity: RepositoryIdentity, store: KnowledgeStore) {
  const revisions = new Set<string>();
  const runs = new Set<string>();
  const authorizeRevision = async (sha: string) => {
    if (revisions.has(sha)) return;
    const revision = await resolveRepositoryRevision(client, repo, sha);
    if (revision.sha !== sha) throw new Error("Knowledge source authorization returned a different revision");
    revisions.add(sha);
  };
  return {
    revision: authorizeRevision,
    application: async (application: MitigationApplication) => {
      const topology = await store.load(identity, application.topologySnapshotId);
      if (!topology) throw new Error("Mitigation target topology is unavailable");
      await authorizeRevision(topology.revision);
    },
    observation: async (id: string): Promise<RunObservation> => {
      const observation = await store.loadRunObservation(identity, id);
      if (!observation) throw new Error("Referenced run evidence is unavailable in this repository");
      const { run } = observation;
      const key = `${run.runId}:${run.runAttempt}:${run.headSha}`;
      if (!runs.has(key)) {
        const response = await client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}", {
          ...repo, run_id: run.runId, attempt_number: run.runAttempt,
        });
        const data = response.data as { id?: number; run_attempt?: number; head_sha?: string; repository?: { id?: number } } | undefined;
        if (data?.id !== run.runId || data.run_attempt !== run.runAttempt || data.head_sha !== run.headSha ||
            String(data.repository?.id) !== identity.repositoryId) {
          throw new Error("Actions authorization does not match the stored run evidence");
        }
        runs.add(key);
      }
      await authorizeRevision(run.headSha);
      return observation;
    },
  };
}

export async function authorizedRunKnowledge(client: GitHubClient, repo: RepoRef, factory: StoreFactory, id: string) {
  evidenceId(id);
  const identity = await authorizeRepository(client, repo);
  const store = await factory();
  const access = authorization(client, repo, identity, store);
  const observation = await access.observation(id);
  return { identity, store, access, observation };
}

async function authorizedApplication(client: GitHubClient, repo: RepoRef, factory: StoreFactory, id: string) {
  evidenceId(id);
  const identity = await authorizeRepository(client, repo);
  const store = await factory();
  const application = await store.loadMitigationApplication(identity, id);
  if (!application) throw new Error("Mitigation application was not found in the authorized repository");
  const access = authorization(client, repo, identity, store);
  await access.application(application);
  return { identity, store, application, access };
}

export async function listMitigationKnowledge(client: GitHubClient, repo: RepoRef, factory: StoreFactory, limit = 20) {
  limitValue(limit);
  const identity = await authorizeRepository(client, repo);
  const store = await factory();
  const applications = await store.listMitigationApplications(identity, limit);
  const access = authorization(client, repo, identity, store);
  for (const application of applications) await access.application(application);
  return { repository: identity, applications, limit, coverage: "bounded" as const };
}

export async function listRunKnowledge(
  client: GitHubClient, repo: RepoRef, factory: StoreFactory, limit = 20, runId?: number,
) {
  limitValue(limit);
  if (runId !== undefined && (!Number.isSafeInteger(runId) || runId < 1)) throw new Error("Run ID must be a positive safe integer");
  const identity = await authorizeRepository(client, repo);
  const store = await factory();
  const observations = await store.listRunObservations({ ...identity, limit, ...(runId !== undefined ? { runId } : {}) });
  const access = authorization(client, repo, identity, store);
  for (const observation of observations) await access.observation(observation.id);
  return { repository: identity, observations, limit, coverage: "bounded" as const };
}

export async function inspectMitigationKnowledge(
  client: GitHubClient, repo: RepoRef, factory: StoreFactory, id: string, limit = 20,
) {
  limitValue(limit);
  const { identity, store, application, access } = await authorizedApplication(client, repo, factory, id);
  const events = await store.listMitigationApplicationEvents(identity, id, limit);
  const evaluations = await store.listMitigationEvaluations(identity, id, limit);
  const observationIds = new Set([
    ...events.flatMap((event) => event.runObservationId ? [event.runObservationId] : []),
    ...evaluations.flatMap((evaluation) => [...evaluation.controlObservationIds, ...evaluation.treatmentObservationIds]),
  ]);
  if (observationIds.size > 200) throw new Error("Inspection exceeds 200 run observations; reduce the result limit");
  for (const observationId of observationIds) await access.observation(observationId);
  return { repository: identity, application, events, evaluations, limit, coverage: "bounded" as const };
}

export async function refreshMitigationKnowledge(client: GitHubClient, repo: RepoRef, factory: StoreFactory, id: string) {
  const { store, application } = await authorizedApplication(client, repo, factory, id);
  return refreshMitigationApplication(client, repo, store, application);
}

export async function evaluateMitigationKnowledge(
  client: GitHubClient, repo: RepoRef, factory: StoreFactory, id: string,
  options: { control: string[]; treatment: string[]; job?: string; now?: Date },
) {
  for (const ids of [options.control, options.treatment]) {
    if (ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length) {
      throw new Error("Each mitigation sample must contain 1-100 unique observation identities");
    }
    ids.forEach(evidenceId);
  }
  const { identity, store, application, access } = await authorizedApplication(client, repo, factory, id);
  const control: RunObservation[] = [];
  const treatment: RunObservation[] = [];
  for (const observationId of options.control) control.push(await access.observation(observationId));
  for (const observationId of options.treatment) treatment.push(await access.observation(observationId));
  const evaluatedAt = (options.now ?? new Date()).toISOString();
  const events = await store.listMitigationApplicationEvents(identity, id, 100);
  const eligible = events.filter((event) => Date.parse(event.observedAt) <= Date.parse(evaluatedAt));
  const latest = eligible.at(-1);
  if (latest?.state !== "applied" ||
      eligible.some((event) => Date.parse(event.observedAt) === Date.parse(latest.observedAt) && event.state !== latest.state)) {
    throw new Error("Evaluation requires an unambiguous applied lifecycle event");
  }
  const evaluation = assessMitigation({
    application, control, treatment, evaluatedAt, appliedAt: latest.observedAt,
    metric: options.job ? { kind: "job-duration", key: options.job } : { kind: "workflow-duration", key: "workflow" },
  });
  await store.saveMitigationEvaluation(evaluation);
  return evaluation;
}
