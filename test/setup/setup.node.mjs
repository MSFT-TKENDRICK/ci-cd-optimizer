import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { APP_PERMISSIONS, registrationManifest } from "../../scripts/setup-app.mjs";
import { THEME_SCRIPT, scriptHash } from "../../scripts/setup-pages.mjs";
import { SETUP_STEPS, prepareSetup, startSetup } from "../../scripts/setup-session.mjs";
import { fixture, makeAssets, pem, saved, verificationCommand } from "./helpers.mjs";

const run = promisify(execFile);
const KEY_LINE = pem.split("\n")[1];
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function registered(t, options) {
  const f = await fixture(t, options);
  assert.equal((await f.callback()).status, 303);
  return f;
}

async function saveKey(t, options) {
  const f = await registered(t, options);
  assert.equal((await f.post("save-credentials")).status, 200);
  return f;
}

test("registration state carries a webhook-free manifest with local browser callbacks", async (t) => {
  const f = await fixture(t);
  const { registration } = f.initial;
  const manifest = JSON.parse(registration.manifest);
  assert.equal(Object.hasOwn(manifest, "hook_attributes"), false);
  assert.deepEqual(manifest, registrationManifest("acme/widgets", f.origin));
  assert.equal(manifest.redirect_url, `${f.origin}/registered`);
  assert.equal(manifest.setup_url, `${f.origin}/installed`);
  assert.match(registration.action, /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=[a-f0-9]{64}$/);
  assert.equal(f.initial.current, "register");
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
  const personal = await fixture(t, { organization: false });
  assert.match(personal.initial.registration.action, /^https:\/\/github\.com\/settings\/apps\/new\?state=[a-f0-9]{64}$/);
});

test("browser policy preserves local origins without sending cross-origin referrers", async (t) => {
  const f = await registered(t);
  const shell = await fetch(f.origin, { headers: { Cookie: f.cookie } });
  assert.equal(shell.headers.get("referrer-policy"), "same-origin");
  assert.equal((await f.callback()).headers.get("referrer-policy"), "same-origin");
  assert.equal((await f.api("state")).headers.get("referrer-policy"), "same-origin");
  assert.equal((await f.post("save-credentials")).headers.get("referrer-policy"), "same-origin");
});

test("registration, credential save, installation verification, agent authorization and scan are separate explicit steps", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.initial.steps.map(({ id, status }) => [id, status]), [
    ["register", "current"], ["credentials", "upcoming"], ["install", "upcoming"], ["authorize", "upcoming"], ["scan", "upcoming"],
  ]);
  assert.equal(f.writes.length, 0);

  const callback = await f.callback();
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), `/?session=${f.session}`);
  let state = await f.state();
  assert.deepEqual(state.app, { id: 123, slug: "ci-cd-optimizer-acme" });
  assert.equal(state.registration, null);
  assert.equal(state.urls.register, null);
  assert.equal(state.urls.install, "https://github.com/apps/ci-cd-optimizer-acme/installations/new");
  assert.equal(state.current, "credentials");
  assert.equal(f.writes.length, 0);

  state = await (await f.post("save-credentials")).json();
  assert.equal(state.credentials.saved, true);
  assert.equal(state.current, "install");
  assert.deepEqual(f.writes, [
    { args: ["secret", "set", "CICD_OPTIMIZER_APP_PRIVATE_KEY", "--repo", "acme/widgets"], input: pem },
    { args: ["variable", "set", "CICD_OPTIMIZER_APP_ID", "--repo", "acme/widgets", "--body", "123"], input: undefined },
  ]);

  state = await (await f.post("verify")).json();
  assert.equal(state.installation.status, "verified");
  assert.equal(state.current, "authorize");
  assert.equal(state.copilot.saved, false);
  const minted = f.calls.find((call) => call.path.endsWith("/access_tokens"));
  assert.deepEqual(minted.body.repositories, ["widgets"]);
  assert.ok(f.calls.some((call) => call.path === "/installation/token" && call.method === "DELETE"));

  state = await (await f.post("authorize-copilot", { token: "test-user-token" })).json();
  assert.equal(state.copilot.saved, true);
  assert.equal(state.current, "scan");
  const tokenWrite = f.writes.at(-1);
  assert.deepEqual(tokenWrite.args, ["secret", "set", "COPILOT_ASSIGN_TOKEN", "--repo", "acme/widgets"]);
  assert.equal(tokenWrite.input, "test-user-token");
  assert.ok(!f.writes.some(({ args }) => args.join(" ").includes("test-user-token")));
  assert.ok(!JSON.stringify(state).includes("test-user-token"));

  state = await (await f.post("run-scan")).json();
  assert.equal(state.scan.requested, true);
  assert.equal(state.current, null);
  assert.deepEqual(f.writes.at(-1).args, ["workflow", "run", "cicd-optimizer-scan.yml", "--repo", "acme/widgets"]);
  assert.match(state.message, /requested/);
  assert.match(state.message, /not proof of assignment/);
  assert.deepEqual(state.steps.map(({ status }) => status), Array(SETUP_STEPS.length).fill("complete"));
  assert.equal((await f.callback()).status, 403);
});

