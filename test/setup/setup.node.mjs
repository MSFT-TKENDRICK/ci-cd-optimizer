import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import {
  APP_PERMISSIONS, appJwt, registrationManifest, startSetup, loadSavedSetup,
  requestSavedAppVerification, checkSavedAppVerification,
} from "../../scripts/setup-app.mjs";
import { verifyConfiguredApp } from "../../scripts/verify-app.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });

async function fixture(t, options = {}) {
  const calls = [];
  const writes = [];
  const setup = await startSetup({ repo: "acme/widgets", organization: true, saved: options.saved }, {
    async request(path, params = {}) {
      calls.push({ path, ...params });
      if (path.startsWith("/app-manifests/")) return { id: 123, slug: "ci-cd-optimizer-acme", pem, client_secret: "NEVER-EXPOSE" };
      if (path === "/repos/acme/widgets/installation") return {
        id: 5, app_id: 123, account: { login: "acme" }, repository_selection: options.selection ?? "selected",
        permissions: APP_PERMISSIONS, ...options.installation,
      };
      if (path.endsWith("/access_tokens")) return { token: "installation-test-token" };
      if (path === "/repos/acme/widgets") {
        if (options.repositoryFailure) throw new Error("Repository verification failed");
        return { full_name: "acme/widgets" };
      }
      if (path === "/user") return { login: "octocat" };
      if (path === "/repos/acme/widgets/issues?state=open&per_page=1") return [];
      if (path === "/installation/token") {
        if (options.revokeFailure) throw new Error("Token revocation failed");
        return undefined;
      }
      throw new Error(`Unexpected request: ${path}`);
    },
    async command(args, input) {
      writes.push({ args, input });
      if (options.command) return options.command(args, input);
      await options.beforeWrite?.(args);
      if (options.writeFailure) throw new Error("GitHub CLI failed.");
      return "";
    },
  });
  t.after(() => setup.close());
  const first = await fetch(setup.url);
  const cookie = first.headers.get("set-cookie").split(";")[0];
  const html = await first.text();
  const state = html.match(/apps\/new\?state=([a-f0-9]+)/)?.[1];
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

test("browser form policy preserves local origins without sending cross-origin referrers", async (t) => {
  const f = await fixture(t);
  const page = await fetch(f.origin, { headers: { Cookie: f.cookie } });
  assert.equal(page.headers.get("referrer-policy"), "same-origin");
  assert.equal((await f.callback()).headers.get("referrer-policy"), "same-origin");
  const saved = await f.post("/save");
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get("referrer-policy"), "same-origin");
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

test("missing and opaque POST origins stay forbidden with a valid session and CSRF token", async (t) => {
  const f = await fixture(t);
  await f.callback();
  const csrf = (await f.fetchPage()).match(/name="csrf" value="([^"]+)"/)[1];
  for (const origin of [undefined, "null"]) {
    const result = await fetch(`${f.origin}/save`, {
      method: "POST",
      headers: { Cookie: f.cookie, ...(origin ? { Origin: origin } : {}) },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(result.status, 403);
    assert.match(await result.text(), /href="\/">Return to setup/);
  }
  assert.equal(f.writes.length, 0);
  assert.equal((await f.post("/save")).status, 303);
  assert.equal(f.writes.length, 2);
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

const saved = { app: { id: 123, slug: "ci-cd-optimizer-acme" }, copilot: true };
const verification = { id: 76, url: "https://github.com/acme/widgets/actions/runs/76", branch: "main", sha: "a".repeat(40) };
const successfulRun = {
  id: 76, repository: { full_name: "acme/widgets" }, path: ".github/workflows/cicd-optimizer-verify-app.yml",
  event: "workflow_dispatch", head_branch: "main", head_sha: verification.sha,
  status: "completed", conclusion: "success", run_attempt: 1,
};

function verificationCommand(options = {}) {
  return async (args, input) => {
    const path = args.find((arg) => arg.startsWith("repos/"));
    if (path === "repos/acme/widgets") return JSON.stringify({ full_name: "acme/widgets", default_branch: "main" });
    if (path === "repos/acme/widgets/commits/main") return JSON.stringify({ sha: verification.sha });
    if (path === "repos/acme/widgets/actions/workflows/cicd-optimizer-verify-app.yml/dispatches") {
      assert.deepEqual(JSON.parse(input), { ref: "main", inputs: { app_id: "123" }, return_run_details: true });
      assert.deepEqual(args.slice(-4), ["--method", "POST", "--input", "-"]);
      if (options.dispatchFailure) throw new Error("GitHub CLI failed.");
      return JSON.stringify(options.dispatch ?? { workflow_run_id: 76, html_url: verification.url });
    }
    if (path === "repos/acme/widgets/actions/runs/76") return JSON.stringify({ ...successfulRun, ...options.run });
    if (path === "repos/acme/widgets/actions/runs/76/attempts/1/jobs?per_page=100") {
      return JSON.stringify({ jobs: [{
        name: "Verify selected-repository App access", status: "completed", conclusion: "success",
        steps: [{ name: "Verify App installation", status: "completed", conclusion: options.stepConclusion ?? "success" }],
      }] });
    }
    if (args[0] === "workflow") return "";
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
}

test("resume reads identity and secret names without retrieving or replacing credentials", async () => {
  const commands = [];
  const result = await loadSavedSetup("acme/widgets", saved.app.slug, async (args) => {
    commands.push(args);
    if (args[0] === "api") return JSON.stringify({ ...saved.app, pem: "NEVER-RETURN" });
    if (args[0] === "variable") return "123\n";
    if (args[0] === "secret") return JSON.stringify([{ name: "CICD_OPTIMIZER_APP_PRIVATE_KEY" }, { name: "COPILOT_ASSIGN_TOKEN" }]);
    throw new Error("Unexpected command");
  });
  assert.deepEqual(result, saved);
  assert.equal(commands.length, 3);
  assert.deepEqual(commands.find((args) => args[0] === "secret"), ["secret", "list", "--repo", "acme/widgets", "--json", "name"]);
  assert.deepEqual(commands.find((args) => args[0] === "variable"), ["variable", "get", "CICD_OPTIMIZER_APP_ID", "--repo", "acme/widgets"]);
  assert.ok(!JSON.stringify(result).includes("NEVER-RETURN"));
});

test("resume rejects missing credentials and mismatched App identities instead of registering replacements", async () => {
  for (const options of [{ id: "456", secrets: [{ name: "CICD_OPTIMIZER_APP_PRIVATE_KEY" }] }, { id: "123", secrets: [] }]) {
    await assert.rejects(loadSavedSetup("acme/widgets", saved.app.slug, async (args) => {
      if (args[0] === "api") return JSON.stringify(saved.app);
      if (args[0] === "variable") return options.id;
      if (args[0] === "secret") return JSON.stringify(options.secrets);
      throw new Error("Unexpected command");
    }), /does not match|not saved/);
  }
  await assert.rejects(loadSavedSetup("acme/widgets", "../different-app", () => assert.fail("Invalid slug reached gh")), /existing App slug/);
  await assert.rejects(loadSavedSetup("acme/widgets", undefined, () => assert.fail("Missing slug reached gh")), /existing App slug/);
  await assert.rejects(startSetup({ repo: "acme/widgets", saved: { app: { id: 123 } } }), /Invalid saved App identity/);
});

test("saved-App verification binds the exact returned run to the default branch commit", async () => {
  assert.deepEqual(await requestSavedAppVerification("acme/widgets", saved.app, verificationCommand()), verification);
  assert.equal(await checkSavedAppVerification("acme/widgets", verification, verificationCommand()), true);
  assert.equal(await checkSavedAppVerification("acme/widgets", verification, verificationCommand({ run: { status: "queued", conclusion: null } })), false);
  for (const dispatch of [{}, { workflow_run_id: 76, html_url: "https://evil.example/run" }]) {
    await assert.rejects(requestSavedAppVerification("acme/widgets", saved.app, verificationCommand({ dispatch })), /did not return a verification run ID/);
  }
  await assert.rejects(requestSavedAppVerification("acme/widgets", saved.app, verificationCommand({ dispatchFailure: true })), /inspect Actions before retrying/);
});

test("unrelated, stale, failed, and skipped verification runs are not installation proof", async () => {
  for (const run of [
    { id: 77 }, { repository: { full_name: "acme/other" } }, { path: ".github/workflows/ci.yml" },
    { event: "push" }, { head_branch: "other" }, { head_sha: "b".repeat(40) },
    { conclusion: "failure" }, { conclusion: "cancelled" }, { conclusion: "skipped" }, { run_attempt: undefined },
  ]) {
    await assert.rejects(checkSavedAppVerification("acme/widgets", verification, verificationCommand({ run })), /does not match|did not succeed|verification attempt/);
  }
  await assert.rejects(checkSavedAppVerification("acme/widgets", verification, verificationCommand({ stepConclusion: "skipped" })), /step did not run successfully/);
  await assert.rejects(checkSavedAppVerification("acme/widgets", verification, verificationCommand({ run: { status: "unknown" } })), /unrecognized verification run status/);
});

test("resumed setup requires explicit dispatch and exact successful verification before advancing", async (t) => {
  const options = { run: { status: "in_progress", conclusion: null } };
  const f = await fixture(t, { saved, command: verificationCommand(options) });
  assert.match(f.html, /private key remains in GitHub/);
  assert.match(f.html, /--resume-app ci-cd-optimizer-acme/);
  assert.ok(!f.html.includes('name="manifest"'));
  assert.equal(f.writes.length, 0);
  assert.equal(f.calls.length, 0);
  for (const path of ["/save", "/copilot", "/scan", "/verify-result"]) assert.equal((await f.post(path)).status, 409);
  assert.equal((await f.callback()).status, 403);
  assert.equal((await f.post("/verify", {}, { Origin: "null" })).status, 403);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.post("/verify")).status, 303);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.post("/verify-result")).status, 303);
  assert.match(await f.fetchPage(), /still queued or running/);
  assert.equal((await f.post("/scan")).status, 409);
  options.run = {};
  assert.equal((await f.post("/verify-result")).status, 303);
  assert.match(await f.fetchPage(), /Installation and repository-scoped token verified/);
  assert.match(await f.fetchPage(), /Assignment token stored/);
  assert.equal((await f.post("/scan")).status, 303);
  assert.deepEqual(f.writes.at(-1).args, ["workflow", "run", "cicd-optimizer-scan.yml", "--repo", "acme/widgets"]);
  assert.ok(!f.writes.some(({ args }) => args[0] === "secret" || args[0] === "variable"));
});

test("failed rechecks and redispatches invalidate previous verification", async (t) => {
  const options = {};
  const f = await fixture(t, { saved, command: verificationCommand(options) });
  await f.post("/verify");
  await f.post("/verify-result");
  options.stepConclusion = "skipped";
  assert.equal((await f.post("/verify-result")).status, 502);
  assert.equal((await f.post("/scan")).status, 409);
  options.stepConclusion = "success";
  await f.post("/verify-result");
  options.dispatchFailure = true;
  assert.equal((await f.post("/verify")).status, 502);
  assert.equal((await f.post("/verify-result")).status, 409);
  assert.equal((await f.post("/scan")).status, 409);
});

test("verification runner rejects invalid or mismatched configuration before using the App key", async () => {
  const env = { GITHUB_REPOSITORY: "acme/widgets", APP_ID: "123", EXPECTED_APP_ID: "123", APP_PRIVATE_KEY: pem };
  for (const override of [
    { GITHUB_REPOSITORY: "" }, { APP_ID: "0" }, { APP_ID: "00123" }, { EXPECTED_APP_ID: "456" }, { APP_PRIVATE_KEY: "" },
  ]) {
    await assert.rejects(verifyConfiguredApp({ ...env, ...override }, () => assert.fail("Invalid configuration made an API call")), /configured App ID|PRIVATE_KEY is missing/);
  }
  const calls = [];
  await verifyConfiguredApp(env, async (path, params) => {
    calls.push({ path, ...params });
    if (path.endsWith("/installation")) return { id: 5, app_id: 123, account: { login: "acme" }, repository_selection: "selected", permissions: APP_PERMISSIONS };
    if (path.endsWith("/access_tokens")) return { token: "verification-test-token" };
    if (path === "/repos/acme/widgets") return { full_name: "acme/widgets" };
    if (path === "/installation/token") return undefined;
    throw new Error(`Unexpected request: ${path}`);
  });
  assert.deepEqual(calls.find((call) => call.path.endsWith("/access_tokens")).body, { repositories: ["widgets"], permissions: APP_PERMISSIONS });
  assert.equal(calls.at(-1).path, "/installation/token");
  assert.equal(calls.at(-1).method, "DELETE");
});

test("wrong App, account, permissions, suspension, or failed revocation cannot advance setup", async (t) => {
  for (const options of [
    { installation: { app_id: 456 } }, { installation: { account: { login: "other" } } },
    { installation: { suspended_at: "2026-01-01T00:00:00Z" } }, { installation: { permissions: { contents: "read" } } },
    { revokeFailure: true },
  ]) {
    const f = await fixture(t, options);
    await f.callback();
    await f.post("/save");
    assert.equal((await f.post("/verify")).status, 502);
    assert.equal((await f.post("/copilot", { token: "test-user-token" })).status, 409);
    if (!options.revokeFailure) assert.ok(!f.calls.some((call) => call.path.endsWith("/access_tokens")));
  }
});

test("saved-App workflow is manual, verification-only, and keeps inputs out of shell interpolation", async () => {
  const workflow = (await readFile(new URL("../../.github/workflows/cicd-optimizer-verify-app.yml", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(workflow, /on:\n  workflow_dispatch:/);
  assert.ok(!/^\s+(push|pull_request|schedule|workflow_run):/m.test(workflow));
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /name: Verify selected-repository App access/);
  assert.match(workflow, /name: Verify App installation\n\s+run: node scripts\/verify-app\.mjs/);
  assert.match(workflow, /EXPECTED_APP_ID: \$\{\{ inputs\.app_id \}\}/);
  assert.match(workflow, /APP_PRIVATE_KEY: \$\{\{ secrets\.CICD_OPTIMIZER_APP_PRIVATE_KEY \}\}/);
  assert.ok(!workflow.includes("COPILOT_ASSIGN_TOKEN"));
  assert.ok(!workflow.includes("cicd-optimizer-scan"));
  assert.ok(!workflow.includes("upload-artifact"));
});
