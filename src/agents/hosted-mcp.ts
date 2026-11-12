import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { githubReader } from "./github.js";
import { createMcpServer } from "./mcp.js";
import { normalizeRepository } from "./remote.js";
import { LIMITS, WorkLimiter } from "./safety.js";
import type { HostedOptions, HttpHandler } from "./hosted.js";

/** A stateless MCP transport. Every request is authenticated independently. */
export function createHostedMcp(options: HostedOptions): { handle: HttpHandler; close(): Promise<void> } {
  if (options.auth !== "github-user" || !options.repositories.size || options.repositories.size > 100) {
    throw new Error("Hosted MCP requires github-user authentication and 1–100 pinned repositories.");
  }
  const repositories = new Map<string, number>();
  for (const [raw, id] of options.repositories) {
    const name = normalizeRepository(raw);
    if (!Number.isSafeInteger(id) || id <= 0 || repositories.has(name)) throw new Error("Invalid or duplicate hosted MCP repository.");
    repositories.set(name, id);
  }
  const requests = new WorkLimiter(LIMITS.requests, LIMITS.requests);
  const users = new WorkLimiter(LIMITS.requests, LIMITS.userRequests);
  const operations = new WorkLimiter(LIMITS.operations, LIMITS.userOperations);
  const active = new Set<AbortController>();
  let closed = false;
  const handle: HttpHandler = async (request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://localhost"); } catch { return false; }
    if (url.pathname !== "/mcp") return false;
    const stop = new AbortController();
    active.add(stop);
    let timer = setTimeout(() => stop.abort(), LIMITS.httpMs);
    const disconnect = () => stop.abort();
    response.once("close", disconnect);
    request.once("aborted", disconnect);
    let release: (() => void) | undefined;
    let releaseUser: (() => void) | undefined;
    let releaseOperation: (() => void) | undefined;
    let server: ReturnType<typeof createMcpServer> | undefined;
    try {
      if (closed) throw new HttpError(503, "Hosted MCP is shutting down.");
      try { release = requests.acquire(); } catch { throw new HttpError(429, "Too many requests."); }
      const auth = header(request, "authorization");
      const match = /^Bearer ([\x21-\x7e]{1,512})$/i.exec(auth ?? "");
      if (!match) throw new HttpError(401, "A GitHub user token is required.");
      const token = match[1] as string;
      let user: { id?: unknown; type?: unknown };
      try {
        const result = await githubReader(token, { signal: stop.signal, timeoutMs: LIMITS.httpMs, responseBytes: LIMITS.configBytes, ...(options.fetch ? { fetch: options.fetch } : {}) }).request("GET /user");
        user = result.data as typeof user;
      } catch { throw new HttpError(401, "GitHub user authentication failed."); }
      if (!user || typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0 || user.type !== "User") throw new HttpError(401, "GitHub user authentication failed.");
      try { releaseUser = users.acquire(String(user.id)); } catch { throw new HttpError(429, "Too many requests for this user."); }
      if (url.search || url.hash) throw new HttpError(400, "MCP does not accept query parameters.");
      if (header(request, "origin")) throw new HttpError(403, "Browser-origin requests are not supported.");
      if (request.method !== "POST") throw new HttpError(405, "Only POST is supported.");
      if (!/^application\/json(?:\s*;|$)/i.test(header(request, "content-type") ?? "")) throw new HttpError(415, "Expected application/json.");
      if (Number(header(request, "content-length")) > LIMITS.requestBytes) throw new HttpError(413, "Request body exceeds the byte limit.");
      const text = await body(request, stop.signal);
      let message: { jsonrpc?: unknown; id?: unknown; method?: unknown };
      try { message = JSON.parse(text) as typeof message; } catch { throw new HttpError(400, "Invalid JSON."); }
      if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" ||
          typeof message.method !== "string" || !["initialize", "notifications/initialized", "ping", "tools/list", "tools/call", "resources/list", "resources/read", "resources/templates/list", "prompts/list", "prompts/get"].includes(message.method)) {
        throw new HttpError(400, "Unsupported JSON-RPC message.");
      }
      if (message.id !== undefined && !((typeof message.id === "string" && message.id.length > 0 && message.id.length <= 128) || (typeof message.id === "number" && Number.isSafeInteger(message.id)))) {
        throw new HttpError(400, "Invalid request ID.");
      }
      if (message.method === "tools/call") {
        try { releaseOperation = operations.acquire(String(user.id)); } catch { throw new HttpError(429, "Operation limit reached."); }
        clearTimeout(timer);
        timer = setTimeout(() => stop.abort(), LIMITS.operationMs);
      }
      const headers = new Headers();
      for (const name of ["content-type", "accept", "mcp-protocol-version"]) {
        const value = header(request, name);
        if (value) headers.set(name, value);
      }
      server = createMcpServer({
        remoteOnly: true,
        remote: {
          allow: [...repositories.keys()], repositoryIds: new Map(repositories), requirePull: true,
          createClient: (signal) => githubReader(token, { signal: AbortSignal.any([signal, stop.signal]), timeoutMs: LIMITS.httpMs, ...(options.fetch ? { fetch: options.fetch } : {}) }),
        },
      });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      const result = await transport.handleRequest(new Request("http://localhost/mcp", {
        method: "POST", headers, body: text, signal: stop.signal,
      }));
      response.statusCode = result.status;
      result.headers.forEach((value, name) => response.setHeader(name, value));
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      if (result.body) await pipeline(Readable.fromWeb(result.body as NodeReadableStream<Uint8Array>), response, { signal: stop.signal });
      else response.end();
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const status = error instanceof HttpError ? error.status : stop.signal.aborted ? 408 : 500;
        response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...(status === 401 ? { "www-authenticate": 'Bearer realm="ci-cd-optimizer"' } : {}) });
        response.end(error instanceof HttpError ? error.message : "MCP request failed.");
      } else if (!response.destroyed) response.destroy();
      request.resume();
    } finally {
      clearTimeout(timer);
      response.off("close", disconnect);
      request.off("aborted", disconnect);
      active.delete(stop);
      await server?.close();
      releaseOperation?.();
      releaseUser?.();
      release?.();
    }
    return true;
  };
  return {
    handle,
    async close() {
      closed = true;
      for (const controller of active) controller.abort();
    },
  };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) throw new HttpError(400, "Duplicate protocol header.");
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) if (request.rawHeaders[index]?.toLowerCase() === name) count++;
  if (count > 1) throw new HttpError(400, "Duplicate protocol header.");
  return value;
}

