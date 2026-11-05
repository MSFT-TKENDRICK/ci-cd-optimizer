import { beforeEach, describe, expect, it } from "vitest";
import { MemoryKnowledgeStore } from "../../src/knowledge/store.js";
import { identity, snapshotIdentity } from "../../src/knowledge/identity.js";
import { extractKnowledge } from "../../src/knowledge/extract.js";
import { input, now, repository, revision, snapshot } from "./fixtures.js";
import { mitigationCases } from "./mitigation-cases.js";
import { maintenanceCases } from "./maintenance-cases.js";
import { executionCases } from "./execution-cases.js";

describe("memory mitigation evidence", () => {
  let store: MemoryKnowledgeStore;
  beforeEach(() => { store = new MemoryKnowledgeStore(); });
  mitigationCases(() => store);
  maintenanceCases(() => store);
  executionCases(() => store);
});

describe("scoped immutable knowledge", () => {
  it("preserves first collection and protects stored evidence from caller mutation", async () => {
    const store = new MemoryKnowledgeStore();
    await store.initialize();
    const first = snapshot();
    await store.save(first);
    await store.save({ ...first, collectedAt: new Date(now.getTime() + 1000).toISOString() });
    first.projects.length = 0;
    const loaded = (await store.load(repository, first.id))!;
    expect(loaded).toEqual(snapshot());
    loaded.projects.length = 0;
    expect((await store.load(repository, first.id))?.projects).not.toHaveLength(0);
    expect(await store.load({ ...repository, repositoryId: "43" }, first.id)).toBeUndefined();
    expect(await store.load({ ...repository, host: "https://enterprise.example.com" }, first.id)).toBeUndefined();
  });

  it("scopes combined project/technology filters to the same project and bounds result count", async () => {
    const store = new MemoryKnowledgeStore();
    const first = snapshot();
    await store.save(first);
    const second = extractKnowledge(repository, "b".repeat(40), input(), { now: new Date(now.getTime() + 1000) });
    await store.save(second);
    const projectId = first.projects.find((project) => project.name === "@acme/a")!.id;
    expect(await store.list({ ...repository, projectId, technology: "turborepo", limit: 10 })).toEqual([]);
    expect((await store.list({ ...repository, technology: "turborepo", limit: 1 })).map((row) => row.id)).toEqual([second.id]);
    expect((await store.list({ ...repository, revision, limit: 10 })).map((row) => row.id)).toEqual([first.id]);
    expect(await store.list({ ...repository, limit: 0 })).toEqual([]);
    for (const limit of [-1, 101, 1.5, NaN]) await expect(store.list({ ...repository, limit })).rejects.toThrow("limit");
  });

  it("rejects modified identities and cross-snapshot references", async () => {
    const store = new MemoryKnowledgeStore();
    const changed = snapshot();
    changed.projects[0]!.path = "changed";
    await expect(store.save(changed)).rejects.toThrow("identity");
    const dangling = snapshot();
    dangling.relationships[0]!.from = "other-repository-project";
    dangling.relationships[0]!.id = identity(Object.fromEntries(Object.entries(dangling.relationships[0]!).filter(([key]) => key !== "id")));
    dangling.id = snapshotIdentity(dangling);
    await expect(store.save(dangling)).rejects.toThrow("same snapshot");
    expect(await store.list({ ...repository, limit: 10 })).toEqual([]);
  });
});
