import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createProbot, run } from "probot";
import { createApp, validateProductionConfiguration } from "./app.js";
import { startDurableServer } from "./webhooks/ingress.js";
import { PostgresWebhookQueue } from "./webhooks/postgres-queue.js";
import { startWorkers } from "./webhooks/worker.js";

let queue: PostgresWebhookQueue | undefined;
let workers: ReturnType<typeof startWorkers> | undefined;
try {
  // Select the transport after loading .env, with the same precedence as Probot's run().
  try { Object.assign(process.env, parseEnv(readFileSync(".env", "utf8"))); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  validateProductionConfiguration();
  const mode = process.env.WEBHOOK_QUEUE ?? "direct";
  if (mode !== "direct" && mode !== "postgres") throw new Error("WEBHOOK_QUEUE must be direct or postgres");
  let server: { stop(): Promise<void> };
  if (mode === "direct") {
    server = await run(createApp());
  } else {
    if (!process.env.DATABASE_URL) throw new Error("WEBHOOK_QUEUE=postgres requires DATABASE_URL");
    if (process.env.WEBHOOK_PROXY_URL) throw new Error("Durable ingress requires a reachable endpoint; WEBHOOK_PROXY_URL is supported only in direct mode");
    const probot = await createProbot().ready();
    queue = new PostgresWebhookQueue(process.env.DATABASE_URL);
    await queue.initialize();
    const consumer = createProbot({ overrides: { log: probot.log } });
    await consumer.load(createApp());
    server = await startDurableServer(probot, queue, {
      host: process.env.HOST || "localhost",
      port: Number(process.env.PORT) || 3000,
    });
    workers = startWorkers(queue, (delivery) => consumer.receive(delivery), probot.log);
  }
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      await server.stop();
      await workers?.stop();
      await queue?.close();
      process.exit(0);
    })().catch((error: unknown) => {
      console.error("App shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGTERM", shutdown);
  if (mode === "postgres") process.once("SIGINT", shutdown);
} catch (error) {
  await workers?.stop();
  await queue?.close();
  throw error;
}
