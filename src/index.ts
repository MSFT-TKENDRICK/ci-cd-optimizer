import { createProbot, run } from "probot";
import { createApp, validateProductionConfiguration } from "./app.js";
import { PostgresWebhookQueue } from "./webhooks/postgres-queue.js";
import { registerDurableIngress, startWorkers } from "./webhooks/worker.js";

let queue: PostgresWebhookQueue | undefined;
let workers: ReturnType<typeof startWorkers> | undefined;
try {
  // run() loads .env before invoking the application.
  const server = await run(async (probot) => {
    validateProductionConfiguration();
    const mode = process.env.WEBHOOK_QUEUE ?? "direct";
    if (mode === "direct") {
      createApp()(probot);
      return;
    }
    if (mode !== "postgres") throw new Error("WEBHOOK_QUEUE must be direct or postgres");
    if (!process.env.DATABASE_URL) throw new Error("WEBHOOK_QUEUE=postgres requires DATABASE_URL");
    queue = new PostgresWebhookQueue(process.env.DATABASE_URL);
    await queue.initialize();
    const consumer = createProbot({ overrides: { log: probot.log } });
    await consumer.load(createApp());
    registerDurableIngress(probot, queue);
    workers = startWorkers(queue, (delivery) => consumer.receive(delivery), probot.log);
  });
  process.once("SIGTERM", () => {
    void (async () => {
      await server.stop();
      await workers?.stop();
      await queue?.close();
      process.exit(0);
    })().catch((error: unknown) => {
      console.error("App shutdown failed", error);
      process.exit(1);
    });
  });
} catch (error) {
  await workers?.stop();
  await queue?.close();
  throw error;
}
