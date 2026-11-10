import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import type { AgentConnector, AnyMessage } from "@agentclientprotocol/sdk";
import { createAcpAgent } from "./acp.js";
import { githubReader } from "./github.js";
import { normalizeRepository } from "./remote.js";
import { LIMITS, WorkLimiter } from "./safety.js";

export type HttpHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

export interface HostedOptions {
  /** Explicit authentication mode; there is deliberately no unauthenticated or installation-token mode. */
  auth: "github-user";
  /** Canonical owner/repo -> immutable GitHub repository ID, supplied by the deployment operator. */
  repositories: ReadonlyMap<string, number>;
  fetch?: typeof fetch;
  /** Tests may lower ceilings, never raise deployment limits. */
  limits?: Partial<Record<"connections" | "userConnections" | "requests" | "userRequests" | "streams" | "userStreams" | "sessions" | "operations" | "userOperations" | "connectionMs" | "httpMs" | "outputStallMs", number>>;
}

interface Binding {
  user: string;
  tokenHash: string;
  stop: AbortController;
  pending: Set<string | number>;
  sessions: Set<string>;
  release: () => void;
  timer?: ReturnType<typeof setTimeout>;
  id?: string;
  closed: boolean;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function reply(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", connection: "close",
    ...(status === 401 ? { "www-authenticate": 'Bearer realm="ci-cd-optimizer"' } : {}),
    ...(status === 429 ? { "retry-after": "5" } : {}),
  }).end(message);
}

function body(request: IncomingMessage, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      request.off("data", data).off("end", end).off("aborted", aborted);
      signal.removeEventListener("abort", aborted);
      chunks.length = 0;
    };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const aborted = () => fail(new HttpError(408, "Request aborted or timed out."));
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > LIMITS.requestBytes) fail(new HttpError(413, "Request body exceeds the byte limit."));
      else chunks.push(chunk);
    };
    const end = () => { const text = Buffer.concat(chunks).toString("utf8"); cleanup(); resolve(text); };
    request.on("data", data).once("end", end).once("aborted", aborted).once("error", fail);
    request.once("close", () => request.off("error", fail));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new HttpError(400, "Duplicate protocol header.");
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  if (count > 1) throw new HttpError(400, "Duplicate protocol header.");
  return value;
}

