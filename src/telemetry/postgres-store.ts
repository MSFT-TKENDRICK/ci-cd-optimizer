import postgres, { type Sql } from "postgres";
import type { HistoryQuery, TelemetryStore } from "./store.js";
import type { WorkflowSnapshot } from "./types.js";
import { validateHistoryQuery, validateRunAttempt } from "./history.js";

/** Snapshots in Postgres (`DATABASE_URL`), for the hosted GitHub App. */
export class PostgresTelemetryStore implements TelemetryStore {
  private readonly sql: Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      transform: { undefined: null },
    });
  }

  async initialize(): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`SET LOCAL lock_timeout = '10s'`;
      await sql`SET LOCAL statement_timeout = '60s'`;
      await sql`SELECT pg_advisory_xact_lock(hashtext('ci-cd-optimizer:telemetry-schema'))`;
      await sql`
        CREATE TABLE IF NOT EXISTS workflow_run_snapshots (
          owner TEXT NOT NULL,
          repo TEXT NOT NULL,
          workflow_id BIGINT NOT NULL,
          run_id BIGINT NOT NULL,
          run_attempt INTEGER NOT NULL,
          head_sha TEXT NOT NULL,
          branch TEXT,
          event TEXT NOT NULL,
          conclusion TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          started_at TIMESTAMPTZ NOT NULL,
          completed_at TIMESTAMPTZ NOT NULL,
          queue_ms BIGINT NOT NULL,
          duration_ms BIGINT NOT NULL,
          snapshot JSONB NOT NULL,
          PRIMARY KEY (owner, repo, run_id, run_attempt)
        )
      `;
      const [key] = await sql<{ conname: string; definition: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'workflow_run_snapshots'::regclass AND contype = 'p'
      `;
      if (key?.definition === "PRIMARY KEY (run_id)") {
        await sql`
          ALTER TABLE workflow_run_snapshots
          DROP CONSTRAINT ${sql(key.conname)},
          ADD PRIMARY KEY (owner, repo, run_id, run_attempt)
        `;
      } else if (key?.definition !== "PRIMARY KEY (owner, repo, run_id, run_attempt)") {
        throw new Error(`Unsupported workflow snapshot primary key: ${key?.definition ?? "missing"}`);
      }
      await sql`
        CREATE INDEX IF NOT EXISTS workflow_run_snapshots_history
        ON workflow_run_snapshots (owner, repo, workflow_id, branch, completed_at DESC)
      `;
    });
  }

  async save(snapshot: WorkflowSnapshot): Promise<void> {
    validateRunAttempt(snapshot.runAttempt);
    await this.sql`
      INSERT INTO workflow_run_snapshots (
        owner, repo, workflow_id, run_id, run_attempt, head_sha, branch, event,
        conclusion, created_at, started_at, completed_at, queue_ms, duration_ms, snapshot
      ) VALUES (
        ${snapshot.owner}, ${snapshot.repo}, ${snapshot.workflowId}, ${snapshot.runId},
        ${snapshot.runAttempt}, ${snapshot.headSha}, ${snapshot.branch}, ${snapshot.event},
        ${snapshot.conclusion}, ${snapshot.createdAt}, ${snapshot.startedAt},
        ${snapshot.completedAt}, ${snapshot.queueMs}, ${snapshot.durationMs},
        ${this.sql.json(JSON.parse(JSON.stringify(snapshot)) as postgres.JSONValue)}
      )
      ON CONFLICT (owner, repo, run_id, run_attempt) DO UPDATE SET
        workflow_id = EXCLUDED.workflow_id,
        head_sha = EXCLUDED.head_sha,
        branch = EXCLUDED.branch,
        event = EXCLUDED.event,
        created_at = EXCLUDED.created_at,
        started_at = EXCLUDED.started_at,
        conclusion = EXCLUDED.conclusion,
        completed_at = EXCLUDED.completed_at,
        queue_ms = EXCLUDED.queue_ms,
        duration_ms = EXCLUDED.duration_ms,
        snapshot = EXCLUDED.snapshot
    `;
  }

  async history(query: HistoryQuery): Promise<WorkflowSnapshot[]> {
    validateHistoryQuery(query);
    if (query.limit === 0) return [];
    const branchFilter =
      query.branch === undefined ? this.sql`` : this.sql`AND branch IS NOT DISTINCT FROM ${query.branch}`;
    const rows = await this.sql<{ snapshot: WorkflowSnapshot }[]>`
      WITH attempts AS (
        SELECT ${query.attempts === "all" ? this.sql`` : this.sql`DISTINCT ON (run_id)`}
          workflow_id, branch, completed_at, run_id, run_attempt, snapshot
        FROM workflow_run_snapshots
        WHERE owner = ${query.owner} AND repo = ${query.repo}
          ${query.runId === undefined ? this.sql`` : this.sql`AND run_id = ${query.runId}`}
        ORDER BY run_id, run_attempt DESC
      )
      SELECT snapshot
      FROM attempts
      WHERE workflow_id = ${query.workflowId}
        ${branchFilter}
      ORDER BY completed_at DESC, run_id DESC, run_attempt DESC
      LIMIT ${query.limit}
    `;
    return rows.map((row) => row.snapshot).reverse();
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
