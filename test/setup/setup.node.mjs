import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { APP_PERMISSIONS, appJwt, registrationManifest, startSetup } from "../../scripts/setup-app.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });

async function fixture(t, options = {}) {
  const calls = [];
  const writes = [];
  const setup = await startSetup({ repo: "acme/widgets", organization: true }, {
    async request(path, params = {}) {
      calls.push({ path, ...params });
      if (path.startsWith("/app-manifests/")) return { id: 123, slug: "ci-cd-optimizer-acme", pem, client_secret: "NEVER-EXPOSE" };
      if (path === "/repos/acme/widgets/installation") return {
        id: 5, app_id: 123, account: { login: "acme" }, repository_selection: options.selection ?? "selected",
        permissions: APP_PERMISSIONS,
      };
      if (path.endsWith("/access_tokens")) return { token: "installation-test-token" };
      if (path === "/repos/acme/widgets") {
        if (options.repositoryFailure) throw new Error("Repository verification failed");
        return { full_name: "acme/widgets" };
      }
      if (path === "/user") return { login: "octocat" };
      if (path === "/repos/acme/widgets/issues?state=open&per_page=1") return [];
      if (path === "/installation/token") return undefined;
      throw new Error(`Unexpected request: ${path}`);
    },
    async command(args, input) {
      writes.push({ args, input });
      await options.beforeWrite?.(args);
      if (options.writeFailure) throw new Error("GitHub CLI failed.");
      return "";
    },
  });
  t.after(() => setup.close());
  const first = await fetch(setup.url);
  const cookie = first.headers.get("set-cookie").split(";")[0];
  const html = await first.text();
  const state = html.match(/apps\/new\?state=([a-f0-9]+)/)[1];
  const fetchPage = async () => (await fetch(setup.origin, { headers: { Cookie: cookie } })).text();
  const callback = () => fetch(`${setup.origin}/registered?state=${state}&code=registration-code`, { headers: { Cookie: cookie }, redirect: "manual" });
  const post = async (path, fields = {}, overrides = {}) => {
    const page = await fetchPage();
    const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1];
    return fetch(`${setup.origin}${path}`, {
      method: "POST", redirect: "manual",
      headers: { Cookie: cookie, Origin: setup.origin, ...overrides },
      body: new URLSearchParams({ csrf, ...fields }),
    });
  };
  return { ...setup, calls, writes, cookie, state, html, fetchPage, callback, post };
}

test("actions-only manifest uses the hosted manifest's permissions but no OAuth or webhook", async () => {
  const manifest = registrationManifest("acme/widgets", "http://127.0.0.1:1234");
  assert.equal(Object.hasOwn(manifest, "hook_attributes"), false);
  assert.equal(manifest.url, "https://github.com/acme/widgets");
  assert.equal(manifest.redirect_url, "http://127.0.0.1:1234/registered");
  assert.equal(manifest.setup_url, "http://127.0.0.1:1234/installed");
  assert.equal(manifest.request_oauth_on_install, false);
  assert.equal(manifest.public, false);
  assert.deepEqual(manifest.default_events, []);
  const yaml = (await readFile(new URL("../../app.yml", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const permissionBlock = yaml.split("default_permissions:\n")[1].split("default_events:")[0];
  const permissions = Object.fromEntries([...permissionBlock.matchAll(/^ {2}(\w+): (read|write)$/gm)].map((match) => [match[1], match[2]]));
  assert.deepEqual(APP_PERMISSIONS, permissions);
});

test("registration form submits a webhook-free manifest with local browser callbacks", async (t) => {
  const f = await fixture(t);
  const encoded = f.html.match(/name="manifest" value="([^"]+)"/)[1];
  const manifest = JSON.parse(encoded.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
  assert.equal(Object.hasOwn(manifest, "hook_attributes"), false);
  assert.deepEqual(manifest, registrationManifest("acme/widgets", f.origin));
  assert.equal(manifest.redirect_url, `${f.origin}/registered`);
  assert.equal(manifest.setup_url, `${f.origin}/installed`);
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});

test("App JWT is a short-lived signed RS256 credential", () => {
  const jwt = appJwt({ id: 123, pem });
  const [header, payload, signature] = jwt.split(".");
  assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")), true);
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, 123);
  assert.ok(claims.exp - claims.iat <= 600);
});

test("registration, credential save, installation verification and agent authorization are separate explicit steps", async (t) => {
  const f = await fixture(t);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.callback()).status, 303);
  const registered = await f.fetchPage();
  assert.ok(!registered.includes(pem));
  assert.ok(!registered.includes("NEVER-EXPOSE"));
  assert.equal(f.writes.length, 0);
  assert.equal((await f.post("/save")).status, 303);
  assert.deepEqual(f.writes[0], { args: ["secret", "set", "CICD_OPTIMIZER_APP_PRIVATE_KEY", "--repo", "acme/widgets"], input: pem });
  assert.equal((await f.post("/verify")).status, 303);
  const minted = f.calls.find((call) => call.path.endsWith("/access_tokens"));
  assert.deepEqual(minted.body.repositories, ["widgets"]);
  assert.ok(f.calls.some((call) => call.path === "/installation/token" && call.method === "DELETE"));
  assert.ok((await f.fetchPage()).includes("Not authorized yet"));
  assert.equal((await f.post("/copilot", { token: "test-user-token" })).status, 303);
  assert.ok(!f.writes.at(-1).args.includes("test-user-token"));
  assert.equal(f.writes.at(-1).input, "test-user-token");
  assert.ok(!(await f.fetchPage()).includes("test-user-token"));
  assert.equal((await f.post("/scan")).status, 303);
  assert.deepEqual(f.writes.at(-1).args, ["workflow", "run", "cicd-optimizer-scan.yml", "--repo", "acme/widgets"]);
  assert.equal((await f.callback()).status, 403);
});