/** Custom Node adapter: authentication happens before *every* SDK call, including SSE and DELETE. */
export function createHostedAcp(options: HostedOptions): { handle: HttpHandler; close(): Promise<void> } {
  if (options.auth !== "github-user" || !options.repositories.size || options.repositories.size > 100) {
    throw new Error("Hosted ACP requires github-user authentication and 1–100 pinned repositories.");
  }
  const repositories = new Map<string, number>();
  for (const [name, id] of options.repositories) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Hosted ACP repository IDs must be positive safe integers.");
    const normalized = normalizeRepository(name);
    if (repositories.has(normalized)) throw new Error("Duplicate hosted ACP repository.");
    repositories.set(normalized, id);
  }
  const limits: { [K in keyof typeof LIMITS]: number } = { ...LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > LIMITS[key as keyof typeof LIMITS]) throw new Error(`Invalid hosted ACP limit: ${key}`);
  }
  const connections = new WorkLimiter(limits.connections, limits.userConnections);
  const requests = new WorkLimiter(limits.requests, limits.requests);
  const userRequests = new WorkLimiter(limits.requests, limits.userRequests);
  const streams = new WorkLimiter(limits.streams, limits.userStreams);
  const operations = new WorkLimiter(limits.operations, limits.userOperations);
  const bindings = new Map<string, Binding>();
  const active = new Set<AbortController>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const server = new AcpServer({
    // The SDK's Node convenience handler cannot pass the authenticated per-request factory. Never use its fallback.
    createAgent: () => { throw new Error("Authenticated initialization override is required."); },
    maxBufferedBytes: LIMITS.bufferedBytes,
    maxBufferedSessionStreams: limits.sessions,
    maxOutputStallMs: limits.outputStallMs,
    maxIdLength: 128,
  });
  const forget = (binding: Binding) => {
    if (binding.closed) return;
    binding.closed = true;
    binding.stop.abort();
    clearTimeout(binding.timer);
    if (binding.id) bindings.delete(binding.id);
    binding.pending.clear();
    binding.sessions.clear();
    binding.release();
  };
  const remove = async (binding: Binding) => {
    forget(binding);
    if (binding.id) await server.handleRequest(new Request("http://localhost/acp", { method: "DELETE", headers: { "Acp-Connection-Id": binding.id } }));
  };
  const authenticate = async (request: IncomingMessage, signal: AbortSignal): Promise<{ user: string; token: string; hash: string }> => {
    const match = /^Bearer ([\x21-\x7e]{1,512})$/i.exec(header(request, "authorization") ?? "");
    if (!match) throw new HttpError(401, "A GitHub user token is required.");
    const token = match[1] as string;
    try {
      const { data } = await githubReader(token, { signal, timeoutMs: limits.httpMs, responseBytes: LIMITS.configBytes, ...(options.fetch ? { fetch: options.fetch } : {}) }).request("GET /user");
      const user = data as { id?: unknown; type?: unknown };
      if (!user || typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0 || user.type !== "User") throw new Error("Not a user");
      return { user: String(user.id), token, hash: createHash("sha256").update(token).digest("hex") };
    } catch { throw new HttpError(401, "GitHub user authentication failed."); }
  };
  const connector = (binding: Binding, token: string): AgentConnector => ({
    connect(stream) {
      const writer = stream.writable.getWriter();
      const app = createAcpAgent({
        principal: binding.user, limiter: operations, maxSessions: limits.sessions,
        remote: {
          allow: [...repositories.keys()], repositoryIds: new Map(repositories), requirePull: true,
          createClient: (signal) => githubReader(token, {
            signal: AbortSignal.any([signal, binding.stop.signal]), timeoutMs: limits.httpMs,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          }),
        },
      });
      const connection = app.connect({
        readable: stream.readable,
        writable: new WritableStream<AnyMessage>({
          async write(message) {
            if ("id" in message && message.id !== null && ("result" in message || "error" in message)) {
              binding.pending.delete(message.id);
              if ("result" in message && typeof message.result === "object" && message.result !== null && "sessionId" in message.result && typeof message.result.sessionId === "string") {
                binding.sessions.add(message.result.sessionId);
              }
            }
            await writer.write(message);
          },
          close: () => writer.close(),
          abort: (reason) => writer.abort(reason),
        }),
      });
      const cancel = () => connection.close();
      binding.stop.signal.addEventListener("abort", cancel, { once: true });
      void connection.closed.then(() => {
        binding.stop.signal.removeEventListener("abort", cancel);
        forget(binding);
      });
      return connection;
    },
  });

  const handle: HttpHandler = async (request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://localhost"); }
    catch { reply(response, 400, "Invalid request URL."); return true; }
    if (url.pathname !== "/acp") return false;
    const stop = new AbortController();
    active.add(stop);
    let releaseRequest: (() => void) | undefined;
    let releaseUser: (() => void) | undefined;
    let releaseStream: (() => void) | undefined;
    let initializing: Binding | undefined;
    let pending: { binding: Binding; id: string | number } | undefined;
    let timer = setTimeout(() => stop.abort(), limits.httpMs);
    const disconnect = () => stop.abort();
    response.once("close", disconnect);
    request.once("aborted", disconnect);
    try {
      if (closed) throw new HttpError(503, "Hosted ACP is shutting down.");
      try { releaseRequest = requests.acquire(); } catch { throw new HttpError(429, "Too many HTTP requests."); }
      const identity = await authenticate(request, stop.signal);
      try { releaseUser = userRequests.acquire(identity.user); } catch { throw new HttpError(429, "Too many requests for this user."); }
      if (url.search || url.hash) throw new HttpError(400, "ACP does not accept query parameters.");
      if (header(request, "origin")) throw new HttpError(403, "Browser-origin requests are not supported.");
      const method = request.method ?? "";
      if (!["POST", "GET", "DELETE"].includes(method)) throw new HttpError(405, "Only POST, GET, and DELETE are supported.");
      const connectionId = header(request, "acp-connection-id");
      const sessionId = header(request, "acp-session-id");
      if ((connectionId?.length ?? 0) > 128 || (sessionId?.length ?? 0) > 128) throw new HttpError(400, "Protocol ID exceeds the length limit.");
      let binding: Binding | undefined;
      if (connectionId) {
        binding = bindings.get(connectionId);
        // Token binding prevents a newly restricted or different credential from reusing a more privileged session.
        if (!binding || binding.user !== identity.user || binding.tokenHash !== identity.hash || binding.closed) throw new HttpError(404, "Unknown connection.");
        if (sessionId && !binding.sessions.has(sessionId)) throw new HttpError(404, "Unknown session.");
      } else if (method !== "POST") throw new HttpError(400, "Acp-Connection-Id is required.");

      let text: string | undefined;
      if (method === "POST") {
        if (!/^application\/json(?:\s*;|$)/i.test(header(request, "content-type") ?? "")) throw new HttpError(415, "Expected application/json.");
        if (Number(header(request, "content-length")) > LIMITS.requestBytes) throw new HttpError(413, "Request body exceeds the byte limit.");
        text = await body(request, stop.signal);
        let message: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
        try { message = JSON.parse(text) as typeof message; } catch { throw new HttpError(400, "Invalid JSON."); }
        if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" ||
            typeof message.method !== "string" || !["initialize", "session/new", "session/prompt", "session/cancel"].includes(message.method)) {
          throw new HttpError(400, "Unsupported JSON-RPC message.");
        }
        const id = message.id;
        if (id !== undefined && !((typeof id === "string" && id.length > 0 && id.length <= 128) || (typeof id === "number" && Number.isSafeInteger(id)))) {
          throw new HttpError(400, "Invalid request ID.");
        }
        if ((message.method === "session/cancel") !== (id === undefined)) throw new HttpError(400, "Only session/cancel may be a notification.");
        if (!binding) {
          if (message.method !== "initialize" || sessionId) throw new HttpError(400, "Initialize a connection first.");
          let release: () => void;
          try { release = connections.acquire(identity.user); } catch { throw new HttpError(429, "Connection limit reached."); }
          binding = { user: identity.user, tokenHash: identity.hash, stop: new AbortController(), pending: new Set(), sessions: new Set(), release, closed: false };
          initializing = binding;
        } else {
          if (message.method === "initialize") throw new HttpError(400, "Connection is already initialized.");
          if (id !== undefined && (binding.pending.size >= LIMITS.sessions || binding.pending.has(id as string | number))) throw new HttpError(429, "Too many pending or duplicate JSON-RPC requests.");
          if (message.method === "session/prompt" || message.method === "session/cancel") {
            const params = message.params as { sessionId?: unknown } | null;
            if (!params || typeof params.sessionId !== "string" || !binding.sessions.has(params.sessionId)) throw new HttpError(404, "Unknown session.");
          }
          if (id !== undefined) {
            binding.pending.add(id as string | number);
            pending = { binding, id: id as string | number };
          }
        }
      } else if (method === "GET") {
        try { releaseStream = streams.acquire(identity.user); } catch { throw new HttpError(429, "SSE stream limit reached."); }
      }
      if (method !== "POST" && (header(request, "transfer-encoding") || Number(header(request, "content-length")) > 0)) throw new HttpError(400, "Only POST may contain a request body.");

      const headers = new Headers();
      for (const name of ["content-type", "accept", "acp-connection-id", "acp-session-id"]) {
        const value = header(request, name);
        if (value) headers.set(name, value);
      }
      const incoming = new Request("http://localhost/acp", { method, headers, signal: stop.signal, ...(text !== undefined ? { body: text } : {}) });
      const result = await server.handleRequest(incoming, initializing ? { createAgent: () => connector(initializing as Binding, identity.token) } : {});
      if (pending && result.status !== 202) pending.binding.pending.delete(pending.id);
      if (initializing) {
        const id = result.headers.get("Acp-Connection-Id");
        const payload = await result.clone().json() as { error?: unknown };
        if (result.status !== 200 || !id || payload.error || initializing.closed || stop.signal.aborted || closed) {
          if (id) initializing.id = id;
          await remove(initializing);
          throw new HttpError(400, "ACP initialization failed.");
        }
        initializing.id = id;
        const bound = initializing;
        bindings.set(id, bound);
        bound.timer = setTimeout(() => { void remove(bound).catch(() => undefined); }, limits.connectionMs);
        bound.timer.unref();
        initializing = undefined;
      }
      if (method === "DELETE" && binding) forget(binding);
      response.statusCode = result.status;
      result.headers.forEach((value, name) => response.setHeader(name, value));
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      response.flushHeaders();
      if (method === "GET" && result.ok) {
        // Each stream has a finite lease; reopening it reauthenticates, even if the ACP connection lives longer.
        clearTimeout(timer);
        timer = setTimeout(() => stop.abort(), Math.min(60_000, limits.connectionMs));
        releaseRequest(); releaseRequest = undefined;
        releaseUser(); releaseUser = undefined;
      }
      if (result.body) await pipeline(Readable.fromWeb(result.body as NodeReadableStream<Uint8Array>), response, { signal: stop.signal });
      else response.end();
    } catch (error) {
      if (initializing) await remove(initializing).catch(() => undefined);
      if (pending) pending.binding.pending.delete(pending.id);
      reply(response, error instanceof HttpError ? error.status : stop.signal.aborted ? 408 : 500,
        error instanceof HttpError ? error.message : "ACP request failed.");
      request.resume();
    } finally {
      clearTimeout(timer);
      response.off("close", disconnect);
      request.off("aborted", disconnect);
      active.delete(stop);
      releaseStream?.(); releaseUser?.(); releaseRequest?.();
    }
    return true;
  };
  return {
    handle,
    close() {
      closing ??= (async () => {
        closed = true;
        for (const controller of active) controller.abort();
        for (const binding of bindings.values()) forget(binding);
        await server.close();
      })();
      return closing;
    },
  };
}

