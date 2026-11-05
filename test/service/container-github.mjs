import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID, verify } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { URL } from "node:url";

export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);
export const WORKFLOW = ".github/workflows/ci.yml";
const HEAD_TREE = "c".repeat(40);
const BASE_TREE = "d".repeat(40);
const HEAD_BLOB = "e".repeat(40);
const BASE_BLOB = "f".repeat(40);
const headWorkflow = "on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n";
const baseWorkflow = headWorkflow.replace("    steps:", "    timeout-minutes: 15\n    steps:");
const configuration = "extends: []\nrules:\n  workflow/job-timeout: error\n";
const encoded = (content) => ({ encoding: "base64", content: Buffer.from(content).toString("base64") });

export function pullRequestPayload(installation = 123) {
  const owner = installation === 123 ? "acme" : "blocked";
  const repository = { name: "smoke", full_name: `${owner}/smoke`, owner: { login: owner }, default_branch: "main" };
  return {
    action: "opened", installation: { id: installation }, repository, number: 1,
    pull_request: {
      number: 1,
      head: { sha: HEAD, ref: "feature", repo: repository },
      base: { sha: BASE, ref: "main", repo: repository },
    },
  };
}

/** Synthetic HTTP API; only test-signed JWTs and this fixture's installation-scoped tokens are accepted. */
export async function startGitHubFixture(publicKey, host = "127.0.0.1") {
  const tokens = new Map([[123, `test-${randomUUID()}`], [456, `test-${randomUUID()}`]]);
  const issued = [];
  const denied = [];
  const checks = [];
  const requests = [];
  const errors = [];
  let allowBlocked = false;

  async function route(request) {
    const url = new URL(request.url, "http://fixture.invalid");
    const method = request.method;
    const path = url.pathname;
    requests.push({ method, path });
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      assert.ok(length <= 100_000, "Fixture request body exceeded its limit");
      chunks.push(chunk);
    }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const auth = /^\/api\/v3\/app\/installations\/(123|456)\/access_tokens$/.exec(path);
    if (method === "POST" && auth) {
      const jwt = request.headers.authorization?.replace(/^bearer /i, "") ?? "";
      const [header, claims, signature] = jwt.split(".");
      assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature ?? "", "base64url")), "Invalid test App JWT signature");
      assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256");
      const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
      assert.equal(String(payload.iss), "42");
      const now = Date.now() / 1000;
      assert.ok(Number.isFinite(payload.iat) && payload.iat <= now + 10 && payload.iat >= now - 120, "Invalid JWT issued-at claim");
      assert.ok(Number.isFinite(payload.exp) && payload.exp > now && payload.exp <= now + 610, "Invalid JWT expiration");
      const id = Number(auth[1]);
      if (id === 456 && !allowBlocked) {
        denied.push(id);
        return { status: 403, data: { message: "Installation access refused by the smoke fixture" } };
      }
      issued.push(id);
      return { status: 201, data: { token: tokens.get(id), expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { checks: "write", contents: "read" } } };
    }

    const repository = /^\/api\/v3\/repos\/(acme|blocked)\/smoke(\/.*)$/.exec(path);
    assert.ok(repository, `Unexpected fixture path: ${method} ${path}`);
    const owner = repository[1];
    const installation = owner === "acme" ? 123 : 456;
    assert.ok(issued.includes(installation), "Repository request arrived before its installation token was issued");
    assert.ok(request.headers.authorization === `token ${tokens.get(installation)}`, "Repository request used the wrong installation token");
    const resource = decodeURIComponent(repository[2]);
    if (method === "POST" && resource === "/check-runs") {
      assert.equal(body.name, "CI/CD Optimizer");
      assert.equal(body.head_sha, HEAD);
      assert.equal(body.status, "in_progress");
      const check = { ...body, id: checks.length + 1, owner };
      checks.push(check);
      return { status: 201, data: { id: check.id } };
    }
    if (method === "PATCH" && /^\/check-runs\/\d+$/.test(resource)) {
      const check = checks.find((item) => item.id === Number(resource.split("/").at(-1)) && item.owner === owner);
      assert.ok(check, "Unknown or cross-repository check update");
      Object.assign(check, body);
      return { status: 200, data: { id: check.id } };
    }
    if (method === "GET" && resource === "/contents/.github/ci-cd-optimizer.yml") {
      assert.equal(url.searchParams.get("ref"), BASE, "Policy must be read from the immutable base commit");
      return { status: 200, data: encoded(configuration) };
    }
    if (method === "GET" && resource === "/pulls/1/files") return { status: 200, data: [{ filename: WORKFLOW }] };
    for (const [sha, tree, blob, contents] of [[HEAD, HEAD_TREE, HEAD_BLOB, headWorkflow], [BASE, BASE_TREE, BASE_BLOB, baseWorkflow]]) {
      if (method === "GET" && resource === `/commits/${sha}`) return { status: 200, data: { sha, commit: { tree: { sha: tree } } } };
      if (method === "GET" && resource === `/git/trees/${tree}`) {
        assert.equal(url.searchParams.get("recursive"), "1");
        return { status: 200, data: { truncated: false, tree: [{ path: WORKFLOW, type: "blob", sha: blob, size: Buffer.byteLength(contents) }] } };
      }
      if (method === "GET" && resource === `/git/blobs/${blob}`) return { status: 200, data: encoded(contents) };
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  }

  const server = createServer((request, response) => {
    void route(request).then(({ status, data }) => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    }).catch((error) => {
      errors.push(error);
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ message: "Fixture request rejected" }));
    });
  });
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port, requests, issued, denied, checks,
    restoreInstallation: () => { allowBlocked = true; },
    assertClean: () => { assert.deepEqual(errors, [], "Unexpected API request or authentication failure"); },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
