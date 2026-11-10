import { createServer, request as httpRequest } from "node:http";
import { client, methods, PROTOCOL_VERSION, type ActiveSession, type ClientContext } from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { afterEach, describe, expect, it } from "vitest";
import { createHostedAcp, hostedAcpFromEnv, type HostedOptions } from "../../src/agents/hosted.js";
import { LIMITS } from "../../src/agents/safety.js";
import { MISSING_TIMEOUT, WORKFLOW } from "./helpers.js";
import { TIMEOUT_ONLY } from "../service/api.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function github() {
  const state = {
    id: 42, pull: true, name: "acme/widgets", authorized: true,
    stall: false, aborted: false,
    calls: [] as Array<{ path: string; token: string; method: string }>,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    state.calls.push({ path: decodeURIComponent(url.pathname), token, method: init?.method ?? "GET" });
    if (url.pathname === "/user") {
      if (!state.authorized || !["a", "a2", "b", "c"].includes(token)) return Response.json({ message: "Bad credentials" }, { status: 401 });
      return Response.json({ id: token.startsWith("a") ? 1 : token === "b" ? 2 : 3, type: "User" });
    }
    if (state.stall) {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => { state.aborted = true; reject(new DOMException("Aborted", "AbortError")); };
        init?.signal?.addEventListener("abort", abort, { once: true });
        if (init?.signal?.aborted) abort();
      });
    }
    const path = decodeURIComponent(url.pathname);
    if (path === "/repos/acme/widgets") return Response.json({ id: state.id, full_name: state.name, permissions: { pull: state.pull }, default_branch: "main" });
    if (path.includes("/contents/")) return Response.json({ content: Buffer.from(TIMEOUT_ONLY).toString("base64"), encoding: "base64" });
    if (path.includes("/commits/")) return Response.json({ sha: "abc", commit: { tree: { sha: "tree" } } });
    if (path.includes("/git/trees/")) return Response.json({ tree: [{ path: WORKFLOW, type: "blob", sha: "blob", size: MISSING_TIMEOUT.length }], truncated: false });
    if (path.includes("/git/blobs/")) return Response.json({ content: Buffer.from(MISSING_TIMEOUT).toString("base64"), encoding: "base64" });
    return Response.json({}, { status: 404 });
  };
  return { state, fetcher };
}

