import { randomInt, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresTelemetryStore } from "../../src/telemetry/postgres-store.js";
import type { WorkflowSnapshot } from "../../src/telemetry/types.js";
import { snapshot } from "../alerts/fixtures.js";
import { isolatedDatabase } from "../webhooks/database.js";

const databaseUrl = process.env.DATABASE_URL;

// CI runs this against a Postgres service container (the `postgres` job); locally, set DATABASE_URL to opt in.
describe.skipIf(!databaseUrl)("PostgresTelemetryStore", () => {
  const owner = `test-${randomUUID()}`;
  const baseRunId = randomInt(1, 2 ** 40) * 100;
  let store: PostgresTelemetryStore;
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;

  function run(offset: number, branch: string | null, minute: number, conclusion = "success"): WorkflowSnapshot {
    const at = new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString();
    const base = snapshot(baseRunId + offset, 60 + offset, [["build", 30], ["test", 20, conclusion]], conclusion);
    return { ...base, owner, branch, createdAt: at, startedAt: at, completedAt: at };
  }

  beforeAll(async () => {
    database = await isolatedDatabase(databaseUrl!);
    store = new PostgresTelemetryStore(database.url);
    await store.initialize();
    await store.initialize();
  });

  afterAll(async () => {
    await store?.close();
    await database?.close();
  });

  it("round-trips snapshots and returns history oldest first per branch", async () => {
    const runs = [run(1, "main", 1), run(2, "feature", 2), run(3, null, 3), run(4, "main", 4), run(5, "main", 5)];
    runs[3]!.jobs[0]!.steps = [{ number: 1, name: "Checkout", conclusion: "success", startedAt: runs[3]!.startedAt, completedAt: runs[3]!.completedAt, durationMs: 1500 }];
    for (const item of [runs[4]!, runs[0]!, runs[2]!, runs[3]!, runs[1]!]) await store.save(item);

    const query = { owner, repo: "widgets", workflowId: 7, limit: 10 };
    expect(await store.history({ ...query, branch: "main" })).toEqual([runs[0], runs[3], runs[4]]);
    expect((await store.history({ ...query, branch: "main", limit: 2 })).map((item) => item.runId)).toEqual([runs[3]!.runId, runs[4]!.runId]);
    expect(await store.history({ ...query, branch: null })).toEqual([runs[2]]);
    expect((await store.history(query)).map((item) => item.runId)).toEqual(runs.map((item) => item.runId));
    expect(await store.history({ ...query, workflowId: 8 })).toEqual([]);
  });

  it("preserves attempts, idempotently corrects one attempt and rejects late downgrade", async () => {
    const first = run(10, "main", 10, "failure");
    const retried = { ...run(10, "main", 20), runAttempt: 2 };
    await store.save(first);
    await store.save(retried);
    await store.save(first);
    await store.save(first);

    const history = await store.history({ owner, repo: "widgets", workflowId: 7, branch: "main", limit: 50 });
    expect(history.filter((item) => item.runId === first.runId)).toEqual([retried]);
    const query = { owner, repo: "widgets", workflowId: 7, branch: "main", limit: 50 };
    expect((await store.history({ ...query, attempts: "all" })).filter((item) => item.runId === first.runId)).toEqual([first, retried]);
    const corrected = { ...retried, branch: "release", headSha: "corrected", workflowId: 8, event: "workflow_dispatch" };
    await store.save(corrected);
    expect((await store.history(query)).some((item) => item.runId === first.runId)).toBe(false);
    expect(await store.history({ ...query, branch: "release", workflowId: 8 })).toEqual([corrected]);
    expect((await store.history({ ...query, attempts: "all" })).filter((item) => item.runId === first.runId)).toEqual([first]);
  });

  it("isolates matching run IDs by owner/repo and applies limits after latest selection", async () => {
    const first = { ...run(20, "main", 30, "failure"), repo: "limits" };
    const retry = { ...first, runAttempt: 2, conclusion: "success" };
    const next = { ...run(21, "main", 31), repo: "limits" };
    const other = { ...first, owner: "another" };
    for (const item of [retry, first, next, other, { ...first, repo: "elsewhere" }]) await store.save(item);
    const query = { owner, repo: "limits", workflowId: 7, limit: 2 };
    expect(await store.history(query)).toEqual([retry, next]);
    expect(await store.history({ ...query, attempts: "all", limit: 3 })).toEqual([first, retry, next]);
    expect(await store.history({ ...query, attempts: "all" })).toEqual([retry, next]);
    expect(await store.history({ ...query, runId: first.runId, limit: 1 })).toEqual([retry]);
    expect(await store.history({ ...query, runId: first.runId, attempts: "all" })).toEqual([first, retry]);
    expect(await store.history({ ...query, owner: "another" })).toEqual([other]);
    expect(await store.history({ ...query, repo: "elsewhere" })).toEqual([{ ...first, repo: "elsewhere" }]);
    expect(await store.history({ ...query, limit: 0 })).toEqual([]);
    await expect(store.history({ ...query, limit: -1 })).rejects.toThrow("History limit");
    await expect(store.save({ ...first, runAttempt: 0 })).rejects.toThrow("Run attempt");
  });
});

