import postgres, { type Sql } from "postgres";
import type { Probot } from "probot";

export type Delivery = Parameters<Probot["receive"]>[0];
export type WorkResult =
  | { status: "idle" }
  | { status: "completed"; id: string; scope: string; attempts: number }
  | { status: "retrying" | "failed"; id: string; scope: string; attempts: number; error: string };

export interface DeliveryQueue {
  enqueue(delivery: Delivery): Promise<void>;
  processNext(handler: (delivery: Delivery) => Promise<void>): Promise<WorkResult>;
}

function scope(fullName: string, checks = false): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new Error("Webhook repository must have a valid owner/name");
  return `${fullName.toLowerCase()}:${checks ? "checks" : "mutations"}`;
}

/** Split installation deliveries so a single job never needs locks for several repositories. */
export function deliveryJobs(delivery: Delivery): Array<{ scope: string; delivery: Delivery }> {
  if (delivery.name === "installation") {
    return (delivery.payload.repositories ?? []).map((repo) => ({
      scope: scope(repo.full_name),
      delivery: { ...delivery, payload: { ...delivery.payload, repositories: [repo] } },
    }));
  }
  if (delivery.name === "installation_repositories") {
    return delivery.payload.repositories_added.map((repo) => ({
      scope: scope(repo.full_name),
      delivery: { ...delivery, payload: { ...delivery.payload, repositories_added: [repo] } },
    }));
  }
  if (!("repository" in delivery.payload) || !delivery.payload.repository) throw new Error("Webhook has no repository");
  return [{
    scope: scope(delivery.payload.repository.full_name, delivery.name === "pull_request" || delivery.name === "check_run"),
    delivery,
  }];
}

/** At-least-once processing; a transaction holds the scope lock until the job's result is committed. */
export class PostgresWebhookQueue implements DeliveryQueue {
  private readonly sql: Sql;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(databaseUrl: string, { maxAttempts = 5, retryDelayMs = 30_000 }: { maxAttempts?: number; retryDelayMs?: number } = {}) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error("maxAttempts must be an integer from 1 to 100");
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 900_000) throw new Error("retryDelayMs must be from 0 to 900000");
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
    this.sql = postgres(databaseUrl, { max: 5, idle_timeout: 20, connect_timeout: 10 });
  }

  async initialize(): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('ci-cd-optimizer:webhook-schema', 0))`;
      await sql`CREATE TABLE IF NOT EXISTS webhook_scopes (scope TEXT PRIMARY KEY)`;
      await sql`
        CREATE TABLE IF NOT EXISTS webhook_jobs (
          sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          delivery_id TEXT NOT NULL,
          scope TEXT NOT NULL REFERENCES webhook_scopes(scope),
          delivery JSONB,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          completed_at TIMESTAMPTZ,
          last_error TEXT,
          UNIQUE (delivery_id, scope)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS webhook_jobs_pending ON webhook_jobs (scope, sequence) WHERE status = 'pending'`;
    });
  }

  async enqueue(delivery: Delivery): Promise<void> {
    if (!delivery.id.trim()) throw new Error("Webhook delivery ID is required");
    const jobs = deliveryJobs(delivery).map((job) => ({ delivery_id: delivery.id, ...job }));
    const records = JSON.parse(JSON.stringify(jobs)) as postgres.JSONValue;
    await this.sql.begin(async (sql) => {
      await sql`
        INSERT INTO webhook_scopes (scope)
        SELECT DISTINCT scope FROM jsonb_to_recordset(${sql.json(records)}) AS job(scope TEXT)
        ORDER BY scope ON CONFLICT DO NOTHING
      `;
      await sql`
        INSERT INTO webhook_jobs (delivery_id, scope, delivery)
        SELECT delivery_id, scope, delivery
        FROM jsonb_to_recordset(${sql.json(records)}) AS job(delivery_id TEXT, scope TEXT, delivery JSONB)
        ORDER BY scope ON CONFLICT (delivery_id, scope) DO NOTHING
      `;
      // A duplicate of a running job must not wait for that job's row lock.
      await sql`
        UPDATE webhook_jobs SET status = 'pending', attempts = 0, available_at = clock_timestamp(), last_error = NULL
        WHERE delivery_id = ${delivery.id} AND status = 'failed'
          AND scope IN (SELECT scope FROM jsonb_to_recordset(${sql.json(records)}) AS job(scope TEXT))
      `;
    });
  }

  async processNext(handler: (delivery: Delivery) => Promise<void>): Promise<WorkResult> {
    return await this.sql.begin(async (sql): Promise<WorkResult> => {
      const scopes = await sql<{ scope: string }[]>`
        SELECT s.scope FROM webhook_scopes s
        CROSS JOIN LATERAL (
          SELECT sequence, available_at FROM webhook_jobs
          WHERE scope = s.scope AND status = 'pending'
          ORDER BY sequence LIMIT 1
        ) head
        WHERE head.available_at <= clock_timestamp()
        ORDER BY head.sequence
        LIMIT 1 FOR NO KEY UPDATE OF s SKIP LOCKED
      `;
      const key = scopes[0]?.scope;
      if (!key) return { status: "idle" };
      // NO KEY UPDATE permits enqueue's foreign-key check while excluding other workers in this scope.
      const rows = await sql<{ sequence: string; delivery_id: string; delivery: Delivery; attempts: number }[]>`
        SELECT sequence, delivery_id, delivery, attempts FROM webhook_jobs
        WHERE scope = ${key} AND status = 'pending' ORDER BY sequence LIMIT 1 FOR UPDATE
      `;
      const job = rows[0];
      if (!job) throw new Error("Locked webhook scope has no pending job");
      const attempts = job.attempts + 1;
      const result = { id: job.delivery_id, scope: key, attempts };
      try {
        await handler(job.delivery);
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
        const status = attempts >= this.maxAttempts ? "failed" : "pending";
        const delayMs = Math.min(this.retryDelayMs * 2 ** (attempts - 1), 900_000);
        await sql`
          UPDATE webhook_jobs SET status = ${status}, attempts = ${attempts}, last_error = ${message},
            available_at = clock_timestamp() + ${delayMs} * interval '1 millisecond'
          WHERE sequence = ${job.sequence}
        `;
        return { ...result, status: status === "failed" ? "failed" : "retrying", error: message };
      }
      await sql`
        UPDATE webhook_jobs SET status = 'completed', attempts = ${attempts},
          completed_at = clock_timestamp(), delivery = NULL, last_error = NULL
        WHERE sequence = ${job.sequence}
      `;
      return { ...result, status: "completed" };
    });
  }

  async status(id: string): Promise<Array<{ scope: string; status: string; attempts: number; last_error: string | null }>> {
    return await this.sql<{ scope: string; status: string; attempts: number; last_error: string | null }[]>`
      SELECT scope, status, attempts, last_error FROM webhook_jobs WHERE delivery_id = ${id} ORDER BY scope
    `;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
