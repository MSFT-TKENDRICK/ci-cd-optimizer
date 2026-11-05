import { expect, it } from "vitest";
import {
  assessMitigation, createMitigationApplication, createMitigationApplicationEvent, createMitigationDefinition,
  createMitigationEvaluation, mitigationDefinitionFromRecipe,
} from "../../src/knowledge/mitigation.js";
import { createRunObservation } from "../../src/knowledge/run-observation.js";
import { identity } from "../../src/knowledge/identity.js";
import type { Recipe } from "../../src/recipes/recipe.js";
import type { KnowledgeStore, MitigationDefinition, RunObservation } from "../../src/knowledge/types.js";
import { snapshot as workflow } from "../alerts/fixtures.js";
import { now, repository, revision, snapshot } from "./fixtures.js";

const unknownSource = { status: "unavailable" as const, reason: "revision-unavailable" as const };
const applicationTime = "2026-10-31T00:00:00.000Z";
const appliedTime = "2026-11-01T01:00:00.000Z";
const evaluationTime = "2026-11-06T00:00:00.000Z";
const definition = (overrides: { revision?: number; summary?: string } = {}) => createMitigationDefinition({
  source: repository, key: "shared-cache", revision: overrides.revision ?? 1, title: "Use a shared cache",
  summary: overrides.summary ?? "Share immutable dependency artifacts.", instructions: "Add the organization cache with a bounded key.",
  risk: "medium", rules: ["caching/setup-cache"], files: [".github/workflows/**"],
  technologies: ["pnpm", "turborepo"], contraindications: ["Do not reuse mutable build outputs."], patchDigest: "c".repeat(64),
  provenance: { experiment: "cache-key-study", arm: "shared-key", pullRequest: 71 },
});
const application = (topology = snapshot(), definitionId = definition().id) => createMitigationApplication({
  target: repository, definitionId, topologySnapshotId: topology.id,
  projectIds: [topology.projects.find((project) => project.kind === "npm-package")!.id],
  change: { kind: "pull-request", number: 81, headSha: "b".repeat(40) }, createdAt: applicationTime,
});
const observation = (runId: number, seconds: number, start: string, headSha = revision): RunObservation => {
  const finished = new Date(Date.parse(start) + 60_000).toISOString();
  const base = workflow(runId, seconds, [["build", seconds]]);
  const run = {
    ...base, path: ".github/workflows/ci.yml", headSha, createdAt: start, startedAt: start, completedAt: finished,
    jobs: base.jobs.map((job) => ({ ...job, startedAt: start, completedAt: finished })),
  };
  return createRunObservation(repository, run, unknownSource, new Date(finished));
};

function measuredObservations(): { control: RunObservation[]; treatment: RunObservation[] } {
  return {
    control: [1, 2, 3, 4].map((id) => observation(id, 60 + id, `2026-10-${20 + id}T00:00:00.000Z`)),
    treatment: [11, 12, 13, 14].map((id) => observation(id, 30 + id, `2026-11-0${id - 9}T00:00:00.000Z`, "b".repeat(40))),
  };
}

const normalizedSamples = async () => measuredObservations();

export function legacyDefinition(): MitigationDefinition {
  const { source, key, revision, title, summary, instructions, risk, rules, files, technologies, contraindications, provenance, patchDigest } = definition();
  const content = { version: 1 as const, source, key, revision, title, summary, instructions, risk, rules, files, technologies, contraindications, provenance, patchDigest };
  const contentDigest = identity(["mitigation-content-v1", content]);
  return { ...content, contentDigest, id: identity(["mitigation-definition-v1", source.host, source.repositoryId, key, revision, contentDigest]) };
}