function body(request: IncomingMessage, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      request.off("data", data).off("end", end).off("aborted", aborted).off("error", fail);
      signal.removeEventListener("abort", aborted);
    };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const aborted = () => fail(new HttpError(408, "Request aborted or timed out."));
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > LIMITS.requestBytes) fail(new HttpError(413, "Request body exceeds the byte limit."));
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    request.on("data", data).once("end", end).once("aborted", aborted).once("error", fail);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export function hostedMcpFromEnv(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof createHostedMcp> | undefined {
  if (env.CICD_OPTIMIZER_MCP !== undefined && !["true", "false"].includes(env.CICD_OPTIMIZER_MCP)) throw new Error("CICD_OPTIMIZER_MCP must be true or false.");
  if (env.CICD_OPTIMIZER_MCP !== "true") return undefined;
  if (env.CICD_OPTIMIZER_MCP_AUTH !== "github-user") throw new Error("CICD_OPTIMIZER_MCP_AUTH=github-user is required.");
  if (!env.CICD_OPTIMIZER_MCP_REPOSITORIES) throw new Error("Hosted MCP requires 1–100 pinned repositories.");
  const repositories = new Map<string, number>();
  for (const entry of env.CICD_OPTIMIZER_MCP_REPOSITORIES.split(",")) {
    const match = /^([^:]+):([1-9]\d*)$/.exec(entry.trim());
    if (!match) throw new Error("CICD_OPTIMIZER_MCP_REPOSITORIES must contain owner/repo:repository-id entries.");
    const name = normalizeRepository(match[1] as string);
    if (repositories.has(name)) throw new Error("Duplicate hosted MCP repository.");
    repositories.set(name, Number(match[2]));
  }
  return createHostedMcp({ auth: "github-user", repositories });
}
