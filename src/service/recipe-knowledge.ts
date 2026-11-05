import type { GitHubClient, RepoRef } from "../github/client.js";
import { readFileAt } from "../github/git.js";
import { defaultBranch, resolveRepositoryRevision, type RepositorySnapshot } from "../github/repository.js";
import { parseRepo } from "../github/rest.js";
import { findMarker } from "../issues/markers.js";
import { extractKnowledge } from "../knowledge/extract.js";
import { identity, inventoryPolicyDigest, validateRevision } from "../knowledge/identity.js";
import {
  createMitigationApplication, createMitigationApplicationEvent, mitigationDefinitionFromRecipe,
} from "../knowledge/mitigation.js";
import { loadKnowledgeIdentity } from "../knowledge/repository.js";
import type {
  KnowledgeSnapshot, KnowledgeStore, MitigationApplication, MitigationApplicationEvent,
  MitigationDefinition, RepositoryIdentity,
} from "../knowledge/types.js";
import type { LintConfig } from "../lint/config.js";
import { parseRecipe, recipePath, RECIPE_ID, type Recipe } from "../recipes/recipe.js";

export interface RecipeKnowledge {
  store: KnowledgeStore;
  definition: MitigationDefinition;
  topology: KnowledgeSnapshot;
}

/** A local recipe is not authority to populate another repository's catalog. Read and compare its published revision first. */
export async function prepareRecipeKnowledge(
  client: GitHubClient, target: RepoRef, recipe: Recipe, snapshot: RepositorySnapshot,
  config: LintConfig, store: KnowledgeStore,
): Promise<RecipeKnowledge> {
  if (!RECIPE_ID.test(recipe.id)) throw new Error("Recipe knowledge requires a valid recipe ID");
  const sourceRepo = parseRepo(recipe.source.repository);
  const source = await loadKnowledgeIdentity(client, sourceRepo);
  const revision = await resolveRepositoryRevision(client, sourceRepo, await defaultBranch(client, sourceRepo));
  validateRevision(revision.sha);
  const text = await readFileAt(client, sourceRepo, recipePath(recipe.id), revision.sha);
  if (text === undefined) throw new Error("Knowledge recording requires a published recipe readable in its source repository");
  const published = parseRecipe(text);
  if (!published.recipe) throw new Error("Published recipe is invalid; knowledge recording was not started");
  if (published.recipe.source.repository.toLowerCase() !== recipe.source.repository.toLowerCase()) {
    throw new Error("Published recipe names a different source repository");
  }
  const definition = mitigationDefinitionFromRecipe(source, published.recipe);
  if (definition.id !== mitigationDefinitionFromRecipe(source, recipe).id ||
      identity({ ...published.recipe, compatibility: null }) !== identity({ ...recipe, compatibility: null })) {
    throw new Error("Local recipe differs from its published immutable revision");
  }
  const repository = await loadKnowledgeIdentity(client, target);
  if (repository.host !== source.host) throw new Error("Recipe knowledge cannot cross GitHub hosts");
  const topology = extractKnowledge(repository, snapshot.sha, snapshot.input, {
    ignorePaths: config.ignorePaths, truncated: snapshot.input.truncated, inventoryPolicyDigest: inventoryPolicyDigest(config),
  });
  const storedDefinition = await store.saveMitigationDefinition(definition);
  await store.save(topology);
  return { store, definition: storedDefinition, topology };
}

interface ChangeResponse {
  number?: number;
  body?: string | null;
  state?: string;
  state_reason?: string | null;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  merged?: boolean;
  merged_at?: string | null;
  head?: { sha?: string; repo?: { id?: number } | null };
  base?: { repo?: { id?: number } | null };
  pull_request?: unknown;
}

function time(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("GitHub change lacks a valid lifecycle timestamp");
  return new Date(value).toISOString();
}

async function readChange(
  client: GitHubClient, repo: RepoRef, identity: RepositoryIdentity, kind: "pull-request" | "issue", number: number,
): Promise<ChangeResponse> {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Mitigation change number must be a positive safe integer");
  const response = kind === "pull-request"
    ? await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: number })
    : await client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { ...repo, issue_number: number });
  const change = response.data as ChangeResponse | undefined;
  if (!change || change.number !== number || !["open", "closed"].includes(change.state ?? "")) {
    throw new Error("GitHub change does not match the recorded mitigation");
  }
  if (kind === "pull-request") {
    if (String(change.base?.repo?.id) !== identity.repositoryId || String(change.head?.repo?.id) !== identity.repositoryId) {
      throw new Error("Mitigation pull request must belong to the target repository, not a fork");
    }
    validateRevision(change.head?.sha ?? "");
    if (typeof change.merged !== "boolean" || (change.merged && (change.state !== "closed" || !change.merged_at))) {
      throw new Error("GitHub pull request has inconsistent merge evidence");
    }
  } else if (change.pull_request) throw new Error("Mitigation adaptation issue unexpectedly refers to a pull request");
  time(change.created_at);
  return change;
}