/** Disabled means absent. Enabled but incomplete/malformed configuration stops startup rather than opening an endpoint. */
export function hostedAcpFromEnv(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof createHostedAcp> | undefined {
  if (env.CICD_OPTIMIZER_ACP !== undefined && !["true", "false"].includes(env.CICD_OPTIMIZER_ACP)) throw new Error("CICD_OPTIMIZER_ACP must be true or false.");
  if (env.CICD_OPTIMIZER_ACP !== "true") return undefined;
  if (env.CICD_OPTIMIZER_ACP_AUTH !== "github-user") throw new Error("CICD_OPTIMIZER_ACP_AUTH=github-user is required.");
  if (!env.CICD_OPTIMIZER_ACP_REPOSITORIES) throw new Error("Hosted ACP requires 1–100 pinned repositories.");
  const repositories = new Map<string, number>();
  for (const entry of env.CICD_OPTIMIZER_ACP_REPOSITORIES.split(",")) {
    const match = /^([^:]+):([1-9]\d*)$/.exec(entry.trim());
    if (!match) throw new Error("CICD_OPTIMIZER_ACP_REPOSITORIES must contain owner/repo:repository-id entries.");
    const name = normalizeRepository(match[1] as string);
    if (repositories.has(name)) throw new Error("Duplicate hosted ACP repository.");
    repositories.set(name, Number(match[2]));
  }
  return createHostedAcp({ auth: "github-user", repositories });
}
