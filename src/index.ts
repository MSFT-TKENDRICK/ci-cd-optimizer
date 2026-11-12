import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createProbot, run } from "probot";
import { createApp, validateProductionConfiguration } from "./app.js";
import { startDurableServer } from "./webhooks/ingress.js";
import { PostgresWebhookQueue } from "./webhooks/postgres-queue.js";
import { startWorkers } from "./webhooks/worker.js";
import { hostedAcpFromEnv } from "./agents/hosted.js";
import { hostedMcpFromEnv } from "./agents/hosted-mcp.js";

const WORKER_DRAIN_MS = 20_000;

let queue: PostgresWebhookQueue | undefined;
let workers: ReturnType<typeof startWorkers> | undefined;
let hosted: ReturnType<typeof hostedAcpFromEnv>;
let hostedMcp: ReturnType<typeof hostedMcpFromEnv>;
try {
  // Select the transport after loading .env, with the same precedence as Probot's run().
  try { Object.assign(process.env, parseEnv(readFileSync(".env", "utf8"))); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  validateProductionConfiguration();
  hosted = hostedAcpFromEnv();
  hostedMcp = hostedMcpFromEnv();
  const agents = hosted || hostedMcp ? async (request: Parameters<NonNullable<typeof hosted>["handle"]>[0], response: Parameters<NonNullable<typeof hosted>["handle"]>[1]) =>
    await hosted?.handle(request, response) || await hostedMcp?.handle(request, response) || false : undefined;
  const mode = process.env.WEBHOOK_QUEUE ?? "direct";
  if (mode !== "direct" && mode !== "postgres") throw new Error("WEBHOOK_QUEUE must be direct or postgres");
  let server: { stop(): Promise<void> };
  if (mode === "direct") {
    server = await run((probot, options) => {
      if (hosted) {
        if (probot.webhookPath.replace(/\/+$/, "") === "/acp") throw new Error("The webhook path must not conflict with /acp.");
      }
      if (hostedMcp && probot.webhookPath.replace(/\/+$/, "") === "/mcp") throw new Error("The webhook path must not conflict with /mcp.");
      if (agents) options.addHandler(agents);
      createApp()(probot);
    });
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
      ...(agents ? { agentHandler: agents } : {}),
    });
    workers = startWorkers(queue, (delivery) => consumer.receive(delivery), probot.log);
  }
  // Probot's direct-mode SIGINT handler also calls this method; close SSE before HTTP stop can wait on it.
  const stopServer = server.stop.bind(server);
  server.stop = async () => { await hosted?.close(); await hostedMcp?.close(); await stopServer(); };
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      await server.stop();
      // A stuck handler must not block the queue's forced close, which aborts its SQL and lets workers settle.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = workers?.stop();
      await Promise.race([drained, new Promise<void>((resolve) => { timer = setTimeout(resolve, WORKER_DRAIN_MS); })]);
      clearTimeout(timer);
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
  await hosted?.close();
  await hostedMcp?.close();
  await workers?.stop();
  await queue?.close();
  throw error;
}
