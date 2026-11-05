import { describe, expect, it } from "vitest";
import { createRunObservation, runObservationIdentity } from "../../src/knowledge/run-observation.js";
import { MemoryKnowledgeStore } from "../../src/knowledge/store.js";
import { snapshot as workflow } from "../alerts/fixtures.js";
import { now, repository, revision, snapshot } from "./fixtures.js";

const run = () => ({ ...workflow(100, 60, [["build", 50], ["test", 10]]), headSha: revision });
const observed = (project = snapshot()) => createRunObservation(repository, run(), { status: "linked", snapshotId: project.id }, now);

describe("immutable run observations", () => {
  it("deduplicates collection-time and API-order differences, not corrected facts", async () => {
    const store = new MemoryKnowledgeStore();
    const project = snapshot();
    const first = observed(project);
    const reordered = { ...run(), jobs: run().jobs.reverse(), provenance: { ...run().provenance!, collectedAt: new Date(now.getTime() + 2000).toISOString() } };
    const repeat = createRunObservation(repository, reordered, first.source, new Date(now.getTime() + 1000));
    expect(repeat.id).toBe(first.id);
    await store.saveRunObservation(first, project);
    await store.saveRunObservation(repeat);
    const corrected = createRunObservation(repository, { ...run(), durationMs: 99_000 }, first.source, new Date(now.getTime() + 3000));
    await store.saveRunObservation(corrected);
    expect(await store.loadRunObservation(repository, first.id)).toEqual(first);
    expect(await store.listRunObservations({ ...repository, runId: 100, runAttempt: 1, limit: 10 })).toHaveLength(2);
    expect((await store.listRunObservations({ ...repository, limit: 1 }))[0]?.id).toBe(corrected.id);
  });

  it("retains retries, failures and missing source without resurrecting or rewriting older observations", async () => {
    const store = new MemoryKnowledgeStore();
    const first = observed();
    await store.saveRunObservation(first, snapshot());
    const retry = createRunObservation(repository, { ...run(), runAttempt: 2, conclusion: "failure", jobs: [], queueMs: null },
      { status: "unavailable", reason: "revision-unavailable" }, now);
    await store.saveRunObservation(retry);
    expect(await store.listRunObservations({ ...repository, runId: 100, limit: 10 })).toHaveLength(2);
    expect((await store.listRunObservations({ ...repository, runId: 100, runAttempt: 2, limit: 10 }))[0]?.source.status).toBe("unavailable");
    expect(await store.loadRunObservation(repository, retry.id)).toEqual(retry);
  });

  it("atomically rejects missing, cross-repository or wrong-revision project context", async () => {
    const store = new MemoryKnowledgeStore();
    await expect(store.saveRunObservation(observed())).rejects.toThrow("same repository");
    const wrongRevision = createRunObservation(repository, { ...run(), headSha: "b".repeat(40) }, observed().source, now);
    await expect(store.saveRunObservation(wrongRevision, snapshot())).rejects.toThrow("source revision");
    const crossRepo = createRunObservation({ ...repository, repositoryId: "43" }, run(), observed().source, now);
    await expect(store.saveRunObservation(crossRepo, snapshot())).rejects.toThrow("same repository");
    expect(await store.list({ ...repository, limit: 10 })).toEqual([]);
    expect(await store.listRunObservations({ ...repository, limit: 10 })).toEqual([]);
  });

  it("isolates reads and protects both source and runtime observations from caller mutation", async () => {
    const store = new MemoryKnowledgeStore();
    const project = snapshot();
    const first = observed(project);
    await store.saveRunObservation(first, project);
    first.run.jobs.length = 0;
    project.projects.length = 0;
    const loaded = (await store.loadRunObservation(repository, first.id))!;
    expect(loaded.run.jobs).toHaveLength(2);
    loaded.run.jobs.length = 0;
    expect((await store.loadRunObservation(repository, first.id))?.run.jobs).toHaveLength(2);
    expect(await store.loadRunObservation({ ...repository, repositoryId: "43" }, first.id)).toBeUndefined();
    expect(await store.listRunObservations({ ...repository, host: "https://github.example.com", limit: 10 })).toEqual([]);
    expect((await store.load(repository, snapshot().id))?.projects.length).toBeGreaterThan(0);
  });

  it("rejects invalid measurements, identities and query bounds", async () => {
    for (const values of [{ runId: 0 }, { workflowId: -1 }, { runAttempt: 1.5 }, { durationMs: NaN }, { queueMs: -1 }, { completedAt: "invalid" }]) {
      expect(() => createRunObservation(repository, { ...run(), ...values }, observed().source, now)).toThrow();
    }
    const store = new MemoryKnowledgeStore();
    const changed = observed();
    changed.run.durationMs += 1;
    await expect(store.saveRunObservation(changed, snapshot())).rejects.toThrow("identity");
    expect(runObservationIdentity(changed)).not.toBe(changed.id);
    for (const query of [{ limit: -1 }, { limit: 101 }, { limit: 1, runAttempt: 2 }, { limit: 1, runId: 0 }]) {
      await expect(store.listRunObservations({ ...repository, ...query })).rejects.toThrow();
    }
  });
});
