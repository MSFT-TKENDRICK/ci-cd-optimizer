import { expect, it } from "vitest";
import { extractKnowledge } from "../../src/knowledge/extract.js";
import { createMitigationApplication, createMitigationApplicationEvent, createMitigationDefinition } from "../../src/knowledge/mitigation.js";
import { createRunObservation } from "../../src/knowledge/run-observation.js";
import type { KnowledgeSnapshot, KnowledgeStore } from "../../src/knowledge/types.js";
import { snapshot as workflow } from "../alerts/fixtures.js";
import { input, now, repository, snapshot } from "./fixtures.js";
import { legacyDefinition } from "./mitigation-cases.js";

const before = "2026-11-02T00:00:00.000Z";
const observed = (project: KnowledgeSnapshot, id: number, attempt = 1, capturedAt = now, seconds = 60) => createRunObservation(
  project.repository, { ...workflow(id, seconds, []), owner: project.repository.owner, repo: project.repository.repo, runAttempt: attempt, headSha: project.revision },
  { status: "linked", snapshotId: project.id }, capturedAt,
);

export function maintenanceCases(getStore: () => KnowledgeStore): void {
  it("previews without deleting and prunes whole unreferenced logical runs, not individual retries", async () => {
    const store = getStore();
    const project = snapshot();
    await store.save(project);
    const observations = [
      observed(project, 1), observed(project, 1, 2, new Date("2026-11-03T00:00:00.000Z")),
      observed(project, 2), observed(project, 2, 1, now, 61), observed(project, 3),
      observed(project, 4, 1, new Date(before)),
    ];
    for (const item of observations) await store.saveRunObservation(item);
    const definition = await store.saveMitigationDefinition(legacyDefinition());
    const application = createMitigationApplication({
      target: repository, definitionId: definition.id, topologySnapshotId: project.id, projectIds: [],
      change: { kind: "commit", sha: project.revision }, createdAt: "2026-10-31T00:00:00.000Z",
    });
    await store.saveMitigationApplication(application);
    await store.appendMitigationApplicationEvent(createMitigationApplicationEvent({
      target: repository, applicationId: application.id, state: "proposed", observedAt: now.toISOString(), runObservationId: observations[4]!.id,
    }));
    const request = { ...repository, mode: "prune" as const, before };
    const plan = await store.maintain(request);
    expect(plan).toMatchObject({ applied: false, counts: { runs: 2, snapshots: 0, events: 0, definitions: 0, applications: 0 } });
    expect(await store.listRunObservations({ ...repository, limit: 100 })).toHaveLength(6);
    expect(await store.maintain({ ...request, confirmation: plan.digest })).toEqual({ ...plan, applied: true });
    const remaining = await store.listRunObservations({ ...repository, limit: 100 });
    expect(remaining.map((item) => item.runId).sort()).toEqual([1, 1, 3, 4]);
    expect(await store.load(repository, project.id)).toEqual(project);
  });

  it("rejects a stale confirmation and never partially applies a changed plan", async () => {
    const store = getStore();
    const project = snapshot();
    await store.save(project);
    await store.saveRunObservation(observed(project, 1));
    const request = { ...repository, mode: "prune" as const, before };
    const plan = await store.maintain(request);
    expect(plan.counts).toMatchObject({ runs: 1, snapshots: 1 });
    await store.saveRunObservation(observed(project, 2));
    await expect(store.maintain({ ...request, confirmation: plan.digest })).rejects.toThrow("plan changed");
    expect(await store.listRunObservations({ ...repository, limit: 10 })).toHaveLength(2);
    expect(await store.load(repository, project.id)).toEqual(project);
    const fresh = await store.maintain(request);
    await store.maintain({ ...request, confirmation: fresh.digest });
    expect(await store.load(repository, project.id)).toBeUndefined();
    expect(await store.listRunObservations({ ...repository, limit: 10 })).toEqual([]);
  });

  it("makes cross-repository erasure explicit while preserving unrelated target evidence", async () => {
    const store = getStore();
    const project = snapshot();
    const foreignScope = { ...repository, repositoryId: "43", repo: "consumer" };
    const foreignProject = extractKnowledge(foreignScope, project.revision, input(), { now });
    await store.save(project);
    await store.save(foreignProject);
    await store.saveRunObservation(observed(project, 1));
    const foreignRun = observed(foreignProject, 2);
    await store.saveRunObservation(foreignRun);
    const sourceDefinition = await store.saveMitigationDefinition(legacyDefinition());
    const foreignDefinition = await store.saveMitigationDefinition(createMitigationDefinition({ ...legacyDefinition(), source: foreignScope }));
    const applications = [sourceDefinition, foreignDefinition].map((definition) => createMitigationApplication({
      target: foreignScope, definitionId: definition.id, topologySnapshotId: foreignProject.id, projectIds: [foreignProject.projects[0]!.id],
      change: { kind: "commit" as const, sha: foreignProject.revision }, createdAt: "2026-10-31T00:00:00.000Z",
    }));
    for (const application of applications) {
      await store.saveMitigationApplication(application);
      await store.appendMitigationApplicationEvent(createMitigationApplicationEvent({
        target: foreignScope, applicationId: application.id, state: "proposed", observedAt: now.toISOString(),
      }));
    }
    const request = { ...repository, mode: "purge" as const };
    const plan = await store.maintain(request);
    expect(plan).toMatchObject({
      applied: false, crossRepositoryApplications: 1,
      counts: { definitions: 1, applications: 1, events: 1, runs: 1, snapshots: 1, evaluations: 0 },
    });
    expect(await store.loadMitigationApplication(foreignScope, applications[0]!.id)).toBeDefined();
    await store.maintain({ ...request, confirmation: plan.digest });
    expect(await store.loadMitigationDefinition(repository, sourceDefinition.id)).toBeUndefined();
    expect(await store.loadMitigationApplication(foreignScope, applications[0]!.id)).toBeUndefined();
    expect(await store.listMitigationApplicationEvents(foreignScope, applications[0]!.id, 10)).toEqual([]);
    expect(await store.loadMitigationApplication(foreignScope, applications[1]!.id)).toEqual(applications[1]);
    expect(await store.load(foreignScope, foreignProject.id)).toEqual(foreignProject);
    expect(await store.loadRunObservation(foreignScope, foreignRun.id)).toEqual(foreignRun);
  });

  it("validates destructive inputs and never broadens scope to a different host", async () => {
    const store = getStore();
    await store.save(snapshot());
    await expect(store.maintain({ ...repository, mode: "purge", confirmation: "yes" })).rejects.toThrow("confirmation");
    await expect(store.maintain({ ...repository, mode: "prune" })).rejects.toThrow("cutoff");
    await expect(store.maintain({ ...repository, mode: "purge", before })).rejects.toThrow("cutoff");
    const plan = await store.maintain({ ...repository, host: "https://github.example.com", mode: "purge" });
    expect(Object.values(plan.counts).every((count) => count === 0)).toBe(true);
    expect(await store.load(repository, snapshot().id)).toBeDefined();
  });
}