test("steps cannot run out of order", async (t) => {
  const f = await fixture(t);
  const every = ["save-credentials", "verify", "check-verification", "authorize-copilot", "run-scan"];
  for (const action of every) assert.equal((await f.post(action, { token: "test-user-token" })).status, 409, action);
  await f.callback();
  for (const action of every.slice(1)) assert.equal((await f.post(action, { token: "test-user-token" })).status, 409, action);
  await f.post("save-credentials");
  assert.equal((await f.post("save-credentials")).status, 409);
  for (const action of every.slice(2)) assert.equal((await f.post(action, { token: "test-user-token" })).status, 409, action);
  assert.equal(f.writes.length, 2);
  assert.equal(f.calls.length, 1);
});

test("the shell and static pages carry strict content security policies", async (t) => {
  const f = await fixture(t);
  const shell = await fetch(f.url);
  const policy = shell.headers.get("content-security-policy");
  assert.match(policy, /^default-src 'none'; /);
  assert.ok(policy.includes(`script-src 'self' ${scriptHash(THEME_SCRIPT)};`));
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(policy, /form-action 'self' https:\/\/github\.com/);
  assert.doesNotMatch(policy, /unsafe-eval|script-src[^;]*unsafe-inline/);
  assert.equal(shell.headers.get("x-content-type-options"), "nosniff");
  assert.equal(shell.headers.get("cache-control"), "no-store");

  const bounce = await fetch(`${f.origin}/register?session=${f.session}`);
  const bouncePolicy = bounce.headers.get("content-security-policy");
  assert.ok(bouncePolicy.includes(`script-src ${scriptHash(THEME_SCRIPT)};`));
  assert.match(bouncePolicy, /form-action https:\/\/github\.com/);
  assert.match(bouncePolicy, /default-src 'none'/);
  const installed = await fetch(`${f.origin}/installed`);
  assert.match(installed.headers.get("content-security-policy"), /form-action 'none'/);
  const notFound = await fetch(`${f.origin}/missing`);
  assert.equal(notFound.status, 404);
  assert.match(notFound.headers.get("content-security-policy"), /form-action 'none'/);
});

