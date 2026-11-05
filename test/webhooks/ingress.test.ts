import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { setImmediate, setTimeout } from "node:timers/promises";
import { Probot, ProbotOctokit } from "probot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDurableMiddleware, startDurableServer } from "../../src/webhooks/ingress.js";
import type { DeliveryQueue } from "../../src/webhooks/postgres-queue.js";
import { READINESS_CACHE_MS } from "../../src/webhooks/readiness.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const secret = randomUUID();
const event = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "acme/smoke" } });
const cleanups: Array<() => Promise<void>> = [];
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function probotFixture(path = "/api/github/webhooks") {
  const api = vi.fn<typeof fetch>(async () => { throw new Error("Ingress must not call GitHub"); });
  const probot = await new Probot({
    appId: 42, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    secret, webhookPath: path, logLevel: "silent", logFormat: "json",
    Octokit: ProbotOctokit.defaults({ request: { fetch: api } }),
  }).ready();
  return { probot, api };
}

async function harness(enqueue = vi.fn<DeliveryQueue["enqueue"]>().mockResolvedValue(undefined), path = "/api/github/webhooks", maxPayloadBytes = 1024, maxPending?: number) {
  const { probot, api } = await probotFixture(path);
  const error = vi.spyOn(probot.log, "error");
  const warn = vi.spyOn(probot.log, "warn");
  const middleware = await createDurableMiddleware(probot, { enqueue }, { timeoutMs: 500, maxPayloadBytes, ...(maxPending ? { maxPending } : {}) });
  const server = createServer((req, res) => {
    void middleware(req, res).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => { server.close((failure) => { if (failure) reject(failure); else resolve(); }); });
    expect(api).not.toHaveBeenCalled();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const url = `http://127.0.0.1:${address.port}${path}`;
  const headers = (body: string) => ({
    "content-type": "application/json; charset=utf-8",
    "x-github-event": "push",
    "x-github-delivery": randomUUID(),
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  });
  const send = async (body = event, overrides: Record<string, string> = {}, target = url) => {
    const response = await fetch(target, { method: "POST", headers: { ...headers(body), ...overrides }, body, signal: AbortSignal.timeout(3000) });
    await response.text();
    return response.status;
  };
  return { probot, enqueue, error, warn, url, headers, send };
}

async function serverHarness(checkReadiness = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)) {
  const { probot, api } = await probotFixture();
  const queue = { enqueue: vi.fn<DeliveryQueue["enqueue"]>().mockResolvedValue(undefined), checkReadiness };
  const server = await startDurableServer(probot, queue, { host: "127.0.0.1", port: 0 });
  cleanups.push(async () => { await server.stop(); expect(api).not.toHaveBeenCalled(); });
  const origin = `http://127.0.0.1:${server.port}`;
  const get = async (path: string) => {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(3000) });
    return { status: response.status, text: await response.text(), cacheControl: response.headers.get("cache-control") };
  };
  return { server, queue, origin, get };
}

afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe("durable HTTP health routes", () => {
  it("keeps liveness independent, reports readiness without private data, and preserves signed webhooks", async () => {
    const app = await serverHarness();
    expect(await app.get("/ping")).toMatchObject({ status: 200, text: "PONG" });
    expect(app.queue.checkReadiness).not.toHaveBeenCalled();
    expect(await app.get("/ready")).toEqual({ status: 200, text: "READY", cacheControl: "no-store" });
    expect(app.queue.checkReadiness).toHaveBeenCalledOnce();
    expect(app.queue.enqueue).not.toHaveBeenCalled();
    const response = await fetch(`${app.origin}/api/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(event).digest("hex")}`,
      },
      body: event,
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(app.queue.enqueue).toHaveBeenCalledOnce();
    expect((await app.get("/unknown")).status).toBe(404);
    const wrongMethod = await fetch(`${app.origin}/ready`, { method: "POST" });
    expect(wrongMethod.status).toBe(404);
    await wrongMethod.text();
    expect(app.queue.checkReadiness).toHaveBeenCalledOnce();
  });

  it("withholds readiness but not liveness on database failure and recovers on a fresh probe", async () => {
    const app = await serverHarness(vi.fn<() => Promise<void>>().mockRejectedValue(new Error("Private database connection details")));
    expect(await app.get("/ready")).toEqual({ status: 503, text: "NOT READY", cacheControl: "no-store" });
    expect(await app.get("/ping")).toMatchObject({ status: 200, text: "PONG" });
    app.queue.checkReadiness.mockResolvedValue(undefined);
    await setTimeout(READINESS_CACHE_MS);
    expect(await app.get("/ready")).toMatchObject({ status: 200, text: "READY" });
  });

  it("bounds a stalled probe while HTTP liveness continues responding", async () => {
    const gate = latch();
    const entered = latch();
    const app = await serverHarness(vi.fn(async () => { entered.release(); await gate.promise; }));
    try {
      const started = Date.now();
      const result = app.get("/ready");
      await entered.promise;
      expect(await app.get("/ping")).toMatchObject({ status: 200, text: "PONG" });
      expect(await result).toMatchObject({ status: 503, text: "NOT READY" });
      expect(Date.now() - started).toBeLessThan(2500);
    } finally { gate.release(); await setImmediate(); }
  });

  it("does not return ready when shutdown begins during an in-flight successful probe", async () => {
    const gate = latch();
    const entered = latch();
    const app = await serverHarness(vi.fn(async () => { entered.release(); await gate.promise; }));
    const response = app.get("/ready");
    try {
      await entered.promise;
      const stopped = app.server.stop();
      gate.release();
      expect(await response).toMatchObject({ status: 503, text: "NOT READY" });
      await stopped;
      await app.server.stop();
    } finally { gate.release(); await response; }
  });

  it.each(["/ping", "/ping/", "/ready", "/ready/"])("rejects a webhook path that conflicts with %s", async (path) => {
    const { probot, api } = await probotFixture(path);
    await expect(startDurableServer(probot, {
      enqueue: vi.fn().mockResolvedValue(undefined),
      checkReadiness: vi.fn().mockResolvedValue(undefined),
    }, { host: "127.0.0.1", port: 0 })).rejects.toThrow("reserved for health probes");
    expect(api).not.toHaveBeenCalled();
  });
});