describe.skipIf(!databaseUrl)("workflow snapshot schema migration", () => {
  async function legacy() {
    const db = await isolatedDatabase(databaseUrl!);
    await db.sql`
      CREATE TABLE workflow_run_snapshots (
        owner TEXT NOT NULL, repo TEXT NOT NULL, workflow_id BIGINT NOT NULL,
        run_id BIGINT CONSTRAINT legacy_run_identity PRIMARY KEY, run_attempt INTEGER NOT NULL,
        head_sha TEXT NOT NULL, branch TEXT, event TEXT NOT NULL, conclusion TEXT,
        created_at TIMESTAMPTZ NOT NULL, started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ NOT NULL,
        queue_ms BIGINT NOT NULL, duration_ms BIGINT NOT NULL, snapshot JSONB NOT NULL
      )
    `;
    const saved = { ...snapshot(9001, 100, [["build", 90]]), runAttempt: 3 };
    await db.sql`
      INSERT INTO workflow_run_snapshots VALUES (
        ${saved.owner}, ${saved.repo}, ${saved.workflowId}, ${saved.runId}, ${saved.runAttempt},
        ${saved.headSha}, ${saved.branch}, ${saved.event}, ${saved.conclusion},
        ${saved.createdAt}, ${saved.startedAt}, ${saved.completedAt}, ${saved.queueMs}, ${saved.durationMs},
        ${db.sql.json(JSON.parse(JSON.stringify(saved)) as postgres.JSONValue)}
      )
    `;
    return { ...db, saved };
  }

  const query = { owner: "acme", repo: "widgets", workflowId: 7, attempts: "all" as const, limit: 100 };

  it("serializes concurrent migrations, preserves legacy evidence and does not fabricate missing attempts", async () => {
    const db = await legacy();
    const stores = [new PostgresTelemetryStore(db.url), new PostgresTelemetryStore(db.url)];
    try {
      await Promise.all(stores.map((store) => store.initialize()));
      await Promise.all(stores.map((store) => store.initialize()));
      expect(await stores[0]!.history(query)).toEqual([db.saved]);
      const next = { ...db.saved, runAttempt: 4, conclusion: "failure", queueMs: null };
      await stores[0]!.save(next);
      await stores[1]!.save(db.saved);
      expect(await stores[1]!.history(query)).toEqual([db.saved, next]);
      expect(await stores[0]!.history({ ...query, attempts: "latest" })).toEqual([next]);
    } finally {
      await Promise.all(stores.map((store) => store.close()));
      await db.close();
    }
  });

  it("upgrades an attempt-keyed table to preserve unknown queue time without rewriting existing observations", async () => {
    const db = await legacy();
    const store = new PostgresTelemetryStore(db.url);
    try {
      await db.sql`ALTER TABLE workflow_run_snapshots DROP CONSTRAINT legacy_run_identity, ADD PRIMARY KEY (owner, repo, run_id, run_attempt)`;
      await store.initialize();
      const retry = { ...db.saved, runAttempt: 4, queueMs: null };
      await store.save(retry);
      expect(await store.history(query)).toEqual([db.saved, retry]);
      const rows = await db.sql`SELECT run_attempt, queue_ms FROM workflow_run_snapshots ORDER BY run_attempt`;
      expect(rows.map((row) => [row.run_attempt, row.queue_ms === null ? null : Number(row.queue_ms)])).toEqual([[3, 1000], [4, null]]);
      await store.initialize();
    } finally {
      await store.close();
      await db.close();
    }
  });

  it("fails explicitly on an unsupported schema without replacing its key or records", async () => {
    const db = await legacy();
    const store = new PostgresTelemetryStore(db.url);
    try {
      await db.sql`ALTER TABLE workflow_run_snapshots DROP CONSTRAINT legacy_run_identity, ADD PRIMARY KEY (owner, run_id)`;
      await expect(store.initialize()).rejects.toThrow("Unsupported workflow snapshot primary key");
      expect(await db.sql`SELECT snapshot FROM workflow_run_snapshots`).toEqual([{ snapshot: db.saved }]);
      const [key] = await db.sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'workflow_run_snapshots'::regclass AND contype = 'p'`;
      expect(key?.definition).toBe("PRIMARY KEY (owner, run_id)");
    } finally {
      await store.close();
      await db.close();
    }
  });

  it("rolls back a blocked migration and can retry after the external dependency is removed", async () => {
    const db = await legacy();
    const store = new PostgresTelemetryStore(db.url);
    try {
      await db.sql`CREATE TABLE external_reference (run_id BIGINT REFERENCES workflow_run_snapshots(run_id))`;
      await expect(store.initialize()).rejects.toThrow();
      expect(await db.sql`SELECT snapshot FROM workflow_run_snapshots`).toEqual([{ snapshot: db.saved }]);
      const [key] = await db.sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'workflow_run_snapshots'::regclass AND contype = 'p'`;
      expect(key?.definition).toBe("PRIMARY KEY (run_id)");
      await db.sql`DROP TABLE external_reference`;
      await store.initialize();
      expect(await store.history(query)).toEqual([db.saved]);
    } finally {
      await store.close();
      await db.close();
    }
  });
});
