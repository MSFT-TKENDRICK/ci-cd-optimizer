import { PostgresWebhookQueue } from "../../src/webhooks/postgres-queue.js";

if (!process.env.DATABASE_URL) throw new Error("Test worker requires DATABASE_URL");
const queue = new PostgresWebhookQueue(process.env.DATABASE_URL);
await queue.processNext(async () => {
  process.send?.("claimed");
  await new Promise<void>(() => { /* The test kills this process while its transaction owns the job. */ });
});
await queue.close();
