import { createHmac, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { createNodeMiddleware, Probot, ProbotOctokit } from "probot";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { httpStatus } from "../../src/github/client.js";
import { marker, parseMarker } from "../../src/issues/markers.js";
import { PostgresWebhookQueue, type DeliveryQueue } from "../../src/webhooks/postgres-queue.js";
import { registerDurableIngress } from "../../src/webhooks/worker.js";
import { isolatedDatabase } from "../webhooks/database.js";
import { httpError } from "../experiments/fixtures.js";
import { callsTo, CLEAN, fakeApi, MISSING_TIMEOUT, TIMEOUT_ONLY, WORKFLOW, type FakeApiState } from "./api.js";

// Ephemeral test credentials only; the transport never calls a real GitHub endpoint.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const secret = randomUUID();
const installationToken = "test-installation-token";
const repository = { name: "widgets", full_name: "acme/widgets", owner: { login: "acme" }, default_branch: "main" };
const push = { repository, installation: { id: 123 }, ref: "refs/heads/main", commits: [{ modified: [WORKFLOW] }] };
const cleanups: Array<() => Promise<void>> = [];

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// Resolve concrete HTTP requests back to the service fake's route templates. Unknown routes fail closed.
const endpoints = [
  "GET /repos/{owner}/{repo}",
  "GET /repos/{owner}/{repo}/contents/{path}",
  "GET /repos/{owner}/{repo}/commits/{ref}",
  "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
  "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
  "GET /repos/{owner}/{repo}/issues",
  "GET /repos/{owner}/{repo}/labels",
  "GET /repos/{owner}/{repo}/git/ref/{ref}",
  "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
  "GET /repos/{owner}/{repo}/pulls/{pull_number}",
  "GET /repos/{owner}/{repo}/pulls",
  "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
  "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
  "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
  "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
  "POST /repos/{owner}/{repo}/issues",
  "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
  "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
  "POST /repos/{owner}/{repo}/labels",
  "POST /repos/{owner}/{repo}/git/trees",
  "POST /repos/{owner}/{repo}/git/commits",
  "POST /repos/{owner}/{repo}/git/refs",
  "POST /repos/{owner}/{repo}/pulls",
  "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
  "POST /graphql",
  "POST /repos/{owner}/{repo}/check-runs",
  "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
  "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
].map((route) => {
  const names: string[] = [];
  const pattern = route.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    names.push(name);
    return name === "path" || name === "ref" ? "(.+)" : "([^/]+)";
  });
  return { route, names, pattern: new RegExp(`^${pattern}$`) };
});