function stateEvent(application: MitigationApplication, change: ChangeResponse): MitigationApplicationEvent {
  let state: MitigationApplicationEvent["state"];
  let observedAt: string;
  let note: string | undefined;
  if (application.change.kind === "pull-request" && application.change.headSha !== change.head?.sha) {
    state = "unknown";
    observedAt = time(change.updated_at);
    note = "Pull request head changed or was never pinned by the optimizer; these edits do not establish that the recorded recipe was applied.";
  } else if (application.change.kind === "pull-request" && change.merged) {
    state = "applied";
    observedAt = time(change.merged_at);
    note = "GitHub reports this pinned pull request merged; no performance benefit or executed project is inferred.";
  } else if (change.state === "closed") {
    state = application.change.kind === "issue" && change.state_reason !== "not_planned" ? "unknown" : "declined";
    observedAt = time(change.closed_at);
    if (state === "unknown") note = "Closing an adaptation issue does not prove a code change or optimization benefit.";
  } else {
    state = "proposed";
    observedAt = time(change.updated_at ?? change.created_at);
  }
  return createMitigationApplicationEvent({
    target: { host: application.target.host, repositoryId: application.target.repositoryId },
    applicationId: application.id, state, observedAt, ...(note ? { note } : {}),
  });
}

export async function recordRecipeApplications(
  client: GitHubClient, target: RepoRef, knowledge: RecipeKnowledge, changes: { pullRequest?: number; issue?: number },
): Promise<string[]> {
  const ids: string[] = [];
  for (const [kind, number] of [["pull-request", changes.pullRequest], ["issue", changes.issue]] as const) {
    if (number === undefined) continue;
    const raw = await readChange(client, target, knowledge.topology.repository, kind, number);
    const marker = findMarker(raw.body ?? "", "recipe");
    if (marker?.fingerprint !== knowledge.definition.key || marker.attributes.revision !== String(knowledge.definition.revision)) {
      throw new Error("GitHub change is not linked to the published recipe revision");
    }
    const fix = kind === "pull-request" ? findMarker(raw.body ?? "", "fix") : undefined;
    const pinnedHead = fix?.fingerprint === `group:recipe-${knowledge.definition.key}` ? fix.attributes.commit : undefined;
    if (pinnedHead !== undefined) validateRevision(pinnedHead);
    const application = createMitigationApplication({
      target: knowledge.topology.repository, definitionId: knowledge.definition.id, topologySnapshotId: knowledge.topology.id,
      projectIds: [], change: kind === "issue" ? { kind, number } : { kind, number, ...(pinnedHead ? { headSha: pinnedHead } : {}) },
      createdAt: time(raw.created_at),
    });
    await knowledge.store.saveMitigationApplication(application);
    await knowledge.store.appendMitigationApplicationEvent(createMitigationApplicationEvent({
      target: { host: application.target.host, repositoryId: application.target.repositoryId },
      applicationId: application.id, state: "proposed", observedAt: application.createdAt,
    }));
    await knowledge.store.appendMitigationApplicationEvent(stateEvent(application, raw));
    ids.push(application.id);
  }
  return ids;
}

/** The caller must have freshly authorized this application and target; no source-definition payload is read here. */
export async function refreshMitigationApplication(
  client: GitHubClient, target: RepoRef, store: KnowledgeStore, application: MitigationApplication,
): Promise<MitigationApplicationEvent> {
  return (await refreshMitigationApplications(client, target, store, [application]))[0]!;
}

export async function refreshMitigationApplications(
  client: GitHubClient, target: RepoRef, store: KnowledgeStore, applications: readonly MitigationApplication[],
): Promise<MitigationApplicationEvent[]> {
  if (applications.length === 0) return [];
  if (applications.length > 100) throw new Error("Mitigation lifecycle refresh is limited to 100 applications");
  const identity = await loadKnowledgeIdentity(client, target, Number(applications[0]!.target.repositoryId));
  const changes = new Map<string, ChangeResponse>();
  const events: MitigationApplicationEvent[] = [];
  for (const application of applications) {
    if (identity.host !== application.target.host || identity.repositoryId !== application.target.repositoryId) {
      throw new Error("Mitigation target identity changed");
    }
    if (application.change.kind === "commit") throw new Error("Commit-only applications require explicit application evidence");
    const key = `${application.change.kind}:${application.change.number}`;
    let change = changes.get(key);
    if (!change) {
      change = await readChange(client, target, identity, application.change.kind, application.change.number);
      changes.set(key, change);
    }
    events.push(stateEvent(application, change));
  }
  for (const event of events) await store.appendMitigationApplicationEvent(event);
  return events;
}
