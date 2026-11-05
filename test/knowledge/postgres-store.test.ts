import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresKnowledgeStore } from "../../src/knowledge/postgres-store.js";
import { extractKnowledge } from "../../src/knowledge/extract.js";
import { snapshotIdentity } from "../../src/knowledge/identity.js";
import { isolatedDatabase } from "../webhooks/database.js";
import { input, now, repository, revision, snapshot } from "./fixtures.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("normalized Postgres knowledge", () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let store: PostgresKnowledgeStore;
  beforeEach(async () => {
    database = await isolatedDatabase(databaseUrl!);
    store = new PostgresKnowledgeStore(database.url);
    await store.initialize();
  });
  afterEach(async () => { await store?.close(); await database?.close(); });

  it("round-trips normalized evidence including JSONB canonicalization across repeated/concurrent initialization", async () => {
    const other = new PostgresKnowledgeStore(database.url);
    try {
      await Promise.all([store.initialize(), other.initialize()]);
      const first = snapshot();
      await Promise.all([store.save(first), other.save(first)]);
      await other.save({ ...first, collectedAt: new Date(now.getTime() + 1000).toISOString() });
      const loaded = (await store.load(repository, first.id))!;
      expect(loaded).toEqual(first);
      expect(snapshotIdentity(loaded)).toBe(first.id);
      await store.save(loaded);
      expect(await store.list({ ...repository, limit: 10 })).toHaveLength(1);
    } finally { await other.close(); }
  });

  it("isolates hosts and repositories and combines technology/project filters", async () => {
    const first = snapshot();
    const second = extractKnowledge(repository, "b".repeat(40), input(), { now: new Date(now.getTime() + 1000) });
    await store.save(first);
    await store.save(second);
    await store.save(extractKnowledge({ ...repository, repositoryId: "43" }, revision, input(), { now }));
    expect(await store.load({ ...repository, repositoryId: "43" }, first.id)).toBeUndefined();
    expect(await store.load({ ...repository, host: "https://github.example.com" }, first.id)).toBeUndefined();
    expect((await store.list({ ...repository, revision, limit: 10 })).map((row) => row.id)).toEqual([first.id]);
    const projectId = first.projects.find((project) => project.name === "@acme/a")!.id;
    expect(await store.list({ ...repository, projectId, technology: "turborepo", limit: 10 })).toEqual([]);
    expect((await store.list({ ...repository, technology: "nx", limit: 1 })).map((row) => row.id)).toEqual([second.id]);
    expect(await store.list({ ...repository, limit: 0 })).toEqual([]);
    await expect(store.list({ ...repository, limit: 101 })).rejects.toThrow("limit");
  });

  it("rolls back every table on a mid-write failure and permits a complete retry", async () => {
    await database.sql`ALTER TABLE knowledge_technologies ADD CONSTRAINT test_reject_nx CHECK (technology <> 'nx')`;
    const first = snapshot();
    await expect(store.save(first)).rejects.toThrow("test_reject_nx");
    expect(await store.load(repository, first.id)).toBeUndefined();
    expect(await database.sql`SELECT id FROM knowledge_projects`).toHaveLength(0);
    await database.sql`ALTER TABLE knowledge_technologies DROP CONSTRAINT test_reject_nx`;
    await store.save(first);
    expect(await store.load(repository, first.id)).toEqual(first);
  });

  it("enforces snapshot-scoped foreign keys rather than linking to another observation", async () => {
    const first = snapshot();
    const other = extractKnowledge({ ...repository, repositoryId: "43" }, revision, input(), { now });
    await store.save(first);
    await store.save(other);
    await expect(database.sql`
      UPDATE knowledge_relationships SET target_project_id = ${other.projects[0]!.id}
      WHERE snapshot_id = ${first.id}
    `).rejects.toThrow("foreign key");
  });
});
