import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Probot } from "probot";
import { httpStatus } from "../github/client.js";
import type { DeliveryQueue, PostgresWebhookQueue } from "./postgres-queue.js";
import { createReadinessCheck } from "./readiness.js";
import { registerDurableIngress } from "./worker.js";

const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
export const INGRESS_TIMEOUT_MS = 5000;

class IngressError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function payload(request: IncomingMessage, signal: AbortSignal, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", data);
      request.off("end", end);
      request.off("aborted", aborted);
      signal.removeEventListener("abort", cancelled);
      chunks.length = 0;
    };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) fail(new IngressError(413, "Webhook payload exceeds the size limit"));
      else chunks.push(chunk);
    };
    const end = () => { const text = Buffer.concat(chunks).toString("utf8"); cleanup(); resolve(text); };
    const aborted = () => fail(new IngressError(400, "Webhook request was aborted"));
    const cancelled = () => fail(signal.reason);
    request.on("data", data).once("end", end).once("aborted", aborted).once("error", fail);
    // Keep the error listener until close: aborted streams can emit an error after their aborted event.
    request.once("close", () => { request.off("error", fail); });
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}

function reply(response: ServerResponse, status: number): void {
  if (response.destroyed || response.writableEnded) return;
  const body = status === 200 ? "ok\n" : `Webhook not acknowledged (${status}); redeliver after resolving the cause.\n`;
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...(status === 200 ? {} : { connection: "close" }),
  }).end(body);
}

/** Unlike Probot's default transport, a deadline is a failure, never a premature HTTP 202. */
export async function createDurableMiddleware(
  probot: Probot,
  queue: Pick<DeliveryQueue, "enqueue">,
  { timeoutMs = INGRESS_TIMEOUT_MS, maxPayloadBytes = MAX_PAYLOAD_BYTES }: { timeoutMs?: number; maxPayloadBytes?: number } = {},
): Promise<(request: IncomingMessage, response: ServerResponse) => Promise<boolean>> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) throw new Error("Ingress timeout must be from 1 to 8000 milliseconds");
  if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 1 || maxPayloadBytes > MAX_PAYLOAD_BYTES) throw new Error("Invalid webhook payload limit");
  await probot.ready();
  registerDurableIngress(probot, queue);
  const path = probot.webhookPath.replace(/\/+$/, "") || "/";

  return async (request, response) => {
    let pathname: string;
    try { pathname = new URL(request.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/"; }
    catch (error) { probot.log.warn({ error }, "Invalid webhook request URL"); reply(response, 400); return true; }
    if (pathname !== path) return false;
    const id = request.headers["x-github-delivery"];
    const name = request.headers["x-github-event"];
    const signature = request.headers["x-hub-signature-256"];
    let status: number;
    const stop = new AbortController();
    const disconnected = () => stop.abort(new IngressError(499, "Webhook client disconnected before acknowledgement"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      if (request.method !== "POST") throw new IngressError(404, "Unknown webhook method");
      if (!/^\s*application\/json\s*(?:;|$)/i.test(request.headers["content-type"] ?? "")) throw new IngressError(415, "Expected application/json");
      if (typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim() || typeof signature !== "string" || !signature.trim()) {
        throw new IngressError(400, "Missing webhook headers");
      }
      const length = request.headers["content-length"];
      if (length !== undefined && Number(length) > maxPayloadBytes) throw new IngressError(413, "Webhook payload exceeds the size limit");
      response.once("close", disconnected);
      const cancelled = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(stop.signal.reason);
        stop.signal.addEventListener("abort", abortListener, { once: true });
      });
      timer = setTimeout(() => stop.abort(new IngressError(503, "Webhook persistence deadline exceeded; commit outcome may be unknown")), timeoutMs);
      const work = (async () => {
        const body = await payload(request, stop.signal, maxPayloadBytes);
        stop.signal.throwIfAborted();
        await probot.webhooks.verifyAndReceive({ id, name, signature, payload: body });
      })().then(
        () => { if (stop.signal.aborted) probot.log.warn({ id, name }, "Webhook finished after acknowledgement was abandoned; redelivery is deduplicated"); },
        (error: unknown) => {
          if (stop.signal.aborted) probot.log.error({ error, id, name }, "Webhook failed after acknowledgement was abandoned");
          throw error;
        },
      );
      await Promise.race([work, cancelled]);
      status = 200;
    } catch (error) {
      const cause: unknown = error instanceof AggregateError ? error.errors[0] : error;
      const code = httpStatus(cause);
      status = code !== undefined && Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500;
      probot.log.error({ error, id, name, status }, "Durable webhook was not acknowledged");
    } finally {
      clearTimeout(timer);
      response.off("close", disconnected);
      if (abortListener) stop.signal.removeEventListener("abort", abortListener);
    }
    reply(response, status);
    if (status !== 200) request.resume();
    return true;
  };
}

export async function startDurableServer(
  probot: Probot,
  queue: Pick<PostgresWebhookQueue, "enqueue" | "checkReadiness">,
  { host = "localhost", port = 3000 }: { host?: string; port?: number } = {},
): Promise<{ port: number; stop(): Promise<void> }> {
  const middleware = await createDurableMiddleware(probot, queue);
  const path = probot.webhookPath.replace(/\/+$/, "") || "/";
  if (path === "/ping" || path === "/ready") throw new Error("Durable webhook paths /ping and /ready are reserved for health probes");
  const checkReadiness = createReadinessCheck(queue, probot.log);
  let stopping = false;
  let closed: Promise<void> | undefined;
  const server = createServer((request, response) => {
    void middleware(request, response).then(async (handled) => {
      if (handled) return;
      if (request.method === "GET" && request.url === "/ping") response.writeHead(200, { "content-type": "text/plain" }).end("PONG");
      else if (request.method === "GET" && request.url === "/ready") {
        const ready = !stopping && await checkReadiness() && !stopping;
        if (response.destroyed || response.writableEnded) return;
        const body = ready ? "READY" : "NOT READY";
        response.writeHead(ready ? 200 : 503, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
        }).end(body);
      } else response.writeHead(404).end();
    }).catch((error: unknown) => {
      probot.log.error({ error }, "Durable HTTP transport failed");
      reply(response, 500);
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Durable ingress requires a TCP listening address");
  probot.log.info({ host, port: address.port }, "Durable webhook ingress listening");
  return {
    port: address.port,
    stop: () => {
      stopping = true;
      closed ??= new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
      return closed;
    },
  };
}
