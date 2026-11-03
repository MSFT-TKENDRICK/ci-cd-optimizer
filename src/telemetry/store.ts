import postgres, { type Sql } from "postgres";
import type { WorkflowBaseline, WorkflowSnapshot } from "../types.js";

export interface TelemetryStore {
  initialize(): Promise<void>;
  save(snapshot: WorkflowSnapshot): Promise<void>;
  baseline(snapshot: WorkflowSnapshot, limit?: number): Promise<WorkflowBaseline | undefined>;
}

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

  async baseline(
    snapshot: WorkflowSnapshot,
    limit = 20,
  ): Promise<WorkflowBaseline | undefined> {
    const rows = await this.sql<{ duration_ms: string; queue_ms: string }[]>`
      SELECT duration_ms, queue_ms
      FROM workflow_run_snapshots
      WHERE owner = ${snapshot.owner}
        AND repo = ${snapshot.repo}
        AND workflow_id = ${snapshot.workflowId}
        AND branch IS NOT DISTINCT FROM ${snapshot.branch}
        AND run_id <> ${snapshot.runId}
        AND conclusion = 'success'
      ORDER BY completed_at DESC
      LIMIT ${limit}
    `;
    if (rows.length === 0) return undefined;

    return {
      sampleCount: rows.length,
      medianDurationMs: median(rows.map((row) => Number(row.duration_ms))),
      medianQueueMs: median(rows.map((row) => Number(row.queue_ms))),
    };
  }
}

export class MemoryTelemetryStore implements TelemetryStore {
  readonly snapshots: WorkflowSnapshot[] = [];

  async initialize(): Promise<void> {}

  async save(snapshot: WorkflowSnapshot): Promise<void> {
    const index = this.snapshots.findIndex((item) => item.runId === snapshot.runId);
    if (index >= 0) this.snapshots[index] = snapshot;
    else this.snapshots.push(snapshot);
  }

  async baseline(snapshot: WorkflowSnapshot, limit = 20): Promise<WorkflowBaseline | undefined> {
    const history = this.snapshots
      .filter(
        (item) =>
          item.runId !== snapshot.runId &&
          item.owner === snapshot.owner &&
          item.repo === snapshot.repo &&
          item.workflowId === snapshot.workflowId &&
          item.branch === snapshot.branch &&
          item.conclusion === "success",
      )
      .slice(-limit);
    if (history.length === 0) return undefined;
    return {
      sampleCount: history.length,
      medianDurationMs: median(history.map((item) => item.durationMs)),
      medianQueueMs: median(history.map((item) => item.queueMs)),
    };
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) return 0;
  if (sorted.length % 2 === 1) return value;
  return ((sorted[middle - 1] ?? value) + value) / 2;
}