test("loopback setup rejects missing cookies, invalid state, cross-origin writes and missing CSRF", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin)).status, 403);
  assert.equal((await fetch(`${f.origin}/registered?state=wrong&code=x`, { headers: { Cookie: f.cookie } })).status, 403);
  assert.equal((await fetch(`${f.origin}/registered?state=${f.state}&code=x`)).status, 403);
  assert.equal((await f.callback()).status, 303);
  assert.equal((await f.post("/save", {}, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await f.post("/save", { csrf: "wrong" })).status, 403);
  assert.equal(f.writes.length, 0);
  assert.equal(f.calls.length, 1);
});

test("installation callback is not trusted and cannot bypass verification", async (t) => {
  const f = await fixture(t);
  await f.callback();
  await f.post("/save");
  await fetch(`${f.origin}/installed?installation_id=5`, { headers: { Cookie: f.cookie } });
  assert.equal((await f.post("/copilot", { token: "test-user-token" })).status, 409);
  assert.equal(f.calls.length, 1);
});

test("all-repository installation is rejected before minting credentials", async (t) => {
  const f = await fixture(t, { selection: "all" });
  await f.callback();
  await f.post("/save");
  const result = await f.post("/verify");
  assert.equal(result.status, 502);
  assert.match(await result.text(), /Only select repositories/);
  assert.ok(!f.calls.some((call) => call.path.endsWith("/access_tokens")));
});

test("verification revokes its temporary token even when repository access fails", async (t) => {
  const f = await fixture(t, { repositoryFailure: true });
  await f.callback();
  await f.post("/save");
  assert.equal((await f.post("/verify")).status, 502);
  assert.equal(f.calls.at(-1).path, "/installation/token");
  assert.equal((await f.post("/copilot", { token: "test-user-token" })).status, 409);
});

test("secret-save failure is visible and does not advance installation", async (t) => {
  const f = await fixture(t, { writeFailure: true });
  await f.callback();
  assert.equal((await f.post("/save")).status, 502);
  assert.equal((await f.post("/verify")).status, 409);
  assert.ok(!(await f.fetchPage()).includes(pem));
});

test("overlapping streamed forms cannot perform concurrent credential writes", async (t) => {
  let release;
  let entered;
  let secrets = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const writing = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { async beforeWrite(args) {
    if (args[0] !== "secret") return;
    if (++secrets > 1) throw new Error("Concurrent credential write");
    entered();
    await gate;
  } });
  await f.callback();
  const csrf = (await f.fetchPage()).match(/name="csrf" value="([^"]+)"/)[1];
  const streamed = () => {
    let req;
    const result = new Promise((resolve, reject) => {
      req = httpRequest(`${f.origin}/save`, {
        method: "POST", headers: { Cookie: f.cookie, Origin: f.origin, Expect: "100-continue" },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject);
    });
    const ready = once(req, "continue");
    req.flushHeaders();
    return { req, ready, result };
  };
  const first = streamed();
  const second = streamed();
  try {
    await Promise.all([first.ready, second.ready]);
    first.req.end(new URLSearchParams({ csrf }).toString());
    await writing;
    second.req.end(new URLSearchParams({ csrf }).toString());
    assert.equal(await second.result, 409);
    assert.equal(secrets, 1);
  } finally { release(); }
  assert.equal(await first.result, 303);
});