export function mitigationCases(getStore: () => KnowledgeStore): void {
  it("preserves version-one definition and event identities while accepting new evidence", async () => {
    const store = getStore();
    const old = legacyDefinition();
    expect(await store.saveMitigationDefinition(old)).toEqual(old);
    const current = createMitigationDefinition({ ...old, source: { ...repository, repo: "renamed" } });
    expect(current.version).toBe(2);
    expect(current.id).not.toBe(old.id);
    expect(await store.saveMitigationDefinition(current)).toEqual(old);
    const topology = snapshot();
    await store.save(topology);
    const applied = application(topology, old.id);
    await store.saveMitigationApplication(applied);
    const oldEvent = { version: 1 as const, target: repository, applicationId: applied.id, state: "applied" as const, observedAt: appliedTime };
    const legacyEvent = { ...oldEvent, id: identity(["mitigation-application-event-v1", 1, repository, applied.id, "applied", null, null]) };
    await store.appendMitigationApplicationEvent(legacyEvent);
    const newEvent = createMitigationApplicationEvent({ ...oldEvent, observedAt: "2026-11-02T00:00:00Z" });
    await store.appendMitigationApplicationEvent(newEvent);
    expect(await store.listMitigationApplicationEvents(repository, applied.id, 10)).toEqual([legacyEvent, newEvent]);
    expect(await store.loadMitigationDefinition(repository, old.id)).toEqual(old);
  });

  it("imports a pinned recipe revision without treating compatibility counts or prose as measured facts", () => {
    const recipe: Recipe = {
      schemaVersion: 1, id: "shared-cache", revision: 3, title: "Use a shared cache", summary: "Share dependency artifacts.",
      risk: "medium", rules: ["caching/setup-cache"], files: [".github/workflows/**"],
      instructions: "Use bounded immutable keys.", evidence: { improvement: 0.9, metrics: [] },
      source: { repository: "acme/widgets", experiment: "cache-study", arm: "shared", pullRequest: 71 },
      patch: "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml", patchFiles: [".github/workflows/ci.yml"],
      compatibility: { passed: 999, failed: 0 },
    };
    const imported = mitigationDefinitionFromRecipe(repository, recipe);
    expect(imported).toMatchObject({ key: recipe.id, revision: recipe.revision, technologies: [], patchDigest: expect.any(String) });
    expect("compatibility" in imported).toBe(false);
    expect(mitigationDefinitionFromRecipe(repository, { ...recipe, compatibility: { passed: 0, failed: 9 } }).id).toBe(imported.id);
    expect(mitigationDefinitionFromRecipe(repository, { ...recipe, patch: `${recipe.patch}\nmore` }).id).not.toBe(imported.id);
  });

  it("stores versioned definitions immutably and scopes retrieval to the source repository", async () => {
    const store = getStore();
    const first = definition();
    await store.saveMitigationDefinition(first);
    await store.saveMitigationDefinition({ ...first, provenance: { ...first.provenance } });
    const renamed = createMitigationDefinition({ ...first, source: { ...repository, owner: "new-owner", repo: "renamed" } });
    expect(renamed.id).toBe(first.id);
    await store.saveMitigationDefinition(renamed);
    expect(await store.loadMitigationDefinition(repository, first.id)).toEqual(first);
    expect((await store.listMitigationDefinitions(repository, 10)).map((item) => item.id)).toEqual([first.id]);
    expect(await store.loadMitigationDefinition({ ...repository, repositoryId: "43" }, first.id)).toBeUndefined();
    await expect(store.listMitigationDefinitions(repository, 101)).rejects.toThrow("limit");
    const changed = definition({ summary: "Different immutable content." });
    await expect(store.saveMitigationDefinition(changed)).rejects.toThrow("different immutable content");
    const next = definition({ revision: 2 });
    await store.saveMitigationDefinition(next);
    expect(await store.listMitigationDefinitions(repository, 10)).toHaveLength(2);
  });

  it("retains repeated state occurrences and returns the latest bounded event history", async () => {
    const store = getStore();
    const topology = snapshot();
    const recipe = definition();
    await store.save(topology);
    await store.saveMitigationDefinition(recipe);
    const applied = application(topology, recipe.id);
    await store.saveMitigationApplication(applied);
    const events = ["proposed", "declined", "proposed"].map((state, index) => createMitigationApplicationEvent({
      target: repository, applicationId: applied.id, state: state as "proposed" | "declined",
      observedAt: `2026-11-0${index + 1}T00:00:00.000Z`,
    }));
    for (const event of events) await store.appendMitigationApplicationEvent(event);
    expect(new Set(events.map(({ id }) => id)).size).toBe(3);
    expect(await store.listMitigationApplicationEvents(repository, applied.id, 2)).toEqual(events.slice(1));
    expect(await store.listMitigationApplicationEvents(repository, applied.id, 0)).toEqual([]);
  });

  it("binds applications to a known recipe revision and target topology", async () => {
    const store = getStore();
    const topology = snapshot();
    const recipe = definition();
    await store.save(topology);
    await store.saveMitigationDefinition(recipe);
    const applied = application(topology, recipe.id);
    await store.saveMitigationApplication(applied);
    expect(await store.loadMitigationApplication(repository, applied.id)).toEqual(applied);
    expect((await store.listMitigationApplications(repository, 10)).map((item) => item.id)).toEqual([applied.id]);
    expect(await store.loadMitigationApplication({ ...repository, repositoryId: "43" }, applied.id)).toBeUndefined();
    await expect(store.saveMitigationApplication(application(topology, "f".repeat(64)))).rejects.toThrow("unknown definition");
    await expect(store.saveMitigationApplication(createMitigationApplication({
      target: repository, definitionId: recipe.id, topologySnapshotId: topology.id,
      projectIds: ["f".repeat(64)], change: applied.change, createdAt: applied.createdAt,
    }))).rejects.toThrow("topology snapshot");
  });

  it("appends application events and validates measured outcomes against linked immutable runs", async () => {
    const store = getStore();
    const topology = snapshot();
    const recipe = definition();
    await store.save(topology);
    await store.saveMitigationDefinition(recipe);
    const applied = application(topology, recipe.id);
    await store.saveMitigationApplication(applied);
    const proposed = createMitigationApplicationEvent({ target: repository, applicationId: applied.id, state: "proposed", observedAt: "2026-10-31T12:00:00.000Z" });
    const active = createMitigationApplicationEvent({ target: repository, applicationId: applied.id, state: "applied", observedAt: appliedTime });
    await store.appendMitigationApplicationEvent(proposed);
    await store.appendMitigationApplicationEvent(active);
    const samples = await normalizedSamples();
    for (const item of [...samples.control, ...samples.treatment]) await store.saveRunObservation(item);
    const evaluation = assessMitigation({
      application: applied, ...samples, metric: { kind: "workflow-duration", key: "workflow" }, evaluatedAt: evaluationTime,
    });
    expect(evaluation.outcome).toBe("observed-faster");
    expect(evaluation.pValue).toBeCloseTo(2 / 70);
    await store.saveMitigationEvaluation(evaluation);
    await store.saveMitigationEvaluation(evaluation);
    expect(await store.listMitigationApplicationEvents(repository, applied.id, 10)).toEqual([proposed, active]);
    expect(await store.listMitigationEvaluations(repository, applied.id, 10)).toEqual([evaluation]);
    const legacyEvaluation = createMitigationEvaluation({ ...evaluation, limitations: ["Observational comparison; does not establish causality."] });
    await store.saveMitigationEvaluation(legacyEvaluation);
    expect(await store.listMitigationEvaluations(repository, applied.id, 10)).toHaveLength(2);
    const maintenance = await store.maintain({ ...repository, mode: "prune", before: "2026-11-03T00:00:00.000Z" });
    expect(maintenance.counts).toMatchObject({ runs: 0, snapshots: 0, evaluations: 0 });
    expect(await store.listMitigationEvaluations({ ...repository, repositoryId: "43" }, applied.id, 10)).toEqual([]);
    await expect(store.listMitigationEvaluations(repository, applied.id, 101)).rejects.toThrow("limit");
    const incorrect = createMitigationEvaluation({
      target: evaluation.target, applicationId: evaluation.applicationId, evaluatedAt: evaluation.evaluatedAt,
      outcome: evaluation.outcome, metric: evaluation.metric, method: evaluation.method, contextKey: evaluation.contextKey,
      alpha: evaluation.alpha, controlObservationIds: evaluation.controlObservationIds,
      treatmentObservationIds: evaluation.treatmentObservationIds, controlMedianMs: evaluation.controlMedianMs! + 1,
      treatmentMedianMs: evaluation.treatmentMedianMs, pValue: evaluation.pValue,
      limitations: evaluation.limitations,
    });
    await expect(store.saveMitigationEvaluation(incorrect)).rejects.toThrow("statistics do not match");
    const purge = await store.maintain({ ...repository, mode: "purge" });
    expect(purge.counts).toMatchObject({ evaluations: 2, runs: 8, events: 2 });
    await store.maintain({ ...repository, mode: "purge", confirmation: purge.digest });
    expect(await store.listMitigationEvaluations(repository, applied.id, 10)).toEqual([]);
    expect(await store.listRunObservations({ ...repository, limit: 10 })).toEqual([]);
  });

  it("preserves unknown/inconclusive results without manufacturing a success", async () => {
    const store = getStore();
    const topology = snapshot();
    const recipe = definition();
    await store.save(topology);
    await store.saveMitigationDefinition(recipe);
    const applied = application(topology, recipe.id);
    await store.saveMitigationApplication(applied);
    const unknown = createMitigationEvaluation({
      target: repository, applicationId: applied.id, evaluatedAt: evaluationTime, outcome: "unknown",
      metric: { kind: "workflow-duration", key: "workflow" }, method: "distinct-run-mann-whitney-2s-v1",
      contextKey: "a".repeat(64), alpha: 0.05, controlObservationIds: [], treatmentObservationIds: [],
      limitations: ["No verifiable run evidence was available."],
    });
    await store.saveMitigationEvaluation(unknown);
    expect(await store.listMitigationEvaluations(repository, applied.id, 10)).toEqual([unknown]);
    const later = { ...unknown, evaluatedAt: new Date(now.getTime() + 1).toISOString() };
    expect(later.id).toBe(unknown.id);
  });

  it("computes both Mann-Whitney tails even when the sample medians are equal", () => {
    const control = [10, 20, 30, 40, 500].map((seconds, index) =>
      observation(21 + index, seconds, `2026-10-${20 + index}T00:00:00.000Z`));
    const treatment = [10, 20, 30, 40, 50].map((seconds, index) =>
      observation(31 + index, seconds, `2026-11-0${2 + index}T00:00:00.000Z`, "b".repeat(40)));
    const evaluation = assessMitigation({
      application: application(), control, treatment,
      metric: { kind: "workflow-duration", key: "workflow" }, evaluatedAt: "2026-11-08T00:00:00.000Z",
    });
    expect(evaluation.controlMedianMs).toBe(evaluation.treatmentMedianMs);
    expect(evaluation.pValue).toBeLessThan(1);
    expect(evaluation.outcome).toBe("no-detected-difference");
  });

  it("rejects retries, different contexts, unbracketed runs and application events without scoped records", async () => {
    const topology = snapshot();
    const recipe = definition();
    const applied = application(topology, recipe.id);
    const samples = await normalizedSamples();
    const retry = createRunObservation(repository, { ...samples.treatment[0]!.run, runAttempt: 2 }, unknownSource, new Date(samples.treatment[0]!.observedAt));
    await expect(Promise.resolve().then(() => assessMitigation({
      application: applied, control: samples.control, treatment: [retry, ...samples.treatment.slice(1)],
      metric: { kind: "workflow-duration", key: "workflow" },
    }))).rejects.toThrow("retries");
    await expect(Promise.resolve().then(() => assessMitigation({
      application: applied, control: samples.control, treatment: [samples.control[0]!, ...samples.treatment.slice(1)],
      metric: { kind: "workflow-duration", key: "workflow" },
    }))).rejects.toThrow("distinct logical runs");
    const unmatched = createRunObservation(repository, { ...samples.treatment[0]!.run, event: "schedule" }, unknownSource, new Date(samples.treatment[0]!.observedAt));
    await expect(Promise.resolve().then(() => assessMitigation({
      application: applied, control: samples.control, treatment: [unmatched, ...samples.treatment.slice(1)],
      metric: { kind: "workflow-duration", key: "workflow" },
    }))).rejects.toThrow("same eligible workload context");
    const beforeApplication = samples.treatment.map((item) => createRunObservation(repository, {
      ...item.run, startedAt: "2026-10-01T00:00:00.000Z", completedAt: "2026-10-01T00:01:00.000Z",
      jobs: item.run.jobs.map((job) => ({ ...job, startedAt: "2026-10-01T00:00:00.000Z", completedAt: "2026-10-01T00:01:00.000Z" })),
    }, unknownSource, new Date("2026-10-01T00:01:00.000Z")));
    await expect(Promise.resolve().then(() => assessMitigation({
      application: applied, control: samples.control, treatment: beforeApplication,
      metric: { kind: "workflow-duration", key: "workflow" },
    }))).rejects.toThrow("bracket the application");
    const store = getStore();
    const event = createMitigationApplicationEvent({
      target: repository, applicationId: applied.id, state: "applied", observedAt: appliedTime,
    });
    await expect(store.appendMitigationApplicationEvent(event)).rejects.toThrow("unknown target application");
  });
}