async function serve(limits: HostedOptions["limits"] = {}, fetchOverride?: typeof fetch) {
  const api = github();
  const hosted = createHostedAcp({ auth: "github-user", repositories: new Map([["acme/widgets", 42]]), fetch: fetchOverride ?? api.fetcher, limits });
  const server = createServer((request, response) => {
    void hosted.handle(request, response).then((handled) => { if (!handled) response.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  cleanup.push(async () => { await hosted.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  return { ...api, hosted, url: `http://127.0.0.1:${address.port}/acp` };
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} } };
async function request(url: string, method: string, token?: string, connection?: string, value?: unknown, extra: Record<string, string> = {}) {
  return fetch(url, {
    method, signal: AbortSignal.timeout(5000),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(connection ? { "Acp-Connection-Id": connection } : {}),
      ...(method === "GET" ? { accept: "text/event-stream" } : {}), ...(value !== undefined ? { "content-type": "application/json" } : {}), ...extra,
    },
    ...(value !== undefined ? { body: typeof value === "string" ? value : JSON.stringify(value) } : {}),
  });
}
async function init(url: string, token = "a"): Promise<string> {
  const response = await request(url, "POST", token, undefined, initialize);
  expect(response.status, await response.text()).toBe(200);
  const id = response.headers.get("Acp-Connection-Id");
  expect(id).toBeTruthy();
  return id as string;
}
async function withClient<T>(url: string, op: (ctx: ClientContext) => Promise<T>, token = "a"): Promise<T> {
  return client().connectWith(createHttpStream(url, { headers: { authorization: `Bearer ${token}` }, cookies: "omit", maxMessageBytes: LIMITS.outputBytes * 2 }), async (ctx) => {
    const initialized = await ctx.request(methods.agent.initialize, initialize.params);
    expect(initialized.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(false);
    return op(ctx);
  });
}
async function turn(session: ActiveSession, text: string) {
  const done = session.prompt(text);
  const updates = [];
  for (;;) {
    const message = await session.nextUpdate();
    if (message.kind === "stop") break;
    updates.push(message.update);
  }
  const answer = updates.flatMap((update) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []).join("");
  return { response: await done, updates, answer };
}

describe("hosted ACP configuration", () => {
  it("fails closed and never enables itself from ambient tokens", async () => {
    expect(hostedAcpFromEnv({ GITHUB_TOKEN: "ambient", GH_TOKEN: "ambient" })).toBeUndefined();
    expect(() => hostedAcpFromEnv({ CICD_OPTIMIZER_ACP: "yes" })).toThrow("true or false");
    expect(() => hostedAcpFromEnv({ CICD_OPTIMIZER_ACP: "true" })).toThrow("github-user");
    expect(() => hostedAcpFromEnv({ CICD_OPTIMIZER_ACP: "true", CICD_OPTIMIZER_ACP_AUTH: "github-user" })).toThrow("pinned repositories");
    for (const value of ["acme/widgets", "acme/widgets:0", "acme/widgets:9007199254740992", "acme/widgets:42,ACME/widgets:42", "acme/widgets:42,", ",acme/widgets:42", "acme/widgets:42,,acme/other:43"]) {
      expect(() => hostedAcpFromEnv({ CICD_OPTIMIZER_ACP: "true", CICD_OPTIMIZER_ACP_AUTH: "github-user", CICD_OPTIMIZER_ACP_REPOSITORIES: value })).toThrow();
    }
    expect(() => createHostedAcp({ auth: "github-user", repositories: new Map([["acme/widgets", 42], ["ACME/widgets", 43]]) })).toThrow("Duplicate");
    const configured = hostedAcpFromEnv({ CICD_OPTIMIZER_ACP: "true", CICD_OPTIMIZER_ACP_AUTH: "github-user", CICD_OPTIMIZER_ACP_REPOSITORIES: "acme/widgets:42" });
    expect(configured).toBeDefined();
    await configured?.close();
  });
});

describe("hosted ACP authentication and routing", () => {
  it("authenticates every verb including SSE, deletion, and unsupported methods", async () => {
    const host = await serve();
    for (const method of ["POST", "GET", "DELETE", "OPTIONS", "PUT", "HEAD"]) {
      expect((await request(host.url, method)).status).toBe(401);
    }
    const id = await init(host.url);
    for (const method of ["POST", "GET", "DELETE", "OPTIONS", "PUT"]) {
      expect((await request(host.url, method, "installation-token", id)).status).toBe(401);
    }
    expect((await request(host.url, "OPTIONS", "a", id)).status).toBe(405);
    host.state.authorized = false;
    for (const method of ["GET", "POST", "DELETE"]) expect((await request(host.url, method, "a", id)).status).toBe(401);
    expect(host.state.calls.every((call) => call.path === "/user")).toBe(true);
  });

  it("binds connection IDs to both principal and credential, and rejects forged sessions", async () => {
    const host = await serve();
    const id = await init(host.url);
    for (const token of ["b", "a2"]) for (const method of ["GET", "POST", "DELETE"]) {
      expect((await request(host.url, method, token, id, method === "POST" ? { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/", mcpServers: [] } } : undefined)).status).toBe(404);
    }
    expect((await request(host.url, "GET", "a", id, undefined, { "Acp-Session-Id": "forged" })).status).toBe(404);
    expect((await request(host.url, "GET", "a", id, undefined, { Origin: "https://untrusted.example" })).status).toBe(403);
    expect((await request(host.url, "DELETE", "a", id)).status).toBe(202);
    expect((await request(host.url, "GET", "a", id)).status).toBe(404);
  });

  it("validates malformed input, batches, body and ID limits before forwarding", async () => {
    const host = await serve();
    const id = await init(host.url);
    for (const malformed of ["{", "null", [initialize], { ...initialize, id: "x".repeat(129) }, { ...initialize, method: "write_file" }]) {
      expect((await request(host.url, "POST", "a", undefined, malformed)).status).toBe(400);
    }
    expect((await request(host.url, "POST", "a", id, "x".repeat(LIMITS.requestBytes + 1))).status).toBe(413);
    expect((await request(host.url, "POST", "a", id, "{}", { "content-type": "text/plain" })).status).toBe(415);
    expect((await request(host.url, "GET", "a", "x".repeat(129))).status).toBe(400);
    expect((await request(`${host.url}?token=not-accepted`, "GET", "a", id)).status).toBe(400);
  });
});

describe("hosted ACP roundtrips and resource limits", () => {
  it("runs a real SDK HTTP/SSE command roundtrip without local filesystem access or writes", async () => {
    const host = await serve();
    await withClient(host.url, async (ctx) => {
      const session = await ctx.buildSession("/nonexistent/server/path").start();
      const advertised = await session.nextUpdate();
      expect(JSON.stringify(advertised)).toContain('"scan"');
      expect(JSON.stringify(advertised)).not.toContain("fix-preview");
      const scan = await turn(session, "/scan acme/widgets");
      expect(scan.response.stopReason).toBe("end_turn");
      expect(scan.answer).toContain("workflow/job-timeout");
      expect(scan.updates.some((update) => update.sessionUpdate === "tool_call" && (update.rawOutput as { dryRun?: boolean })?.dryRun)).toBe(true);
      const calls = host.state.calls.filter((call) => call.path !== "/user");
      expect(calls.length).toBeGreaterThan(2);
      expect(calls.every((call) => call.method === "GET" && call.token === "a" && call.path.startsWith("/repos/acme/widgets"))).toBe(true);
      for (let index = 0; index < calls.length; index += 1) if (calls[index]?.path !== "/repos/acme/widgets") {
        expect(calls[index - 1]?.path).toBe("/repos/acme/widgets");
      }
      const denied = await turn(session, "/scan other/repo");
      expect(denied.answer).toContain("not in the allowed repositories");
      expect(host.state.calls.some((call) => call.path.startsWith("/repos/other"))).toBe(false);
      await expect(ctx.buildSession("/").withMcpServer({ name: "x", command: "node", args: [], env: [] }).start()).rejects.toMatchObject({ code: -32602 });
      const local = await turn(session, "/lint");
      expect(local.answer).toContain("No local files");
    });
  });

  it("rechecks pinned repository identity and caller pull access on every operation", async () => {
    const host = await serve();
    await withClient(host.url, async (ctx) => {
      const session = await ctx.buildSession("/").start();
      await session.nextUpdate();
      host.state.id = 99;
      expect((await turn(session, "/scan acme/widgets")).answer).toContain("identity changed");
      host.state.id = 42; host.state.pull = false;
      expect((await turn(session, "/scan acme/widgets")).answer).toContain("access denied");
      host.state.pull = true; host.state.name = "moved/widgets";
      expect((await turn(session, "/scan acme/widgets")).answer).toContain("renamed or transferred");
      expect(host.state.calls.filter((call) => call.path !== "/user").every((call) => call.path === "/repos/acme/widgets")).toBe(true);
    });
  });

  it("cancels actual pending GitHub reads and allows the next prompt", async () => {
    const host = await serve();
    await withClient(host.url, async (ctx) => {
      const session = await ctx.buildSession("/").start();
      await session.nextUpdate();
      host.state.stall = true;
      const pending = ctx.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: "text", text: "/scan acme/widgets" }] });
      await expect.poll(() => host.state.calls.some((call) => call.path === "/repos/acme/widgets")).toBe(true);
      await ctx.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
      expect((await pending).stopReason).toBe("cancelled");
      expect(host.state.aborted).toBe(true);
      host.state.stall = false;
      expect((await ctx.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: "text", text: "/help" }] })).stopReason).toBe("end_turn");
    });
  });

  it("bounds global/per-user connections and releases permits on DELETE and expiry", async () => {
    const host = await serve({ connections: 2, userConnections: 1, connectionMs: 500 });
    const a = await init(host.url);
    expect((await request(host.url, "POST", "a", undefined, initialize)).status).toBe(429);
    await init(host.url, "b");
    expect((await request(host.url, "POST", "c", undefined, initialize)).status).toBe(429);
    expect((await request(host.url, "DELETE", "a", a)).status).toBe(202);
    const c = await init(host.url, "c");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await request(host.url, "DELETE", "c", c)).status).toBe(404);
    await init(host.url, "a");
  });

  it("releases failed initialization reservations, caps sessions, and closes SSE during shutdown", async () => {
    const host = await serve({ connections: 1, userConnections: 1, sessions: 1 });
    expect((await request(host.url, "POST", "a", undefined, { ...initialize, params: {} })).status).toBe(400);
    await withClient(host.url, async (ctx) => {
      const session = await ctx.buildSession("/").start();
      await session.nextUpdate();
      await expect(ctx.buildSession("/").start()).rejects.toMatchObject({ code: -32600 });
    });
    const id = await init(host.url);
    const stream = await request(host.url, "GET", "a", id);
    expect(stream.status).toBe(200);
    const finished = stream.text().catch(() => "closed");
    await host.hosted.close();
    await finished;
    expect((await request(host.url, "POST", "a", undefined, initialize)).status).toBe(503);
  });

  it("rejects slow request bodies on a bounded deadline", async () => {
    const host = await serve({ httpMs: 50 });
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(host.url, { method: "POST", headers: { authorization: "Bearer a", "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.once("error", reject);
      req.write('{"jsonrpc":');
      cleanup.push(async () => { req.destroy(); });
    });
    expect(status).toBe(408);
  });

  it("bounds authentication concurrency before making GitHub requests", async () => {
    let unblock!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const host = await serve({ requests: 1 }, async () => {
      calls += 1;
      await gate;
      return Response.json({ id: 1, type: "User" });
    });
    const waiting = request(host.url, "GET", "a");
    try {
      await expect.poll(() => calls).toBe(1);
      expect((await request(host.url, "GET", "b")).status).toBe(429);
      expect(calls).toBe(1);
    } finally { unblock(); }
    expect((await waiting).status).toBe(400);
    expect((await request(host.url, "GET", "a")).status).toBe(400);
    expect(calls).toBe(2);
  });

  it("holds per-user HTTP permits while reading bodies and releases them on timeout", async () => {
    const host = await serve({ requests: 2, userRequests: 1, httpMs: 300 });
    const id = await init(host.url);
    const slow = httpRequest(host.url, {
      method: "POST",
      headers: { authorization: "Bearer a", "content-type": "application/json", "Acp-Connection-Id": id },
    });
    const ended = new Promise<number>((resolve, reject) => {
      slow.once("error", reject);
      slow.once("response", (response) => { response.resume(); response.once("end", () => resolve(response.statusCode ?? 0)); });
    });
    cleanup.push(async () => { slow.destroy(); });
    slow.write('{"jsonrpc":');
    await expect.poll(() => host.state.calls.filter((call) => call.path === "/user").length).toBe(2);
    expect((await request(host.url, "DELETE", "a", id)).status).toBe(429);
    expect((await request(host.url, "GET", "b")).status).toBe(400);
    expect(await ended).toBe(408);
    expect((await request(host.url, "DELETE", "a", id)).status).toBe(202);
  });

  it("bounds SSE streams independently and does not let them occupy ordinary request slots", async () => {
    const host = await serve({ requests: 1, userRequests: 1, streams: 2, userStreams: 1 });
    const a = await init(host.url, "a");
    const a2 = await init(host.url, "a2");
    const b = await init(host.url, "b");
    const streamA = await request(host.url, "GET", "a", a);
    expect(streamA.status).toBe(200);
    const finishedA = streamA.text().catch(() => "closed");
    expect((await request(host.url, "GET", "a2", a2)).status).toBe(429);
    const streamB = await request(host.url, "GET", "b", b);
    expect(streamB.status).toBe(200);
    const c = await init(host.url, "c");
    expect((await request(host.url, "GET", "c", c)).status).toBe(429);
    expect((await request(host.url, "DELETE", "a", a)).status).toBe(202);
    await finishedA;
    const next = await request(host.url, "GET", "a2", a2);
    expect(next.status).toBe(200);
    await next.body?.cancel();
    await streamB.body?.cancel();
  });

  it("enforces global and per-principal prompt concurrency across independent connections", async () => {
    const host = await serve({ operations: 2, userOperations: 1 });
    await withClient(host.url, async (a) => withClient(host.url, async (a2) => withClient(host.url, async (b) => withClient(host.url, async (c) => {
      const sessions = await Promise.all([a, a2, b, c].map((ctx) => ctx.buildSession("/").start()));
      for (const session of sessions) await session.nextUpdate();
      const [sa, sa2, sb, sc] = sessions as [ActiveSession, ActiveSession, ActiveSession, ActiveSession];
      host.state.stall = true;
      const pendingA = a.request(methods.agent.session.prompt, { sessionId: sa.sessionId, prompt: [{ type: "text", text: "/scan acme/widgets" }] });
      await expect.poll(() => host.state.calls.filter((call) => call.path === "/repos/acme/widgets").length).toBe(1);
      await expect(a2.request(methods.agent.session.prompt, { sessionId: sa2.sessionId, prompt: [{ type: "text", text: "/scan acme/widgets" }] })).rejects.toMatchObject({ code: -32600 });
      const pendingB = b.request(methods.agent.session.prompt, { sessionId: sb.sessionId, prompt: [{ type: "text", text: "/scan acme/widgets" }] });
      await expect.poll(() => host.state.calls.filter((call) => call.path === "/repos/acme/widgets").length).toBe(2);
      await expect(c.request(methods.agent.session.prompt, { sessionId: sc.sessionId, prompt: [{ type: "text", text: "/scan acme/widgets" }] })).rejects.toMatchObject({ code: -32600 });
      await a.notify(methods.agent.session.cancel, { sessionId: sa.sessionId });
      await b.notify(methods.agent.session.cancel, { sessionId: sb.sessionId });
      expect((await pendingA).stopReason).toBe("cancelled");
      expect((await pendingB).stopReason).toBe("cancelled");
      host.state.stall = false;
      expect((await turn(sa2, "/scan acme/widgets")).answer).toContain("workflow/job-timeout");
    }, "c"), "b"), "a2"));
  });

  it("closes a connection whose bounded output buffers stall without an SSE reader", async () => {
    const host = await serve({ outputStallMs: 100 });
    const id = await init(host.url);
    const stream = await request(host.url, "GET", "a", id);
    const reader = stream.body?.getReader();
    if (!reader) throw new Error("Missing SSE body");
    expect((await request(host.url, "POST", "a", id, { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/", mcpServers: [] } })).status).toBe(202);
    let text = "";
    let sessionId: string | undefined;
    for (let count = 0; count < 10 && !sessionId; count += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
      sessionId = /"sessionId":"([^"]+)"/.exec(text)?.[1];
    }
    if (!sessionId) throw new Error("Missing session ID in SSE response");
    await reader.cancel();
    for (let count = 0; count < 80; count += 1) {
      const response = await request(host.url, "POST", "a", id, { jsonrpc: "2.0", id: count + 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "/rules" }] } }, { "Acp-Session-Id": sessionId });
      if (response.status === 404) break;
      expect([202, 429]).toContain(response.status);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect((await request(host.url, "POST", "a", id, { jsonrpc: "2.0", id: 99, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "/help" }] } }, { "Acp-Session-Id": sessionId })).status).toBe(404);
    await init(host.url);
  });
});
