import { createHmac, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { createNodeMiddleware, Probot, ProbotOctokit } from "probot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { httpStatus } from "../../src/github/client.js";
import { marker } from "../../src/issues/markers.js";
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
  "POST /repos/{owner}/{repo}/check-runs",
  "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
  "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
  "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
].map((route) => {
  const names: string[] = [];
  const pattern = route.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    names.push(name);
    return name === "path" || name === "ref" ? "(.+)" : "([^/]+)";
  });
  return { route, names, pattern: new RegExp(`^${pattern}$`) };
});

async function harness(state: FakeApiState = {}) {
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
        return Response.json(response.data, { status: request.method === "POST" ? 201 : 200 });
      } catch (error) {
        const status = httpStatus(error);
        if (!status) throw error;
        return Response.json({ message: `HTTP ${status}` }, { status });
      }
    }
    unexpected.push(key);
    throw new Error(`Unexpected GitHub request: ${key}`);
  };
  const probot = new Probot({
    appId: 42,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    secret,
    logLevel: "silent",
    logFormat: "json",
    Octokit: ProbotOctokit.defaults({ request: { fetch: githubFetch }, retry: { enabled: false }, throttle: { enabled: false } }),
  });
  const middleware = await createNodeMiddleware(createApp({ uploadSarif: false, store: async () => undefined }), { probot });
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
    send: async (event: string, payload: unknown, signature: "valid" | "invalid" | "missing" = "valid") => {
      const body = JSON.stringify(payload);
      const response = await fetch(`http://127.0.0.1:${address.port}/api/github/webhooks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": randomUUID(),
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
      expect(callsTo(app.api, "DELETE /repos/{owner}/{repo}/git/refs/{ref}")).toHaveLength(1);
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