test("the shell and assets are served verbatim and never contain the session", async (t) => {
  const f = await fixture(t);
  const html = await readFile(`${f.assets}/index.html`, "utf8");
  const shell = await fetch(f.url);
  assert.equal(await shell.text(), html);
  assert.match(shell.headers.get("content-type"), /^text\/html/);
  assert.ok(!html.includes(f.session));
  const script = await fetch(`${f.origin}/assets/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /^text\/javascript/);
  const style = await fetch(`${f.origin}/assets/app.css`);
  assert.equal(style.status, 200);
  assert.match(style.headers.get("content-type"), /^text\/css/);
  const bare = await fetch(f.origin);
  assert.equal(bare.status, 200);
  assert.equal(bare.headers.get("set-cookie"), null);
  assert.equal((await fetch(`${f.origin}/?session=wrong`)).headers.get("set-cookie"), null);
  assert.match(shell.headers.get("set-cookie"), /^optimizer_setup_\d+=[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=3600$/);
});

test("the API requires the session header and never accepts the cookie alone", async (t) => {
  const f = await fixture(t);
  const bare = (init = {}) => fetch(`${f.origin}/api/state`, init);
  assert.equal((await bare()).status, 401);
  assert.equal((await bare({ headers: { Cookie: f.cookie } })).status, 401);
  assert.equal((await bare({ headers: { "X-Setup-Session": "wrong" } })).status, 401);
  assert.equal((await bare({ headers: { "X-Setup-Session": `${f.session}0` } })).status, 401);
  assert.equal((await bare({ headers: { "X-Setup-Session": f.session } })).status, 200);
  await f.callback();
  const unauthenticated = await fetch(`${f.origin}/api/save-credentials`, {
    method: "POST",
    headers: { Cookie: f.cookie, Origin: f.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(f.writes.length, 0);
});

test("API writes require same-origin JSON and an explicit confirmation", async (t) => {
  const f = await registered(t);
  const rejected = async (expected, headers, body = JSON.stringify({ confirm: true })) => {
    const response = await f.api("save-credentials", {
      method: "POST", body,
      headers: { Origin: f.origin, "Content-Type": "application/json", ...headers },
    });
    assert.equal(response.status, expected, JSON.stringify(headers));
  };
  for (const origin of [null, "null", "https://evil.example", "http://127.0.0.1:1"]) await rejected(403, { Origin: origin });
  await rejected(415, { "Content-Type": "text/plain" });
  await rejected(415, { "Content-Type": "application/x-www-form-urlencoded" });
  await rejected(415, { "Content-Type": null });
  await rejected(400, {}, "{");
  await rejected(400, {}, "[]");
  await rejected(400, {}, "null");
  await rejected(400, {}, "{}");
  await rejected(400, {}, JSON.stringify({ confirm: "true" }));
  await rejected(400, {}, JSON.stringify({ confirm: false }));
  await rejected(413, {}, JSON.stringify({ confirm: true, padding: "x".repeat(5000) }));
  assert.equal(f.writes.length, 0);
  assert.equal((await f.api("save-credentials", { method: "GET" })).status, 405);
  assert.equal((await f.api("state", { method: "POST", headers: { Origin: f.origin } })).status, 405);
  assert.equal((await f.api("unknown", { method: "POST", headers: { Origin: f.origin } })).status, 404);
  assert.equal((await f.post("save-credentials")).status, 200);
});

test("the API grants no cross-origin access", async (t) => {
  const f = await fixture(t);
  const preflight = await fetch(`${f.origin}/api/verify`, {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-setup-session" },
  });
  assert.equal(preflight.status, 401);
  for (const response of [preflight, await f.api("state"), await f.post("verify")]) {
    assert.equal([...response.headers.keys()].some((name) => name.startsWith("access-control-")), false);
  }
});

test("requests with a foreign Host header are refused to block DNS rebinding", async (t) => {
  const f = await fixture(t);
  const { port } = new URL(f.origin);
  const status = (path, headers) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(await status("/", { Host: `attacker.example:${port}` }), 403);
  assert.equal(await status("/api/state", { Host: `attacker.example:${port}`, "X-Setup-Session": f.session }), 403);
  assert.equal(await status("/api/state", { Host: `localhost:${port}`, "X-Setup-Session": f.session }), 403);
  assert.equal(await status("/api/state", { Host: `127.0.0.1:${port}`, "X-Setup-Session": f.session }), 200);
});

test("the registration bounce page posts a webhook-free manifest to GitHub only", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.origin}/register`)).status, 403);
  assert.equal((await fetch(`${f.origin}/register?session=wrong`)).status, 403);
  const page = await fetch(`${f.origin}/register?session=${f.session}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("set-cookie"), new RegExp(`^${f.cookie.split("=")[0]}=${f.session};`));
  const html = await page.text();
  f.seen.push(html);
  const action = html.match(/<form method="post" action="([^"]+)"/)[1].replaceAll("&amp;", "&");
  assert.equal(action, f.initial.registration.action);
  const encoded = html.match(/name="manifest" value="([^"]+)"/)[1];
  const manifest = JSON.parse(encoded.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
  assert.deepEqual(manifest, registrationManifest("acme/widgets", f.origin));
  for (const [name, level] of Object.entries(APP_PERMISSIONS)) assert.ok(html.includes(`<code>${name}</code>: ${level}`), name);
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.ok(!html.includes("hook_attributes"));
  const afterCookieOnly = await fetch(`${f.origin}/registered?state=${f.registrationState}&code=registration-code`, { headers: { Cookie: page.headers.get("set-cookie").split(";")[0] }, redirect: "manual" });
  assert.equal(afterCookieOnly.status, 303);
  assert.equal((await fetch(`${f.origin}/register?session=${f.session}`)).status, 409);
});

test("the registration callback needs the cookie, the state, a sane code, and works once", async (t) => {
  const f = await fixture(t);
  const url = (state, code = "registration-code") => `${f.origin}/registered?state=${state}&code=${code}`;
  const headers = { Cookie: f.cookie };
  assert.equal((await fetch(url(f.registrationState))).status, 403);
  assert.equal((await fetch(url(f.registrationState), { headers: { Cookie: "optimizer_setup_1=wrong" } })).status, 403);
  assert.equal((await fetch(url("wrong"), { headers })).status, 403);
  assert.equal((await fetch(url(f.registrationState, ""), { headers })).status, 400);
  assert.equal((await fetch(`${f.origin}/registered?state=${f.registrationState}`, { headers })).status, 400);
  for (const code of ["bad%20code", "a%2Fb", "x".repeat(201)]) assert.equal((await fetch(url(f.registrationState, code), { headers })).status, 400, code);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.post("save-credentials")).status, 409);
  assert.equal((await f.callback()).status, 303);
  assert.equal((await f.callback()).status, 403);
  assert.equal(f.calls.filter((call) => call.path.startsWith("/app-manifests/")).length, 1);
  assert.equal(f.calls[0].path, "/app-manifests/registration-code/conversions");
  assert.equal(f.calls[0].method, "POST");
});

test("registration failures are visible, keep no App, and never leak GitHub response data", async (t) => {
  const failed = await fixture(t, { conversionFailure: true });
  const response = await failed.callback();
  assert.equal(response.status, 502);
  assert.match(await response.text(), /GitHub declined the registration/);
  const state = await failed.state();
  assert.equal(state.app, null);
  assert.equal(state.error.step, "register");
  assert.equal(state.current, "register");
  for (const conversion of [
    { id: 123, slug: "ci-cd-optimizer-acme", pem: "not a key", client_secret: "NEVER-EXPOSE" },
    { id: 123, slug: "../escape", pem, client_secret: "NEVER-EXPOSE" },
    { id: -1, slug: "ci-cd-optimizer-acme", pem, client_secret: "NEVER-EXPOSE" },
    { id: 123, slug: "ci-cd-optimizer-acme", client_secret: "NEVER-EXPOSE" },
    {},
  ]) {
    const f = await fixture(t, { conversion });
    const rejected = await f.callback();
    assert.equal(rejected.status, 502);
    const body = await rejected.text();
    assert.match(body, /Invalid App credentials returned by GitHub/);
    assert.ok(!body.includes("NEVER-EXPOSE"));
    assert.equal((await f.state()).app, null);
  }
});

test("the installation callback is a static public page and cannot bypass verification", async (t) => {
  const f = await saveKey(t);
  const page = await fetch(`${f.origin}/installed?installation_id=5&setup_action=install`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Nothing has been verified yet/);
  assert.ok(!html.includes(f.session));
  assert.equal(page.headers.get("set-cookie"), null);
  assert.equal((await f.post("authorize-copilot", { token: "test-user-token" })).status, 409);
  assert.equal((await f.state()).installation.status, "unverified");
  assert.equal(f.calls.length, 1);
});

test("all-repository installation is rejected before minting credentials", async (t) => {
  const f = await saveKey(t, { selection: "all" });
  const result = await f.post("verify");
  assert.equal(result.status, 502);
  const { error, state } = await result.json();
  assert.match(error, /grants access to all repositories/);
  assert.match(error, /Only select repositories/);
  assert.equal(state.error.step, "install");
  assert.equal(state.installation.status, "unverified");
  assert.ok(!f.calls.some((call) => call.path.endsWith("/access_tokens")));
});

test("unknown installation scope does not incorrectly claim all-repository access", async (t) => {
  for (const repository_selection of [undefined, null, "", "unexpected"]) {
    const f = await saveKey(t, { installation: { repository_selection } });
    const result = await f.post("verify");
    assert.equal(result.status, 502);
    const { error } = await result.json();
    assert.match(error, /did not report a recognized repository selection/);
    assert.doesNotMatch(error, /grants access to all repositories|must choose Only select repositories/);
    assert.ok(!f.calls.some((call) => call.path.endsWith("/access_tokens")));
  }
});

test("verification revokes its temporary token even when repository access fails", async (t) => {
  const f = await saveKey(t, { repositoryFailure: true });
  assert.equal((await f.post("verify")).status, 502);
  assert.equal(f.calls.at(-1).path, "/installation/token");
  assert.equal((await f.post("authorize-copilot", { token: "test-user-token" })).status, 409);
});

test("wrong App, account, permissions, suspension, or failed revocation cannot advance setup", async (t) => {
  for (const [options, expected] of [
    [{ installation: { app_id: 456 } }, /App ID does not match CICD_OPTIMIZER_APP_ID/],
    [{ installation: { account: { login: "other" } } }, /does not belong to the target repository/],
    [{ installation: { suspended_at: "2026-01-01T00:00:00Z", repository_selection: "all" } }, /installation is suspended/],
    [{ installation: { permissions: { contents: "read" } } }, /Installation is missing/],
    [{ revokeFailure: true }, /Token revocation failed/],
  ]) {
    const f = await saveKey(t, options);
    const result = await f.post("verify");
    assert.equal(result.status, 502);
    const { error, state } = await result.json();
    assert.match(error, expected);
    assert.doesNotMatch(error, /must choose Only select repositories/);
    assert.equal(state.installation.status, "unverified");
    assert.equal((await f.post("authorize-copilot", { token: "test-user-token" })).status, 409);
    if (!options.revokeFailure) assert.ok(!f.calls.some((call) => call.path.endsWith("/access_tokens")));
  }
});

test("secret-save failure is visible and does not advance installation", async (t) => {
  const f = await registered(t, { writeFailure: true });
  const failed = await f.post("save-credentials");
  assert.equal(failed.status, 502);
  const { error, state } = await failed.json();
  assert.match(error, /GitHub CLI failed/);
  assert.equal(state.credentials.saved, false);
  assert.equal(state.error.step, "credentials");
  assert.equal((await f.post("verify")).status, 409);
  assert.ok(!JSON.stringify(await f.state()).includes(KEY_LINE));
});

test("authorization validates a user token and stores it only through stdin", async (t) => {
  const f = await saveKey(t);
  await f.post("verify");
  const writesBefore = f.writes.length;
  const callsBefore = f.calls.length;
  for (const token of [undefined, null, "", "   ", "has space", "with\nnewline", "nul\0byte", "x".repeat(1025), 123, ["a"]]) {
    assert.equal((await f.post("authorize-copilot", { token })).status, 400, String(token).slice(0, 12));
  }
  assert.equal(f.calls.length, callsBefore);
  assert.equal(f.writes.length, writesBefore);
  const accepted = await f.post("authorize-copilot", { token: "  github_pat_example  " });
  assert.equal(accepted.status, 200);
  assert.deepEqual(f.calls.slice(callsBefore).map(({ path, token }) => [path, token]), [
    ["/user", "github_pat_example"], ["/repos/acme/widgets/issues?state=open&per_page=1", "github_pat_example"],
  ]);
  assert.equal(f.writes.at(-1).input, "github_pat_example");
});

test("a rejected assignment token is redacted from the error and not saved", async (t) => {
  const f = await saveKey(t, { tokenFailure: true });
  await f.post("verify");
  const rejected = await f.post("authorize-copilot", { token: "github_pat_secret_value" });
  assert.equal(rejected.status, 502);
  const body = await rejected.text();
  assert.match(body, /GitHub rejected the token \[redacted\]/);
  assert.ok(!body.includes("github_pat_secret_value"));
  assert.ok(!f.writes.some(({ args }) => args.includes("COPILOT_ASSIGN_TOKEN")));
  assert.equal((await f.state()).copilot.saved, false);
  assert.ok(!f.seen.join("\n").includes("github_pat_secret_value"));
});

test("no response ever contains the private key, client secret, or tokens", async (t) => {
  const f = await fixture(t);
  await f.callback();
  await f.post("save-credentials");
  await f.post("verify");
  await f.post("authorize-copilot", { token: "test-user-token" });
  await f.post("run-scan");
  const registrationPage = await (await fetch(`${f.origin}/register`)).text();
  const installedPage = await (await fetch(`${f.origin}/installed`)).text();
  const everything = [...f.seen, registrationPage, installedPage].join("\n");
  for (const secret of [KEY_LINE, "NEVER-EXPOSE", "installation-test-token", "test-user-token", "BEGIN RSA PRIVATE KEY"]) {
    assert.ok(!everything.includes(secret), `leaked ${secret.slice(0, 16)}`);
  }
});

test("overlapping streamed requests cannot perform concurrent credential writes", async (t) => {
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
  const { port } = new URL(f.origin);
  const streamed = () => {
    let req;
    const result = new Promise((resolve, reject) => {
      req = httpRequest({
        host: "127.0.0.1", port, path: "/api/save-credentials", method: "POST",
        headers: { "X-Setup-Session": f.session, Origin: f.origin, "Content-Type": "application/json", Expect: "100-continue" },
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
    first.req.end(JSON.stringify({ confirm: true }));
    await writing;
    second.req.end(JSON.stringify({ confirm: true }));
    assert.equal(await second.result, 409);
    assert.equal(secrets, 1);
  } finally { release(); }
  assert.equal(await first.result, 200);
});

test("parallel setup tabs on different ports cannot overwrite each other's session cookies", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  assert.notEqual(first.cookie.split("=")[0], second.cookie.split("=")[0]);
  assert.notEqual(first.session, second.session);
  const cookie = `${first.cookie}; ${second.cookie}`;
  for (const f of [first, second]) {
    assert.equal((await f.callback({ Cookie: cookie })).status, 303);
    assert.equal((await f.post("save-credentials")).status, 200);
  }
  assert.equal((await fetch(`${first.origin}/api/state`, { headers: { "X-Setup-Session": second.session } })).status, 401);
});

test("resumed setup shows no registration, never writes credentials, and requires an explicit dispatch", async (t) => {
  const options = { run: { status: "in_progress", conclusion: null } };
  const f = await fixture(t, { saved, command: verificationCommand(options) });
  assert.equal(f.initial.resumed, true);
  assert.equal(f.initial.registration, null);
  assert.equal(f.initial.urls.register, null);
  assert.deepEqual(f.initial.app, saved.app);
  assert.equal(f.initial.credentials.saved, true);
  assert.equal(f.initial.current, "install");
  assert.equal(f.writes.length, 0);
  assert.equal(f.calls.length, 0);
  for (const action of ["save-credentials", "authorize-copilot", "run-scan", "check-verification"]) assert.equal((await f.post(action)).status, 409, action);
  assert.equal((await fetch(`${f.origin}/register?session=${f.session}`)).status, 409);
  assert.equal((await f.callback()).status, 403);
  assert.equal((await f.post("verify", {}, { Origin: "null" })).status, 403);
  assert.equal(f.writes.length, 0);

  const requested = await f.post("verify");
  assert.equal(requested.status, 200);
  const running = await requested.json();
  assert.equal(running.installation.status, "running");
  assert.equal(running.installation.run.id, 76);
  assert.match(running.message, /This page checks automatically/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.post("verify")).status, 409);
  assert.equal(f.writes.filter(({ args }) => args.includes("POST")).length, 1);

  const checked = await (await f.post("check-verification")).json();
  assert.match(checked.message, /still queued or running/);
  assert.equal(checked.installation.status, "running");
  assert.equal((await f.post("run-scan")).status, 409);

  options.run = {};
  const verified = await (await f.post("check-verification")).json();
  assert.equal(verified.installation.status, "verified");
  assert.match(verified.message, /Installation verified in GitHub Actions/);
  assert.equal(verified.copilot.saved, true);
  assert.equal(verified.current, "scan");
  assert.equal((await f.post("run-scan")).status, 200);
  assert.deepEqual(f.writes.at(-1).args, ["workflow", "run", "cicd-optimizer-scan.yml", "--repo", "acme/widgets"]);
  assert.ok(!f.writes.some(({ args }) => args[0] === "secret" || args[0] === "variable"));
});

test("failed rechecks and redispatches invalidate previous verification", async (t) => {
  const options = {};
  const f = await fixture(t, { saved, command: verificationCommand(options) });
  await f.post("verify");
  await f.post("check-verification");
  options.stepConclusion = "skipped";
  assert.equal((await f.post("check-verification")).status, 502);
  assert.equal((await f.post("run-scan")).status, 409);
  options.stepConclusion = "success";
  assert.equal((await f.post("check-verification")).status, 200);
  options.dispatchFailure = true;
  assert.equal((await f.post("verify")).status, 502);
  assert.equal((await f.post("check-verification")).status, 409);
  assert.equal((await f.post("run-scan")).status, 409);
});

test("one verification click advances automatically after completion and stops polling on failure", async (t) => {
  let reads = 0;
  const options = { run: { status: "queued", conclusion: null }, onRunRead: () => { reads += 1; } };
  const f = await fixture(t, { saved, command: verificationCommand(options) });
  assert.equal((await f.post("verify")).status, 200);
  let state = await f.state();
  assert.equal(state.installation.status, "running");
  assert.match(state.message, /still queued or running/);
  options.run = {};
  state = await f.state();
  assert.equal(state.installation.status, "verified");
  assert.match(state.message, /Installation verified in GitHub Actions/);
  assert.equal(state.current, "scan");
  assert.equal(f.writes.filter(({ args }) => args.includes("POST")).length, 1);

  assert.equal((await f.post("verify")).status, 200);
  options.run = { conclusion: "failure" };
  state = await f.state();
  assert.equal(state.installation.status, "failed");
  assert.equal(state.error.step, "install");
  assert.match(state.error.message, /App verification did not succeed/);
  assert.match(state.installation.run.url, /actions\/runs\/76$/);
  const settled = reads;
  await f.state();
  await f.state();
  assert.equal(reads, settled);
  assert.equal((await f.post("run-scan")).status, 409);
  assert.equal((await f.post("verify")).status, 200);
});

test("upstream verification checks are throttled across concurrent pollers", async (t) => {
  let reads = 0;
  const options = { run: { status: "queued", conclusion: null }, onRunRead: () => { reads += 1; } };
  const f = await fixture(t, { saved, command: verificationCommand(options), refreshInterval: 60_000 });
  await f.post("verify");
  await Promise.all([f.state(), f.state(), f.state()]);
  await f.state();
  assert.equal(reads, 1);
});

test("invalid saved identities, repositories, and a missing UI build are refused before listening", async (t) => {
  const assets = await makeAssets(t);
  for (const identity of [{ id: 123 }, { id: 0, slug: "app" }, { id: 1.5, slug: "app" }, { id: "123", slug: "app" }, { id: 1, slug: "../app" }, { id: 1, slug: "UPPER" }]) {
    await assert.rejects(startSetup({ repo: "acme/widgets", saved: { app: identity } }, { assets }), /Invalid saved App identity/);
  }
  await assert.rejects(startSetup({ repo: "acme/widgets", saved: {} }, { assets }), /Invalid saved App identity/);
  for (const repo of [undefined, "", "acme", "acme/widgets/extra", "../widgets", "acme/..", "./widgets", "a b/c"]) {
    await assert.rejects(startSetup({ repo }, { assets }), /Use --repo OWNER\/REPOSITORY/, String(repo));
  }
  await assert.rejects(startSetup({ repo: "acme/widgets" }, { assets: `${assets}/missing` }), /Setup UI is not built\. Run npm run build:ui\./);
});

test("expiry closes the listener, discards the unsaved key, and warns", async (t) => {
  const log = [];
  const f = await registered(t, { lifetime: 700, log });
  await wait(1100);
  assert.match(log.join("\n"), /App key was not saved/);
  const state = await f.getState();
  assert.equal(state.expired, true);
  assert.equal(state.app, null);
  await assert.rejects(f.act("save-credentials", { confirm: true }), (error) => error.status === 410);
  await assert.rejects(fetch(f.url));
});

test("closing after the key is saved does not warn about a lost key", async (t) => {
  const log = [];
  const f = await saveKey(t, { log });
  await f.close();
  assert.deepEqual(log, []);
  assert.equal((await f.getState()).expired, true);
});

test("prepareSetup requires repository admin access and the owner for personal Apps", async () => {
  const gh = ({ admin = true, type = "User", owner = "Acme", actor = "acme", resume = saved } = {}) => async (args) => {
    const path = args.at(-1);
    if (path === "repos/acme/widgets") return JSON.stringify({ permissions: { admin }, owner: { type, login: owner } });
    if (path === "user") return JSON.stringify({ login: actor });
    if (args[0] === "api") return JSON.stringify(resume.app);
    if (args[0] === "variable") return String(resume.app.id);
    if (args[0] === "secret") return JSON.stringify([{ name: "CICD_OPTIMIZER_APP_PRIVATE_KEY" }]);
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
  assert.deepEqual(await prepareSetup({ repo: "acme/widgets" }, gh()), { repo: "acme/widgets", organization: false, saved: undefined });
  assert.deepEqual(await prepareSetup({ repo: "acme/widgets" }, gh({ type: "Organization", actor: "someone-else" })), { repo: "acme/widgets", organization: true, saved: undefined });
  assert.deepEqual((await prepareSetup({ repo: "acme/widgets", resumeApp: saved.app.slug }, gh())).saved, { app: saved.app, copilot: false });
  await assert.rejects(prepareSetup({ repo: "acme/widgets" }, gh({ admin: false })), /Repository admin access is required/);
  await assert.rejects(prepareSetup({ repo: "acme/widgets" }, gh({ actor: "someone-else" })), /as the repository owner/);
  for (const repo of [undefined, "acme", "../widgets", "acme/.."]) {
    await assert.rejects(prepareSetup({ repo }, () => assert.fail("Invalid repository reached gh")), /Use --repo OWNER\/REPOSITORY/);
  }
});

test("the setup command documents its flags and rejects a missing repository", async () => {
  const cli = new URL("../../scripts/setup.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const help = await run(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /--repo/);
  assert.match(help.stdout, /--resume-app/);
  await assert.rejects(
    run(process.execPath, [cli], { env: { ...process.env, GITHUB_REPOSITORY: "" } }),
    (error) => error.code === 1 && /Use --repo OWNER\/REPOSITORY/.test(error.stderr),
  );
});
