import postgres, { type Sql } from "postgres";
import type { HistoryQuery, TelemetryStore } from "./store.js";
import type { WorkflowSnapshot } from "./types.js";

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
    await this.sql`
      CREATE TABLE IF NOT EXISTS workflow_run_snapshots (
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        workflow_id BIGINT NOT NULL,
        run_id BIGINT PRIMARY KEY,
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
        snapshot JSONB NOT NULL
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS workflow_run_snapshots_history
      ON workflow_run_snapshots (owner, repo, workflow_id, branch, completed_at DESC)
    `;
  }

  async save(snapshot: WorkflowSnapshot): Promise<void> {
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
      ON CONFLICT (run_id) DO UPDATE SET
        run_attempt = EXCLUDED.run_attempt,
        conclusion = EXCLUDED.conclusion,
        completed_at = EXCLUDED.completed_at,
        queue_ms = EXCLUDED.queue_ms,
        duration_ms = EXCLUDED.duration_ms,
        snapshot = EXCLUDED.snapshot
    `;
  }

  async history(query: HistoryQuery): Promise<WorkflowSnapshot[]> {
    const branchFilter =
      query.branch === undefined ? this.sql`` : this.sql`AND branch IS NOT DISTINCT FROM ${query.branch}`;
    const rows = await this.sql<{ snapshot: WorkflowSnapshot }[]>`
      SELECT snapshot
      FROM workflow_run_snapshots
      WHERE owner = ${query.owner}
        AND repo = ${query.repo}
        AND workflow_id = ${query.workflowId}
        ${branchFilter}
      ORDER BY completed_at DESC, run_id DESC
      LIMIT ${query.limit}
    `;
    return rows.map((row) => row.snapshot).reverse();
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