describe("bounded durable HTTP ingress", () => {
  it("waits for committed persistence before returning success", async () => {
    const entered = latch();
    const gate = latch();
    const app = await harness(vi.fn(async () => { entered.release(); await gate.promise; }));
    let acknowledged = false;
    const result = app.send().then((status) => { acknowledged = true; return status; });
    try {
      await entered.promise;
      await setImmediate();
      expect(acknowledged).toBe(false);
      gate.release();
      expect(await result).toBe(200);
    } finally { gate.release(); await result; }
  });

  it.each(["commit", "failure"] as const)("reports a late %s after deadline without sending a second response", async (outcome) => {
    const gate = latch();
    const enqueue = vi.fn<DeliveryQueue["enqueue"]>().mockImplementationOnce(async () => {
      await gate.promise;
      if (outcome === "failure") throw new Error("Late database failure");
    }).mockResolvedValue(undefined);
    const app = await harness(enqueue);
    try {
      expect(await app.send()).toBe(503);
      gate.release();
      await vi.waitFor(() => {
        if (outcome === "commit") expect(app.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("finished after"));
        else expect(app.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("failed after"));
      });
      expect(await app.send()).toBe(200);
    } finally { gate.release(); await setImmediate(); }
  });

  it("fails a stalled body before signature verification or persistence", async () => {
    const app = await harness();
    const req = httpRequest(app.url, { method: "POST", headers: { ...app.headers(event), "content-length": String(Buffer.byteLength(event)) } });
    const response = new Promise<number>((resolve, reject) => {
      req.once("error", reject);
      req.once("response", (res) => { res.resume(); res.once("end", () => resolve(res.statusCode ?? 0)); });
    });
    req.write(event.slice(0, 10));
    try {
      expect(await response).toBe(503);
      expect(app.enqueue).not.toHaveBeenCalled();
    } finally { req.destroy(); }
  });

  it("bounds chunked payloads without trusting content-length", async () => {
    const app = await harness(undefined, undefined, 32);
    const req = httpRequest(app.url, { method: "POST", headers: app.headers(event) });
    const response = new Promise<number>((resolve, reject) => {
      req.once("error", reject);
      req.once("response", (res) => { res.resume(); res.once("end", () => resolve(res.statusCode ?? 0)); });
    });
    req.write(event);
    req.end();
    try { expect(await response).toBe(413); expect(app.enqueue).not.toHaveBeenCalled(); }
    finally { req.destroy(); }
  });

  it("rejects declared oversize payloads before persistence", async () => {
    const app = await harness(undefined, undefined, 32);
    expect(await app.send()).toBe(413);
    expect(app.enqueue).not.toHaveBeenCalled();
  });

  it("refuses new deliveries while abandoned persistence work is at capacity", async () => {
    const gate = latch();
    const enqueue = vi.fn<DeliveryQueue["enqueue"]>().mockImplementationOnce(async () => { await gate.promise; }).mockResolvedValue(undefined);
    const app = await harness(enqueue, undefined, 1024, 1);
    try {
      expect(await app.send()).toBe(503);
      expect(await app.send()).toBe(503);
      expect(enqueue).toHaveBeenCalledOnce();
      gate.release();
      await vi.waitFor(() => expect(app.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("finished after")));
      expect(await app.send()).toBe(200);
    } finally { gate.release(); await setImmediate(); }
  });

  it("accepts exactly the byte limit, including multi-byte UTF-8", async () => {
    const body = JSON.stringify({ ref: "\u00e9", repository: { full_name: "acme/smoke" } });
    const app = await harness(undefined, undefined, Buffer.byteLength(body));
    expect(await app.send(body)).toBe(200);
    expect(await app.send(`${body} `)).toBe(413);
    expect(app.enqueue).toHaveBeenCalledOnce();
  });

  it.each([
    { body: event, headers: { "x-hub-signature-256": "sha256=invalid" }, status: 400 },
    { body: "{", headers: {}, status: 400 },
    { body: event, headers: { "content-type": "text/plain" }, status: 415 },
    { body: event, headers: { "x-github-delivery": "" }, status: 400 },
  ])("rejects invalid requests ($status)", async ({ body, headers, status }) => {
    const app = await harness();
    expect(await app.send(body, headers)).toBe(status);
    expect(app.enqueue).not.toHaveBeenCalled();
  });

  it("preserves configured webhook paths and trailing-slash/query routing", async () => {
    const app = await harness(undefined, "/hooks/optimizer");
    expect(await app.send(event, {}, `${app.url}/?delivery=test`)).toBe(200);
    expect(await app.send(event, {}, app.url.replace("/hooks/optimizer", "/elsewhere"))).toBe(404);
    const response = await fetch(app.url);
    expect(response.status).toBe(404);
    await response.text();
    expect(app.enqueue).toHaveBeenCalledOnce();
  });

  it("records client abandonment and handles its late persistence failure", async () => {
    const entered = latch();
    const gate = latch();
    const app = await harness(vi.fn(async () => { entered.release(); await gate.promise; throw new Error("After disconnect"); }));
    const controller = new AbortController();
    const result = fetch(app.url, { method: "POST", headers: app.headers(event), body: event, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    try {
      await entered.promise;
      controller.abort();
      await rejected;
      await vi.waitFor(() => expect(app.error).toHaveBeenCalledWith(expect.objectContaining({ status: 499 }), expect.any(String)));
      gate.release();
      await vi.waitFor(() => expect(app.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("failed after")));
    } finally { controller.abort(); gate.release(); await rejected; }
  });
});
