import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresWebhookQueue, type Delivery } from "../../src/webhooks/postgres-queue.js";
import { isolatedDatabase } from "./database.js";

const databaseUrl = process.env.DATABASE_URL;
// Minimal envelopes for storage tests; HTTP tests separately exercise full Probot routing.
const push = (repo = "acme/widgets"): Delivery => ({
  id: randomUUID(), name: "push", payload: { repository: { full_name: repo } },
} as Delivery);
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe.skipIf(!databaseUrl)("durable Postgres webhook queue", () => {
  let db: Awaited<ReturnType<typeof isolatedDatabase>>;
  const queues: PostgresWebhookQueue[] = [];
  const queue = (options?: ConstructorParameters<typeof PostgresWebhookQueue>[1]) => {
    const result = new PostgresWebhookQueue(db.url, options);
    queues.push(result);
    return result;
  };
  beforeAll(async () => {
    db = await isolatedDatabase(databaseUrl!);
    await queue().initialize();
    await queue().initialize();
  });
  afterEach(async () => {
    for (const item of queues.splice(0)) await item.close();
    await db.sql`DELETE FROM webhook_jobs`;
    await db.sql`DELETE FROM webhook_scopes`;
  });
  afterAll(async () => { await db?.close(); });

  it("persists accepted work across a connection restart and clears completed payloads", async () => {
    const first = queue();
    const event = push();
    await first.enqueue(event);
    await first.close();
    const restarted = queue();
    const handler = vi.fn(async () => undefined);
    expect(await restarted.processNext(handler)).toMatchObject({ status: "completed", id: event.id, attempts: 1 });
    expect(handler).toHaveBeenCalledWith(event);
    expect(await restarted.status(event.id)).toMatchObject([{ status: "completed", last_error: null }]);
    expect((await db.sql`SELECT delivery FROM webhook_jobs`)[0]?.delivery).toBeNull();
  });

  it("deduplicates pending and completed redeliveries", async () => {
    const worker = queue();
    const event = push();
    await Promise.all([worker.enqueue(event), worker.enqueue(event)]);
    const handler = vi.fn(async () => undefined);
    expect((await worker.processNext(handler)).status).toBe("completed");
    await worker.enqueue(event);
    expect((await worker.processNext(handler)).status).toBe("idle");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("backs off failed jobs and preserves FIFO within their scope", async () => {
    const worker = queue();
    const first = push();
    const second = push();
    await worker.enqueue(first);
    await worker.enqueue(second);
    expect(await worker.processNext(async () => { throw new Error("GitHub unavailable"); })).toMatchObject({ status: "retrying", attempts: 1 });
    expect((await worker.processNext(async () => undefined)).status).toBe("idle");
    const other = push("acme/other");
    await worker.enqueue(other);
    expect(await worker.processNext(async () => undefined)).toMatchObject({ id: other.id, status: "completed" });
    await db.sql`UPDATE webhook_jobs SET available_at = clock_timestamp() - interval '1 second' WHERE delivery_id = ${first.id}`;
    expect(await worker.processNext(async () => undefined)).toMatchObject({ id: first.id, attempts: 2 });
    expect(await worker.processNext(async () => undefined)).toMatchObject({ id: second.id, attempts: 1 });
  });

  it("dead-letters exhausted jobs and permits explicit GitHub redelivery to retry them", async () => {
    const worker = queue({ maxAttempts: 2, retryDelayMs: 0 });
    const event = push();
    await worker.enqueue(event);
    const fail = async () => { throw new Error("Denied"); };
    expect((await worker.processNext(fail)).status).toBe("retrying");
    expect((await worker.processNext(fail)).status).toBe("failed");
    expect((await worker.processNext(fail)).status).toBe("idle");
    expect(await worker.status(event.id)).toMatchObject([{ status: "failed", attempts: 2, last_error: "Denied" }]);
    await worker.enqueue(event);
    expect(await worker.processNext(async () => undefined)).toMatchObject({ status: "completed", attempts: 1 });
  });

  it("coordinates separate workers without blocking ingress or unrelated repositories", async () => {
    const one = queue();
    const two = queue();
    const event = push();
    await one.enqueue(event);
    const claimed = latch();
    const release = latch();
    const running = one.processNext(async () => { claimed.release(); await release.promise; });
    await claimed.promise;
    try {
      const next = push("ACME/Widgets");
      await Promise.race([
        Promise.all([two.enqueue(next), two.enqueue(event)]),
        setTimeout(1500).then(() => { throw new Error("Ingress waited for the running job"); }),
      ]);
      expect((await two.processNext(async () => undefined)).status).toBe("idle");
      const other = push("acme/other");
      await two.enqueue(other);
      expect(await two.processNext(async () => undefined)).toMatchObject({ status: "completed", id: other.id });
    } finally {
      release.release();
      await running;
    }
    expect((await two.processNext(async () => undefined)).status).toBe("completed");
    expect((await two.processNext(async () => undefined)).status).toBe("idle");
  });

  it("keeps PR checks independent from repository mutations", async () => {
    const one = queue();
    const two = queue();
    await one.enqueue(push());
    const claimed = latch();
    const release = latch();
    const running = one.processNext(async () => { claimed.release(); await release.promise; });
    await claimed.promise;
    try {
      const event = { ...push(), name: "pull_request" } as Delivery;
      await two.enqueue(event);
      expect(await two.processNext(async () => undefined)).toMatchObject({ status: "completed", scope: "acme/widgets:checks" });
    } finally {
      release.release();
      await running;
    }
  });

  it("recovers a claimed job after its worker process is killed", async () => {
    const worker = queue();
    const event = push();
    await worker.enqueue(event);
    const child = fork(fileURLToPath(new URL("./crash-worker.ts", import.meta.url)), {
      execArgv: ["--import", "tsx"], env: { ...process.env, DATABASE_URL: db.url }, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    try {
      await Promise.race([
        once(child, "message").then(([message]) => { expect(message).toBe("claimed"); }),
        once(child, "exit").then(() => { throw new Error(`Worker exited before claiming: ${output}`); }),
        setTimeout(5000).then(() => { throw new Error(`Worker did not claim a job: ${output}`); }),
      ]);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const handler = vi.fn(async () => undefined);
      expect(await worker.processNext(handler)).toMatchObject({ status: "completed", id: event.id, attempts: 1 });
      expect(handler).toHaveBeenCalledWith(event);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  }, 15_000);

  it("splits installation repositories into independently recoverable jobs", async () => {
    const worker = queue({ maxAttempts: 1 });
    const event = {
      id: randomUUID(), name: "installation", payload: {
        action: "created", repositories: [{ full_name: "acme/one" }, { full_name: "acme/two" }],
      },
    } as Delivery;
    await worker.enqueue(event);
    expect((await worker.status(event.id)).map((row) => row.scope)).toEqual(["acme/one:mutations", "acme/two:mutations"]);
    expect((await worker.processNext(async () => { throw new Error("One repository failed"); })).status).toBe("failed");
    const handler = vi.fn(async () => undefined);
    expect((await worker.processNext(handler)).status).toBe("completed");
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ payload: { repositories: [{ full_name: "acme/two" }] } });
    await worker.enqueue(event);
    expect((await worker.processNext(async () => undefined)).status).toBe("completed");
    expect((await worker.processNext(async () => undefined)).status).toBe("idle");
  });

  it("rejects an invalid installation atomically", async () => {
    const worker = queue();
    const event = {
      id: randomUUID(), name: "installation",
      payload: { repositories: [{ full_name: "acme/valid" }, { full_name: "invalid" }] },
    } as Delivery;
    await expect(worker.enqueue(event)).rejects.toThrow("valid owner/name");
    expect(await worker.status(event.id)).toEqual([]);
    expect(await db.sql`SELECT scope FROM webhook_scopes`).toHaveLength(0);
  });

  it("persists and deduplicates a 500-repository installation in one batch", async () => {
    const worker = queue();
    const event = {
      id: randomUUID(), name: "installation",
      payload: { repositories: Array.from({ length: 500 }, (_, index) => ({ full_name: `acme/repo-${index}` })) },
    } as Delivery;
    await worker.enqueue(event);
    await worker.enqueue(event);
    expect(await worker.status(event.id)).toHaveLength(500);
    expect((await db.sql`SELECT count(*)::int AS count FROM webhook_scopes`)[0]?.count).toBe(500);
  });
});
