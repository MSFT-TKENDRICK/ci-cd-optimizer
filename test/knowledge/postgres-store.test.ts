import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresKnowledgeStore } from "../../src/knowledge/postgres-store.js";
import { extractKnowledge } from "../../src/knowledge/extract.js";
import { snapshotIdentity } from "../../src/knowledge/identity.js";
import { createMitigationApplication, createMitigationDefinition } from "../../src/knowledge/mitigation.js";
import { createRunObservation, runObservationIdentity } from "../../src/knowledge/run-observation.js";
import { snapshot as workflow } from "../alerts/fixtures.js";
import { isolatedDatabase } from "../webhooks/database.js";
import { input, now, repository, revision, snapshot } from "./fixtures.js";
import { runWindowCases } from "./run-window-cases.js";
import { legacyDefinition, mitigationCases } from "./mitigation-cases.js";
import { maintenanceCases } from "./maintenance-cases.js";
import { executionCases } from "./execution-cases.js";

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
  runWindowCases(() => store);
  mitigationCases(() => store);
  maintenanceCases(() => store);
  executionCases(() => store);

  it("rolls every maintenance deletion back on failure and permits a complete retry", async () => {
    const project = snapshot();
    await store.save(project);
    const definition = await store.saveMitigationDefinition(legacyDefinition());
    const application = createMitigationApplication({
      target: repository, definitionId: definition.id, topologySnapshotId: project.id, projectIds: [project.projects[0]!.id],
      change: { kind: "commit", sha: revision }, createdAt: now.toISOString(),
    });
    await store.saveMitigationApplication(application);
    const plan = await store.maintain({ ...repository, mode: "purge" });
    await database.sql`CREATE FUNCTION reject_maintenance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-reject-maintenance'; END $$`;
    await database.sql`CREATE TRIGGER reject_maintenance BEFORE DELETE ON knowledge_snapshots FOR EACH ROW EXECUTE FUNCTION reject_maintenance()`;
    await expect(store.maintain({ ...repository, mode: "purge", confirmation: plan.digest })).rejects.toThrow("test-reject-maintenance");
    expect(await store.loadMitigationApplication(repository, application.id)).toEqual(application);
    expect(await store.loadMitigationDefinition(repository, definition.id)).toEqual(definition);
    expect(await store.load(repository, project.id)).toEqual(project);
    await database.sql`DROP TRIGGER reject_maintenance ON knowledge_snapshots`;
    await database.sql`DROP FUNCTION reject_maintenance()`;
    await store.maintain({ ...repository, mode: "purge", confirmation: plan.digest });
    expect(await store.load(repository, project.id)).toBeUndefined();
  });

  it("upgrades the legacy definition constraint without rewriting evidence identities", async () => {
    await database.sql`ALTER TABLE mitigation_definitions DROP CONSTRAINT mitigation_definitions_version_supported`;
    await database.sql`ALTER TABLE mitigation_definitions ADD CONSTRAINT mitigation_definitions_version_check CHECK (version = 1)`;
    const legacy = legacyDefinition();
    await store.saveMitigationDefinition(legacy);
    await store.initialize();
    await store.initialize();
    expect(await store.loadMitigationDefinition(repository, legacy.id)).toEqual(legacy);
    expect(await store.saveMitigationDefinition(createMitigationDefinition(legacy))).toEqual(legacy);
    const next = createMitigationDefinition({ ...legacy, revision: 2 });
    await Promise.all([store.saveMitigationDefinition(next), store.saveMitigationDefinition(next)]);
    expect(await store.loadMitigationDefinition(repository, next.id)).toEqual(next);
  });

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

  it("binds application projects to the application's exact topology snapshot", async () => {
    const topology = snapshot();
    const otherTopology = extractKnowledge(repository, "b".repeat(40), input(), { now: new Date(now.getTime() + 1000) });
    await store.save(topology);
    await store.save(otherTopology);
    const definition = createMitigationDefinition({
      source: repository, key: "topology-fk", revision: 1, title: "Test mitigation", summary: "Test topology binding.",
      instructions: "No-op test definition.", risk: "low", rules: [], files: [], technologies: [], contraindications: [],
      patchDigest: "c".repeat(64), provenance: {},
    });
    await store.saveMitigationDefinition(definition);
    const application = createMitigationApplication({
      target: repository, definitionId: definition.id, topologySnapshotId: topology.id, projectIds: [],
      change: { kind: "commit", sha: revision }, createdAt: now.toISOString(),
    });
    await store.saveMitigationApplication(application);
    await expect(database.sql`
      INSERT INTO mitigation_application_projects (application_id, host, repository_id, topology_snapshot_id, project_id)
      VALUES (${application.id}, ${repository.host}, ${repository.repositoryId}, ${otherTopology.id}, ${otherTopology.projects[0]!.id})
    `).rejects.toThrow("foreign key");
  });

  it("copies caller evidence before awaiting database I/O", async () => {
    const first = snapshot();
    const saving = store.save(first);
    first.projects.length = 0;
    first.repository.repo = "mutated";
    await saving;
    expect(await store.load(repository, first.id)).toEqual(snapshot());
  });

  it("atomically captures source and runtime context, deduplicates re-observation and preserves corrected attempts", async () => {
    const project = snapshot();
    const run = { ...workflow(100, 60, [["build", 60]]), headSha: revision };
    const first = createRunObservation(repository, run, { status: "linked", snapshotId: project.id }, now);
    await Promise.all([store.saveRunObservation(first, project), store.saveRunObservation(first, project)]);
    const later = createRunObservation(repository, { ...run, provenance: { ...run.provenance!, collectedAt: new Date(now.getTime() + 1000).toISOString() } },
      first.source, new Date(now.getTime() + 1000));
    expect(later.id).toBe(first.id);
    await store.saveRunObservation(later);
    expect(await store.loadRunObservation(repository, first.id)).toEqual(first);
    const corrected = createRunObservation(repository, { ...run, durationMs: 120_000 }, first.source, new Date(now.getTime() + 2000));
    await store.saveRunObservation(corrected);
    const retry = createRunObservation(repository, { ...run, runAttempt: 2, conclusion: "failure", jobs: [], queueMs: null },
      { status: "unavailable", reason: "revision-unavailable" }, new Date(now.getTime() + 3000));
    await store.saveRunObservation(retry);
    expect(await store.listRunObservations({ ...repository, runId: 100, runAttempt: 1, limit: 10 })).toHaveLength(2);
    expect((await store.listRunObservations({ ...repository, limit: 1 }))[0]).toMatchObject({ id: retry.id, runId: 100, workflowId: 7, runAttempt: 2 });
    expect(runObservationIdentity((await store.loadRunObservation(repository, corrected.id))!)).toBe(corrected.id);
    expect(await store.loadRunObservation({ ...repository, repositoryId: "43" }, first.id)).toBeUndefined();
    expect(await store.listRunObservations({ ...repository, host: "https://github.example.com", limit: 10 })).toEqual([]);
  });

  it("rolls source and runtime back together after a runtime insertion failure", async () => {
    const project = snapshot();
    const first = createRunObservation(repository, { ...workflow(100, 60, []), headSha: revision }, { status: "linked", snapshotId: project.id }, now);
    await database.sql`ALTER TABLE knowledge_run_observations ADD CONSTRAINT test_reject_run CHECK (run_id <> 100)`;
    await expect(store.saveRunObservation(first, project)).rejects.toThrow("test_reject_run");
    expect(await store.load(repository, project.id)).toBeUndefined();
    expect(await store.loadRunObservation(repository, first.id)).toBeUndefined();
    expect(await database.sql`SELECT id FROM knowledge_projects`).toHaveLength(0);
    await database.sql`ALTER TABLE knowledge_run_observations DROP CONSTRAINT test_reject_run`;
    await store.saveRunObservation(first, project);
    expect(await store.loadRunObservation(repository, first.id)).toEqual(first);
  });

  it("enforces same-repository and same-revision source references in the database", async () => {
    const project = snapshot();
    await store.save(project);
    const first = createRunObservation(repository, { ...workflow(100, 60, []), headSha: revision }, { status: "linked", snapshotId: project.id }, now);
    const wrongRepo = createRunObservation({ ...repository, repositoryId: "43" }, first.run, first.source, now);
    const wrongRevision = createRunObservation(repository, { ...first.run, headSha: "b".repeat(40) }, first.source, now);
    await expect(store.saveRunObservation(wrongRepo)).rejects.toThrow("foreign key");
    await expect(store.saveRunObservation(wrongRevision)).rejects.toThrow("foreign key");
    expect(await store.listRunObservations({ ...repository, limit: 10 })).toEqual([]);
    await store.saveRunObservation(first);
    const next = createRunObservation(repository, { ...first.run, runId: 101 }, first.source, now);
    const saving = store.saveRunObservation(next);
    next.run.durationMs = 999;
    await saving;
    expect((await store.loadRunObservation(repository, next.id))?.run.durationMs).toBe(60_000);
    expect((await store.listRunObservations({ ...repository, limit: 10 })).map((row) => row.runId).sort()).toEqual([100, 101]);
  });

  it("upgrades existing declaration evidence without rewriting or deleting its records", async () => {
    const project = snapshot();
    await store.save(project);
    await database.sql`DROP TABLE mitigation_application_events`;
    await database.sql`DROP TABLE mitigation_evaluation_samples`;
    await database.sql`DROP TABLE knowledge_execution_observations`;
    await database.sql`DROP TABLE knowledge_run_observations`;
    await database.sql`DROP INDEX knowledge_snapshot_reference`;
    await store.initialize();
    expect(await store.load(repository, project.id)).toEqual(project);
    const observation = createRunObservation(repository, { ...workflow(100, 60, []), headSha: revision }, { status: "linked", snapshotId: project.id }, now);
    await store.saveRunObservation(observation);
    expect(await store.loadRunObservation(repository, observation.id)).toEqual(observation);
  });
});