async function harness(state: FakeApiState = {}, durable?: Pick<DeliveryQueue, "enqueue">) {
  const api = fakeApi(state);
  let tokenRequests = 0;
  const unexpected: string[] = [];
  const githubFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe("https://api.github.com");
    if (request.method === "POST" && url.pathname === "/app/installations/123/access_tokens") {
      const jwt = request.headers.get("authorization")?.replace(/^bearer /i, "") ?? "";
      const [header, claims, signature] = jwt.split(".");
      expect(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
      expect(String(JSON.parse(Buffer.from(claims ?? "", "base64url").toString()).iss)).toBe("42");
      tokenRequests += 1;
      return Response.json({ token: installationToken, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {} }, { status: 201 });
    }
    expect(request.headers.get("authorization")).toBe(`token ${installationToken}`);
    const key = `${request.method} ${url.pathname}`;
    for (const endpoint of endpoints) {
      const match = endpoint.pattern.exec(key);
      if (!match) continue;
      const parameters: Record<string, unknown> = Object.fromEntries(url.searchParams);
      endpoint.names.forEach((name, index) => { parameters[name] = decodeURIComponent(match[index + 1] ?? ""); });
      if (request.method !== "GET") {
        const body = await request.text();
        if (body) Object.assign(parameters, JSON.parse(body));
      }
      try {
        const response = await api.request(endpoint.route, parameters);
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json(response.data, { status: request.method === "POST" && endpoint.route !== "POST /graphql" ? 201 : 200 });
      } catch (error) {
        const status = httpStatus(error);
        if (!status) throw error;
        return Response.json({ message: `HTTP ${status}` }, { status });
      }
    }
    unexpected.push(key);
    throw new Error(`Unexpected GitHub request: ${key}`);
  };
  const options = {
    appId: 42,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    secret,
    logLevel: "silent" as const,
    logFormat: "json" as const,
    Octokit: ProbotOctokit.defaults({ request: { fetch: githubFetch }, retry: { enabled: false }, throttle: { enabled: false } }),
  };
  const probot = new Probot(options);
  const app = createApp({ uploadSarif: false, store: async () => undefined });
  if (durable) await probot.load(app);
  const middleware = durable
    ? await createNodeMiddleware((ingress) => registerDurableIngress(ingress, durable), { probot: new Probot(options) })
    : await createNodeMiddleware(app, { probot });
  const server = createServer((req, res) => { void middleware(req, res, () => { res.writeHead(404).end(); }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    expect(unexpected).toEqual([]);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return {
    api,
    probot,
    tokenRequests: () => tokenRequests,
    send: async (event: string, payload: unknown, signature: "valid" | "invalid" | "missing" = "valid", deliveryId = randomUUID()) => {
      const body = JSON.stringify(payload);
      const response = await fetch(`http://127.0.0.1:${address.port}/api/github/webhooks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": deliveryId,
          ...(signature === "missing" ? {} : { "x-hub-signature-256": `sha256=${createHmac("sha256", signature === "valid" ? secret : "wrong-secret").update(body).digest("hex")}` }),
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      await response.text();
      return response.status;
    },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("signed GitHub App HTTP delivery", () => {
  it("acknowledges durable ingress without running the analysis in the request", async () => {
    const enqueue = vi.fn<DeliveryQueue["enqueue"]>().mockResolvedValue(undefined);
    const app = await harness({}, { enqueue });
    const id = randomUUID();
    expect(await app.send("push", push, "valid", id)).toBe(200);
    expect(enqueue).toHaveBeenCalledWith({ id, name: "push", payload: push });
    expect(app.api.calls).toHaveLength(0);
  });

  it("never acknowledges a delivery whose durable insert failed", async () => {
    const enqueue = vi.fn<DeliveryQueue["enqueue"]>().mockRejectedValue(new Error("Database unavailable"));
    const app = await harness({}, { enqueue });
    expect(await app.send("push", push)).toBe(500);
    expect(app.api.calls).toHaveLength(0);
  });

  it("rejects invalid signatures before persisting a delivery", async () => {
    const enqueue = vi.fn<DeliveryQueue["enqueue"]>().mockResolvedValue(undefined);
    const app = await harness({}, { enqueue });
    expect(await app.send("push", push, "invalid")).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("authenticates as the installation and creates a finding issue and a workflow fix PR", async () => {
    const app = await harness({
      config: `${TIMEOUT_ONLY}issues:\n  enabled: true\nfixes:\n  enabled: true\n`,
      refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } },
    });

    expect(await app.send("push", push)).toBe(200);
    expect(app.tokenRequests()).toBe(1);
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/issues")).toHaveLength(1);
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/pulls")[0]?.parameters).toMatchObject({ owner: "acme", repo: "widgets", base: "main" });
    expect(JSON.stringify(callsTo(app.api, "POST /repos/{owner}/{repo}/git/trees"))).toContain("timeout-minutes");
  });

  it.each([
    { fault: "label failure", route: "POST /repos/{owner}/{repo}/issues/{issue_number}/labels", before: true, status: 500 },
    { fault: "lost create response", route: "POST /repos/{owner}/{repo}/pulls", before: false, status: 500 },
    { fault: "reviewer failure", route: "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", before: true, status: 500 },
    { fault: "lost reviewer response", route: "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", before: false, status: 500 },
    { fault: "invalid reviewer", route: "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", before: true, status: 422 },
  ].flatMap((fault) => [false, true].map((humanEdits) => ({ ...fault, humanEdits }))))(
    "recovers $fault without rewriting the branch (human edits: $humanEdits)",
    async ({ route: failedRoute, before, humanEdits, status }) => {
      const state: FakeApiState = {
        config: `${TIMEOUT_ONLY}fixes:\n  enabled: true\n  branchPrefix: ci-bot/\n  labels: [ci]\n  reviewers: [alice, acme/platform]\n`,
        refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } }, pulls: [],
      };
      const app = await harness(state);
      const original = app.api.request.bind(app.api);
      let injected = false;
      vi.spyOn(app.api, "request").mockImplementation(async (route, parameters = {}) => {
        if (!injected && route === failedRoute && before) { injected = true; throw httpError(status); }
        const response = await original(route, parameters);
        if (!injected && route === failedRoute) { injected = true; throw httpError(status); }
        return response;
      });
      expect(await app.send("push", push)).toBe(status);
      const pull = state.pulls?.[0];
      if (!pull) throw new Error("Expected a persisted PR before failure");
      expect(pull.head.ref).toBe("ci-bot/workflow");
      if (humanEdits) {
        pull.head.sha = "maintainer-commit";
        pull.body += "\nMaintainer review notes.";
      }
      expect(await app.send("push", push)).toBe(200);
      expect(await app.send("push", push)).toBe(200);
      expect(callsTo(app.api, "POST /repos/{owner}/{repo}/pulls")).toHaveLength(1);
      expect(callsTo(app.api, "POST /repos/{owner}/{repo}/git/commits")).toHaveLength(1);
      expect(callsTo(app.api, "POST /repos/{owner}/{repo}/git/refs")).toHaveLength(1);
      expect(callsTo(app.api, "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers")).toHaveLength(1);
      expect(pull.labels).toEqual(["cicd-optimizer", "ci"]);
      expect(parseMarker(pull.body)?.attributes.pendingReviewers).toBeUndefined();
      expect(pull.requested_reviewers).toEqual([{ login: "alice" }]);
      expect(pull.requested_teams).toEqual([{ slug: "platform" }]);
      if (humanEdits) {
        expect(pull.head.sha).toBe("maintainer-commit");
        expect(pull.body).toContain("Maintainer review notes.");
      }
    },
  );

  it("defers draft reviewer setup until a scan after the PR becomes ready", async () => {
    const state: FakeApiState = {
      config: `${TIMEOUT_ONLY}fixes:\n  enabled: true\n  draft: true\n  reviewers: [alice]\n`,
      refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } }, pulls: [],
    };
    const app = await harness(state);
    expect(await app.send("push", push)).toBe(200);
    expect(await app.send("push", push)).toBe(200);
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers")).toHaveLength(0);
    const pull = state.pulls?.[0];
    if (!pull) throw new Error("Expected created draft");
    expect(parseMarker(pull.body)?.attributes.pendingReviewers).toBe("alice");
    pull.draft = false;
    expect(await app.send("push", push)).toBe(200);
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers")).toHaveLength(1);
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/git/commits")).toHaveLength(1);
    expect(parseMarker(pull.body)?.attributes.pendingReviewers).toBeUndefined();
  });

  it.each([false, true])("uses expected-head writes for an updated fix PR (concurrent human push: %s)", async (humanPush) => {
    const files = { [WORKFLOW]: MISSING_TIMEOUT };
    const heads: Record<string, string> = {};
    const state: FakeApiState = {
      config: `${TIMEOUT_ONLY}fixes:\n  enabled: true\n`,
      refs: { main: files }, pulls: [], branchHeads: heads,
    };
    const app = await harness(state);
    expect(await app.send("push", push)).toBe(200);
    const pull = state.pulls?.[0];
    if (!pull) throw new Error("Expected created fix PR");
    heads[pull.head.ref] = pull.head.sha;
    files[WORKFLOW] = MISSING_TIMEOUT.replace("echo hi", "echo changed");
    const original = app.api.request.bind(app.api);
    vi.spyOn(app.api, "request").mockImplementation(async (route, parameters = {}) => {
      if (route === "POST /graphql" && humanPush) {
        heads[pull.head.ref] = "human-commit";
        pull.head.sha = "human-commit";
        pull.body += "\nMaintainer notes during branch update.";
      }
      const response = await original(route, parameters);
      if (route === "POST /repos/{owner}/{repo}/git/commits") {
        return { status: 200, data: { sha: "next-bot-commit" } };
      }
      return response;
    });
    expect(await app.send("push", push)).toBe(humanPush ? 500 : 200);
    expect(pull.head.sha).toBe(humanPush ? "human-commit" : "next-bot-commit");
    expect(heads[pull.head.ref]).toBe(pull.head.sha);
    expect(callsTo(app.api, "POST /graphql")[0]?.parameters.variables).toMatchObject({
      input: { refUpdates: [{ beforeOid: "new-commit", afterOid: "next-bot-commit", force: true }] },
    });
    if (humanPush) {
      expect(parseMarker(pull.body)?.attributes).toMatchObject({ commit: "new-commit", pendingCommit: "next-bot-commit" });
      expect(pull.body).toContain("Update pending");
      expect(callsTo(app.api, "PATCH /repos/{owner}/{repo}/pulls/{pull_number}")).toHaveLength(1);
    } else {
      expect(parseMarker(pull.body)?.attributes.commit).toBe("next-bot-commit");
    }
    expect(await app.send("push", push)).toBe(200);
    expect(parseMarker(pull.body)?.attributes.pendingCommit).toBeUndefined();
    if (humanPush) {
      expect(pull.body).toContain("Maintainer notes during branch update.");
      expect(pull.body).toContain("Update interrupted");
    }
    expect(callsTo(app.api, "POST /graphql")).toHaveLength(1);
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/git/refs")).toHaveLength(1);
  });

  it.each(["lost ref response", "failed finalization"])("recovers %s through signed HTTP without a second branch update", async (fault) => {
    const files = { [WORKFLOW]: MISSING_TIMEOUT };
    const heads: Record<string, string> = {};
    const state: FakeApiState = { config: `${TIMEOUT_ONLY}fixes:\n  enabled: true\n`, refs: { main: files }, pulls: [], branchHeads: heads };
    const app = await harness(state);
    expect(await app.send("push", push)).toBe(200);
    const pull = state.pulls?.[0];
    if (!pull) throw new Error("Expected created fix PR");
    heads[pull.head.ref] = pull.head.sha;
    files[WORKFLOW] += "# new base contents\n";
    const original = app.api.request.bind(app.api);
    let injected = false;
    vi.spyOn(app.api, "request").mockImplementation(async (route, parameters = {}) => {
      if (!injected && fault === "failed finalization" && route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}" &&
        typeof parameters.body === "string" && !parseMarker(parameters.body)?.attributes.pendingCommit) {
        injected = true;
        throw httpError(500);
      }
      const response = await original(route, parameters);
      if (!injected && fault === "lost ref response" && route === "POST /graphql") { injected = true; throw httpError(500); }
      if (route === "POST /repos/{owner}/{repo}/git/commits") return { status: 200, data: { sha: "next-bot-commit" } };
      return response;
    });
    expect(await app.send("push", push)).toBe(500);
    expect(pull.head.sha).toBe("next-bot-commit");
    expect(parseMarker(pull.body)?.attributes).toMatchObject({ commit: "new-commit", pendingCommit: "next-bot-commit" });
    pull.body += "\nReview notes added after the failure.";
    expect(await app.send("push", push)).toBe(200);
    expect(await app.send("push", push)).toBe(200);
    expect(pull.body).toContain("Review notes added after the failure.");
    expect(parseMarker(pull.body)?.attributes.commit).toBe("next-bot-commit");
    expect(parseMarker(pull.body)?.attributes.pendingCommit).toBeUndefined();
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/git/commits")).toHaveLength(2);
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/pulls")).toHaveLength(1);
    expect(callsTo(app.api, "POST /graphql")).toHaveLength(1);
  });

  it.each([false, true])("recovers branch cleanup through signed HTTP (human push during deletion: %s)", async (humanPush) => {
    const files = { [WORKFLOW]: MISSING_TIMEOUT };
    const heads: Record<string, string> = {};
    const state: FakeApiState = { config: `${TIMEOUT_ONLY}fixes:\n  enabled: true\n`, refs: { main: files }, pulls: [], branchHeads: heads };
    const app = await harness(state);
    expect(await app.send("push", push)).toBe(200);
    const pull = state.pulls?.[0];
    if (!pull) throw new Error("Expected created PR");
    files[WORKFLOW] = CLEAN;
    let injected = false;
    const original = app.api.request.bind(app.api);
    vi.spyOn(app.api, "request").mockImplementation(async (route, parameters = {}) => {
      if (!injected && route === "POST /graphql" && humanPush) {
        heads[pull.head.ref] = "human";
        pull.head.sha = "human";
      }
      const response = await original(route, parameters);
      if (!injected && route === "POST /graphql") {
        injected = true;
        if (!humanPush) throw httpError(500);
      }
      return response;
    });
    expect(await app.send("push", push)).toBe(500);
    expect(pull.state).toBe("closed");
    expect(parseMarker(pull.body)?.attributes).toMatchObject({ cleanupHead: "new-commit", cleanupStatus: "pending" });
    expect(await app.send("push", push)).toBe(200);
    expect(parseMarker(pull.body)?.attributes.cleanupStatus).toBe(humanPush ? "changed" : "missing");
    expect(heads[pull.head.ref]).toBe(humanPush ? "human" : undefined);
    expect(callsTo(app.api, "POST /graphql")).toHaveLength(1);
  });

  it.each(["invalid", "missing"] as const)("rejects a %s signature without authenticating or writing", async (signature) => {
    const app = await harness();
    expect(await app.send("push", push, signature)).toBe(400);
    expect(app.tokenRequests()).toBe(0);
    expect(app.api.calls).toHaveLength(0);
  });

  it("ignores irrelevant branch pushes without calling GitHub", async () => {
    const app = await harness();
    expect(await app.send("push", { ...push, ref: "refs/heads/feature" })).toBe(200);
    expect(app.tokenRequests()).toBe(0);
    expect(app.api.calls).toHaveLength(0);
  });

  it("routes PR delivery through base policy and publishes the introduced finding", async () => {
    const app = await harness({
      config: TIMEOUT_ONLY,
      refs: { base: { [WORKFLOW]: CLEAN }, head: { [WORKFLOW]: MISSING_TIMEOUT } },
      pullFiles: [{ filename: WORKFLOW }],
    });
    expect(await app.send("pull_request", {
      repository, installation: { id: 123 }, action: "opened",
      pull_request: { number: 7, head: { sha: "head" }, base: { sha: "base", ref: "main" } },
    })).toBe(200);
    expect(callsTo(app.api, "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}")[0]?.parameters).toMatchObject({
      check_run_id: "99", conclusion: "failure", output: { title: "1 new finding" },
    });
  });

  it("returns a failed delivery when a push scan cannot complete", async () => {
    const app = await harness({ failOn: () => true });
    expect(await app.send("push", push)).toBe(500);
  });

  it.each(["push", "installation", "installation_repositories", "issue_comment", "workflow_run"])("serializes a push and overlapping %s without duplicate issues or fix PRs", async (event) => {
    const issues: Array<Record<string, unknown>> = [];
    const pullHeads: NonNullable<FakeApiState["pullHeads"]> = {};
    const app = await harness({
      config: `${TIMEOUT_ONLY}issues:\n  enabled: true\nfixes:\n  enabled: true\n`,
      refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } },
      issues, pullHeads,
    });
    const blocked = latch();
    const release = latch();
    const original = app.api.request.bind(app.api);
    let firstIssue = true;
    vi.spyOn(app.api, "request").mockImplementation(async (route, parameters = {}) => {
      const response = await original(route, parameters);
      if (route === "POST /repos/{owner}/{repo}/issues" || route === "POST /repos/{owner}/{repo}/pulls") {
        const data = response.data;
        if (!data || typeof data !== "object" || !("number" in data) || typeof data.number !== "number") throw new Error("Expected created issue/PR");
        if (route.endsWith("/issues") && firstIssue) {
          firstIssue = false;
          blocked.release();
          // Keep the first creation invisible so an overlapping reconciliation would plan a duplicate.
          await release.promise;
        }
        const pull = route.endsWith("/pulls");
        issues.push({
          number: data.number, title: parameters.title, body: parameters.body, state: "open",
          labels: [{ name: "cicd-optimizer" }], ...(pull ? { pull_request: { merged_at: null } } : {}),
        });
        if (pull) pullHeads[data.number] = { sha: "new-commit", ref: String(parameters.head) };
      }
      return response;
    });
    const first = app.send("push", push);
    await blocked.promise;
    const arrived = latch();
    app.probot.onAny(() => { arrived.release(); });
    const repositories = [{ full_name: "acme/widgets" }];
    const second = app.send(event, event === "push" ? push : event === "issue_comment" ? {
      repository, installation: { id: 123 }, action: "created",
      issue: { number: 42, pull_request: {} },
      comment: { body: "@cicd-optimizer close", author_association: "OWNER", user: { login: "maintainer", type: "User" } },
    } : event === "workflow_run" ? {
      repository, installation: { id: 123 }, action: "completed",
      workflow_run: {
        id: 200, workflow_id: 7, name: "CI", path: WORKFLOW, head_sha: "main-sha", head_branch: "main",
        status: "completed", conclusion: "success", event: "push", run_attempt: 1,
        created_at: "2026-11-01T00:00:00Z", run_started_at: "2026-11-01T00:00:05Z", updated_at: "2026-11-01T00:01:00Z",
      },
    } : {
      installation: { id: 123 }, action: event === "installation" ? "created" : "added",
      ...(event === "installation" ? { repositories } : { repositories_added: repositories }),
    });
    try {
      await arrived.promise;
      // API calls are in-memory promises; let this delivery's continuations run while the first is held.
      await setImmediate();
      expect(callsTo(app.api, "GET /repos/{owner}/{repo}")).toHaveLength(1);
    } finally {
      release.release();
      expect(await Promise.all([first, second])).toEqual([200, 200]);
    }
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/issues")).toHaveLength(1);
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/pulls")).toHaveLength(1);
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/git/commits")).toHaveLength(1);
    if (event === "issue_comment") {
      expect(callsTo(app.api, "PATCH /repos/{owner}/{repo}/pulls/{pull_number}")[0]?.parameters).toMatchObject({ pull_number: "42", state: "closed" });
      expect(callsTo(app.api, "POST /graphql")[0]?.parameters.variables).toMatchObject({
        input: { refUpdates: [{ beforeOid: "new-commit", afterOid: "0".repeat(40) }] },
      });
    }
    if (event === "workflow_run") {
      expect(callsTo(app.api, "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs")).toHaveLength(1);
    }
  });

  it("processes another repository while a scan is blocked", async () => {
    const app = await harness({ config: TIMEOUT_ONLY, refs: { main: { [WORKFLOW]: CLEAN } } });
    const blocked = latch();
    const release = latch();
    const original = app.api.request.bind(app.api);
    vi.spyOn(app.api, "request").mockImplementation(async (route, parameters = {}) => {
      if (route === "GET /repos/{owner}/{repo}" && parameters.repo === "widgets") {
        blocked.release();
        await release.promise;
      }
      return original(route, parameters);
    });
    const first = app.send("push", push);
    await blocked.promise;
    try {
      expect(await app.send("push", { ...push, repository: { ...repository, name: "other", full_name: "acme/other" } })).toBe(200);
      expect(callsTo(app.api, "GET /repos/{owner}/{repo}").map((call) => call.parameters.repo)).toEqual(["other"]);
    } finally {
      release.release();
      expect(await first).toBe(200);
    }
  });

  it("processes the next delivery after a scan fails", async () => {
    let attempts = 0;
    const app = await harness({
      config: TIMEOUT_ONLY,
      refs: { main: { [WORKFLOW]: CLEAN } },
      failOn: (route) => route === "GET /repos/{owner}/{repo}" && ++attempts === 1,
    });
    const outcomes = await Promise.all([app.send("push", push), app.send("push", push)]);
    expect(outcomes.sort()).toEqual([200, 500]);
    expect(await app.send("push", push)).toBe(200);
  });

  it("does not delay an independent PR check behind a blocked repository scan", async () => {
    const app = await harness({ config: TIMEOUT_ONLY, refs: { main: { [WORKFLOW]: CLEAN } } });
    const blocked = latch();
    const release = latch();
    const original = app.api.request.bind(app.api);
    vi.spyOn(app.api, "request").mockImplementation(async (route, parameters = {}) => {
      if (route === "GET /repos/{owner}/{repo}") {
        blocked.release();
        await release.promise;
      }
      return original(route, parameters);
    });
    const scan = app.send("push", push);
    await blocked.promise;
    try {
      expect(await app.send("pull_request", {
        repository, installation: { id: 123 }, action: "opened",
        pull_request: { number: 7, head: { sha: "head" }, base: { sha: "base", ref: "main" } },
      })).toBe(200);
      expect(callsTo(app.api, "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}")[0]?.parameters).toMatchObject({ conclusion: "success" });
    } finally {
      release.release();
      expect(await scan).toBe(200);
    }
  });

  it("denies a signed command from a read-only organization member", async () => {
    const app = await harness({
      collaboratorPermission: "read",
      issues: [{
        number: 42, title: "Workflow fixes", state: "open", labels: [{ name: "cicd-optimizer" }],
        body: marker("fix", "group:workflow", { signature: "s", commit: "c", rules: "workflow/job-timeout" }),
        pull_request: { merged_at: null },
      }],
    });
    expect(await app.send("issue_comment", {
      repository, installation: { id: 123 }, action: "created",
      issue: { number: 42, pull_request: {} },
      comment: { body: "@cicd-optimizer close", author_association: "MEMBER", user: { login: "reader", type: "User" } },
    })).toBe(200);
    expect(callsTo(app.api, "GET /repos/{owner}/{repo}/collaborators/{username}/permission")[0]?.parameters.username).toBe("reader");
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/issues/{issue_number}/comments")[0]?.parameters.body).toContain("only users with push access");
    expect(callsTo(app.api, "PATCH /repos/{owner}/{repo}/pulls/{pull_number}")).toHaveLength(0);
    expect(callsTo(app.api, "DELETE /repos/{owner}/{repo}/git/refs/{ref}")).toHaveLength(0);
  });

  it.each(["installation", "installation_repositories"])("attempts all %s scans and returns failure if any fail", async (event) => {
    const app = await harness({ failOn: () => true });
    const repositories = [{ full_name: "acme/one" }, { full_name: "acme/two" }];
    expect(await app.send(event, {
      installation: { id: 123 }, action: event === "installation" ? "created" : "added",
      ...(event === "installation" ? { repositories } : { repositories_added: repositories }),
    })).toBe(500);
    expect(callsTo(app.api, "GET /repos/{owner}/{repo}").map((call) => call.parameters.repo)).toEqual(["one", "two"]);
  });

  it.each(["installation", "installation_repositories"])("accepts %s delivery when all repository scans succeed", async (event) => {
    const app = await harness({ config: TIMEOUT_ONLY, refs: { main: { [WORKFLOW]: CLEAN } } });
    const repositories = [{ full_name: "acme/one" }, { full_name: "acme/two" }];
    expect(await app.send(event, {
      installation: { id: 123 }, action: event === "installation" ? "created" : "added",
      ...(event === "installation" ? { repositories } : { repositories_added: repositories }),
    })).toBe(200);
    expect(callsTo(app.api, "GET /repos/{owner}/{repo}").map((call) => call.parameters.repo)).toEqual(["one", "two"]);
    expect(app.tokenRequests()).toBe(1);
  });

  it.each([undefined, "", "  ", "development", "replace-me"])("refuses production startup with placeholder secret %j", async (value) => {
    const app = await harness();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEBHOOK_SECRET", value);
    await expect(app.probot.load(createApp())).rejects.toThrow("Production requires a non-placeholder WEBHOOK_SECRET");
  });

  it("allows a configured production webhook secret", async () => {
    const app = await harness();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEBHOOK_SECRET", secret);
    await expect(app.probot.load(createApp())).resolves.toBeUndefined();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("durable HTTP delivery through Postgres", () => {
  let db: Awaited<ReturnType<typeof isolatedDatabase>>;
  let ingress: PostgresWebhookQueue;
  let worker: PostgresWebhookQueue;
  beforeAll(async () => {
    db = await isolatedDatabase(process.env.DATABASE_URL!);
    ingress = new PostgresWebhookQueue(db.url);
    await ingress.initialize();
    worker = new PostgresWebhookQueue(db.url, { retryDelayMs: 0 });
  });
  afterAll(async () => {
    await ingress?.close();
    await worker?.close();
    await db?.close();
  });

  it("commits before acknowledgement, executes via another worker, and suppresses completed redelivery", async () => {
    const app = await harness({
      config: `${TIMEOUT_ONLY}issues:\n  enabled: true\nfixes:\n  enabled: true\n`,
      refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } },
    }, ingress);
    const id = randomUUID();
    expect(await app.send("push", push, "valid", id)).toBe(200);
    expect(await ingress.status(id)).toMatchObject([{ status: "pending", attempts: 0 }]);
    expect(app.api.calls).toHaveLength(0);
    expect(await worker.processNext((delivery) => app.probot.receive(delivery))).toMatchObject({ status: "completed", id });
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/issues")).toHaveLength(1);
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/pulls")).toHaveLength(1);
    expect(await app.send("push", push, "valid", id)).toBe(200);
    expect((await worker.processNext((delivery) => app.probot.receive(delivery))).status).toBe("idle");
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/issues")).toHaveLength(1);
  });

  it.each([false, true])("retries a partially created PR without another commit (human edits: %s)", async (humanEdits) => {
    let failLabels = true;
    const state: FakeApiState = {
      config: `${TIMEOUT_ONLY}fixes:\n  enabled: true\n`,
      refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } }, pulls: [],
      failOn: (route) => failLabels && route === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
    };
    const app = await harness(state, ingress);
    const id = randomUUID();
    expect(await app.send("push", push, "valid", id)).toBe(200);
    expect(await worker.processNext((delivery) => app.probot.receive(delivery))).toMatchObject({ status: "retrying", id, attempts: 1 });
    const pull = state.pulls?.[0];
    if (!pull) throw new Error("Expected a persisted unlabeled PR");
    expect(pull.labels).toEqual([]);
    if (humanEdits) pull.head.sha = "maintainer-commit";
    failLabels = false;
    expect(await worker.processNext((delivery) => app.probot.receive(delivery))).toMatchObject({ status: "completed", id });
    expect(await ingress.status(id)).toMatchObject([{ status: "completed", attempts: 2 }]);
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/pulls")).toHaveLength(1);
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/git/commits")).toHaveLength(1);
    expect(pull.labels).toEqual(["cicd-optimizer"]);
    if (humanEdits) expect(pull.head.sha).toBe("maintainer-commit");
    expect(await app.send("push", push, "valid", id)).toBe(200);
    expect((await worker.processNext((delivery) => app.probot.receive(delivery))).status).toBe("idle");
  });

  it("retries an applied branch update until its PR marker is finalized, without another commit", async () => {
    const files = { [WORKFLOW]: MISSING_TIMEOUT };
    const heads: Record<string, string> = {};
    const state: FakeApiState = { config: `${TIMEOUT_ONLY}fixes:\n  enabled: true\n`, refs: { main: files }, pulls: [], branchHeads: heads };
    const app = await harness(state, ingress);
    expect(await app.send("push", push)).toBe(200);
    expect((await worker.processNext((delivery) => app.probot.receive(delivery))).status).toBe("completed");
    const pull = state.pulls?.[0];
    if (!pull) throw new Error("Expected created fix PR");
    heads[pull.head.ref] = pull.head.sha;
    files[WORKFLOW] += "# new base contents\n";
    const original = app.api.request.bind(app.api);
    let failFinalization = true;
    vi.spyOn(app.api, "request").mockImplementation(async (route, parameters = {}) => {
      if (failFinalization && route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}" &&
        typeof parameters.body === "string" && !parseMarker(parameters.body)?.attributes.pendingCommit) throw httpError(500);
      const response = await original(route, parameters);
      if (route === "POST /repos/{owner}/{repo}/git/commits") return { status: 200, data: { sha: "next-bot-commit" } };
      return response;
    });
    const id = randomUUID();
    expect(await app.send("push", push, "valid", id)).toBe(200);
    expect(await worker.processNext((delivery) => app.probot.receive(delivery))).toMatchObject({ status: "retrying", id, attempts: 1 });
    expect(parseMarker(pull.body)?.attributes).toMatchObject({ commit: "new-commit", pendingCommit: "next-bot-commit" });
    expect(pull.head.sha).toBe("next-bot-commit");
    failFinalization = false;
    expect(await worker.processNext((delivery) => app.probot.receive(delivery))).toMatchObject({ status: "completed", id });
    expect(await ingress.status(id)).toMatchObject([{ status: "completed", attempts: 2 }]);
    expect(parseMarker(pull.body)?.attributes.commit).toBe("next-bot-commit");
    expect(parseMarker(pull.body)?.attributes.pendingCommit).toBeUndefined();
    expect(callsTo(app.api, "POST /repos/{owner}/{repo}/git/commits")).toHaveLength(2);
    expect(callsTo(app.api, "POST /graphql")).toHaveLength(1);
  });

  it("recovers a lost deletion response after PR closure without adopting a recreated human branch", async () => {
    const files = { [WORKFLOW]: MISSING_TIMEOUT };
    const heads: Record<string, string> = {};
    const state: FakeApiState = { config: `${TIMEOUT_ONLY}fixes:\n  enabled: true\n`, refs: { main: files }, pulls: [], branchHeads: heads };
    const app = await harness(state, ingress);
    expect(await app.send("push", push)).toBe(200);
    expect((await worker.processNext((delivery) => app.probot.receive(delivery))).status).toBe("completed");
    const pull = state.pulls?.[0];
    if (!pull) throw new Error("Expected created PR");
    files[WORKFLOW] = CLEAN;
    const original = app.api.request.bind(app.api);
    let injected = false;
    vi.spyOn(app.api, "request").mockImplementation(async (route, parameters) => {
      const response = await original(route, parameters);
      if (!injected && route === "POST /graphql") { injected = true; throw httpError(500); }
      return response;
    });
    const id = randomUUID();
    expect(await app.send("push", push, "valid", id)).toBe(200);
    expect(await worker.processNext((delivery) => app.probot.receive(delivery))).toMatchObject({ status: "retrying", id, attempts: 1 });
    expect(pull.state).toBe("closed");
    expect(heads[pull.head.ref]).toBeUndefined();
    heads[pull.head.ref] = "recreated-human-head";
    expect(await worker.processNext((delivery) => app.probot.receive(delivery))).toMatchObject({ status: "completed", id });
    expect(await ingress.status(id)).toMatchObject([{ status: "completed", attempts: 2 }]);
    expect(parseMarker(pull.body)?.attributes).toMatchObject({ cleanupHead: "new-commit", cleanupStatus: "changed" });
    expect(heads[pull.head.ref]).toBe("recreated-human-head");
    expect(callsTo(app.api, "POST /graphql")).toHaveLength(1);
  });
});
