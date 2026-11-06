// Smoke tests for the preview host's server half: routes, the default-deny read-only policy and the request guards.
// The browser half (AppBridge, iframe, handlers) is exercised in a real browser; see docs/setup.md.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SETUP_RESOURCE_URI, SETUP_TOOLS } from "../../mcp/setup-server.mjs";
import { fakeRequest, githubCommand } from "./helpers.mjs";
import { startPreviewHost } from "./preview-host.mjs";

const path = (relative) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const lf = (text) => text.replace(/\r\n/g, "\n");
const { open: OPEN, status: STATUS, state: STATE, verify: VERIFY } = SETUP_TOOLS;
const SAVE = SETUP_TOOLS["save-credentials"];
const CHECK = SETUP_TOOLS["check-verification"];
const SCAN = SETUP_TOOLS["run-scan"];
const SLUG = "ci-cd-optimizer-acme";
const textOf = (result) => result.content.map((block) => block.text).join("\n");

// node:http rather than fetch: the tests need to control the Host and Origin headers.
function raw(url, { method = "GET", headers = {}, body } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function preview(t, options) {
  // Dropping an unsaved key on close warns on stderr; keep test output clean.
  if (!console.error.mock) t.mock.method(console, "error", () => {});
  const host = await startPreviewHost(options);
  t.after(() => host.close());
  const origin = new URL(host.hostUrl).origin;
  const post = (route, body, headers = {}) => raw(`${origin}${route}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const rpc = async (method, params) => JSON.parse((await post("/rpc", { method, params })).text);
  return {
    host, origin, post, rpc,
    get: (route) => raw(`${origin}${route}`),
    call: async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result,
  };
}

// A real-mode host whose gh and GitHub are fakes, so the policy can be tested without touching anything real.
const realWithFakes = (calls = []) => ({ real: true, command: githubCommand({ calls }), request: fakeRequest({}, []) });

test("serves the host page, the bundled host script and the built view under a locked-down CSP", async (t) => {
  const { get, origin, host } = await preview(t);
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /^text\/html/);
  assert.match(page.text, /src="\/host\.js"/);

  const script = await get("/host.js");
  assert.equal(script.status, 200);
  assert.match(script.headers["content-type"], /javascript/);
  assert.ok(script.text.length > 10_000);
  assert.ok(script.text.includes("ui/notifications/tool-result"));

  const view = await raw(host.viewUrl);
  assert.equal(view.status, 200);
  assert.equal(view.text, lf(await readFile(path("dist-setup/mcp.html"), "utf8")));
  const csp = view.headers["content-security-policy"];
  for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "report-uri /csp-report"]) {
    assert.ok(csp.includes(directive), `${directive} in ${csp}`);
  }
  assert.notEqual(new URL(host.viewUrl).origin, origin, "the view must be a different origin from the host");
});

test("describes the fake and real configurations", async (t) => {
  const fake = await preview(t);
  assert.deepEqual(JSON.parse((await fake.get("/config")).text), {
    mode: "fake", repo: "acme/widgets", resumeApp: null, readOnly: false, viewUrl: fake.host.viewUrl, prefersBorder: false,
  });
  const real = await preview(t, { ...realWithFakes(), resumeApp: SLUG });
  const config = JSON.parse((await real.get("/config")).text);
  assert.equal(config.mode, "real");
  assert.equal(config.readOnly, true, "real mode must default to read-only");
  assert.equal(config.resumeApp, SLUG);
  const open = await preview(t, { ...realWithFakes(), readOnly: false });
  assert.equal(JSON.parse((await open.get("/config")).text).readOnly, false);
  await assert.rejects(startPreviewHost({ real: true, repo: "" }), /--repo/);
});

test("lists the open tool rendering the ui resource and the panel tools as app-only", async (t) => {
  const { rpc } = await preview(t);
  const { tools } = (await rpc("tools/list")).result;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get(OPEN)._meta.ui.resourceUri, SETUP_RESOURCE_URI);
  assert.equal(byName.get(OPEN)._meta.ui.visibility, undefined);
  assert.equal(byName.get(STATUS)._meta?.ui, undefined);
  for (const name of [STATE, SAVE, VERIFY, CHECK, SCAN]) {
    assert.deepEqual(byName.get(name)._meta.ui.visibility, ["app"], name);
  }
  assert.equal(tools.length, 7);
});

test("the open tool tells the model progress while only the view receives the panel session", async (t) => {
  const { call } = await preview(t);
  const result = await call(OPEN, { repo: "acme/widgets" });
  assert.ok(!result.isError, textOf(result));
  const { session } = result.structuredContent;
  assert.match(session, /^[0-9a-f]{64}$/);
  const text = textOf(result);
  assert.match(text, /0 of 5 steps complete/);
  assert.ok(!text.includes("127.0.0.1"), "the model must not be handed a loopback URL");
  assert.ok(!text.includes(session), "the model must not see the panel session");
});

test("read-only mode refuses every tool except open, status and state, and never reaches gh", async (t) => {
  const gh = [];
  const { call } = await preview(t, realWithFakes(gh));
  const opened = await call(OPEN, { repo: "acme/widgets", resumeApp: SLUG });
  assert.ok(!opened.isError, textOf(opened));
  const { session } = opened.structuredContent;
  assert.equal(opened.structuredContent.state.current, "install");

  assert.equal((await call(STATE, { session })).structuredContent.state.current, "install");
  assert.match(textOf(await call(STATUS)), /CI\/CD Optimizer setup for acme\/widgets/);

  const reads = gh.length;
  const refused = [[VERIFY, { session, confirm: true }], [SAVE, { session, confirm: true }], [CHECK, { session }], [SCAN, { session, confirm: true }], ["not_a_tool", {}]];
  for (const [name, args] of refused) {
    const result = await call(name, args);
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), /read-only/, name);
  }
  assert.deepEqual(gh.slice(reads), [], "a refused tool must not run any gh command");
});

test("an unrestricted host passes state-changing tools through to the server", async (t) => {
  const gh = [];
  const { call } = await preview(t, { ...realWithFakes(gh), readOnly: false });
  const { structuredContent: { session } } = await call(OPEN, { repo: "acme/widgets", resumeApp: SLUG });
  const result = await call(VERIFY, { session, confirm: true });
  assert.ok(!result.isError, textOf(result));
  const dispatched = gh.filter(({ args }) => args.includes("POST") && args.some((arg) => String(arg).endsWith("/actions/workflows/cicd-optimizer-verify-app.yml/dispatches")));
  assert.equal(dispatched.length, 1, "the verification workflow should have been dispatched exactly once");
});

test("refuses a foreign Host, a foreign or missing Origin, a non-JSON body and an oversized body", async (t) => {
  const { host, origin, post, get } = await preview(t);
  const body = JSON.stringify({ method: "tools/list" });
  const cases = [
    ["a foreign Host on the host server", () => raw(host.hostUrl, { headers: { Host: "evil.example" } }), 403],
    ["a foreign Host on the view server", () => raw(host.viewUrl, { headers: { Host: "evil.example" } }), 403],
    ["a foreign Origin", () => post("/rpc", body, { Origin: "http://evil.example" }), 403],
    ["a missing Origin", () => raw(`${origin}/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body }), 403],
    ["a text/plain body", () => post("/rpc", body, { "Content-Type": "text/plain" }), 415],
    ["malformed JSON", () => post("/rpc", "{not json"), 400],
    ["a JSON array", () => post("/rpc", "[]"), 400],
    ["a method the host does not forward", () => post("/rpc", { method: "resources/read", params: {} }), 400],
    ["tools/call without a tool name", () => post("/rpc", { method: "tools/call", params: {} }), 400],
    ["an oversized body", () => post("/rpc", JSON.stringify({ padding: "x".repeat(20_000) })), 413],
    ["GET on a POST-only route", () => get("/rpc"), 405],
    ["an unknown route", () => get("/nope"), 404],
    ["the same request with the right headers", () => post("/rpc", body), 200],
  ];
  const mismatches = [];
  for (const [label, send, status] of cases) {
    const actual = (await send()).status;
    if (actual !== status) mismatches.push(`${label}: expected ${status}, got ${actual}`);
  }
  assert.deepEqual(mismatches, []);
});

test("an unknown tool is a visible error, not a crash", async (t) => {
  const { post } = await preview(t);
  const response = await post("/rpc", { method: "tools/call", params: { name: "not_a_tool", arguments: {} } });
  assert.equal(response.status, 502);
  assert.match(JSON.parse(response.text).error, /not_a_tool/);
});

test("collects CSP violation reports from the view origin and caps how many it keeps", async (t) => {
  const { host, get } = await preview(t);
  const viewOrigin = new URL(host.viewUrl).origin;
  const send = (report) => raw(`${viewOrigin}/csp-report`, { method: "POST", headers: { "Content-Type": "application/csp-report" }, body: JSON.stringify(report) });
  const one = await send({ "csp-report": { "effective-directive": "connect-src", "blocked-uri": "https://evil.example/x", "document-uri": host.viewUrl } });
  assert.equal(one.status, 204);
  assert.deepEqual(JSON.parse((await get("/violations")).text), [
    { directive: "connect-src", blocked: "https://evil.example/x", document: host.viewUrl, source: "" },
  ]);
  for (let index = 0; index < 60; index += 1) await send({ "csp-report": { "blocked-uri": "x".repeat(1000) } });
  const kept = JSON.parse((await get("/violations")).text);
  assert.equal(kept.length, 50);
  assert.ok(kept.every((item) => item.blocked.length <= 300));
  assert.equal((await raw(`${viewOrigin}/csp-report`, { method: "POST", headers: { Host: "evil.example" }, body: "{}" })).status, 403);
});

test("simulates the GitHub registration round trip for the panel's own session on the fake GitHub", async (t) => {
  const { call, post } = await preview(t);
  const stepStatus = (state, id) => state.steps.find((step) => step.id === id)?.status;
  const { structuredContent: { session, state } } = await call(OPEN, { repo: "acme/widgets" });
  assert.equal(stepStatus(state, "register"), "current");
  assert.equal((await post("/simulate-register", { session: "0".repeat(64) })).status, 403, "a session the panel was never given must not register");
  assert.equal((await post("/simulate-register", {})).status, 400);

  const response = await post("/simulate-register", { session });
  assert.equal(response.status, 200, response.text);
  const after = (await call(STATE, { session })).structuredContent.state;
  assert.equal(stepStatus(after, "register"), "complete");
  assert.equal(after.current, "credentials");
});

test("never simulates registration against a real GitHub", async (t) => {
  const { post, call } = await preview(t, realWithFakes());
  const { structuredContent: { session } } = await call(OPEN, { repo: "acme/widgets" });
  assert.equal((await post("/simulate-register", { session })).status, 409);
});

test("--same-origin serves the view from the host origin", async (t) => {
  const { host } = await preview(t, { sameOrigin: true });
  assert.equal(new URL(host.viewUrl).origin, new URL(host.hostUrl).origin);
  assert.equal((await raw(host.viewUrl)).status, 200);
});

function launch(t, args) {
  const child = spawn(process.execPath, [path("test/setup/preview-host.mjs"), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output.stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output.stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return { child, output, exited };
}

test("the command line explains itself and rejects unsafe or inconsistent options", async (t) => {
  const help = launch(t, ["--help"]);
  assert.equal(await help.exited, 0);
  assert.match(help.output.stdout, /Usage: node test\/setup\/preview-host\.mjs/);
  for (const [args, message] of [
    [["--real"], /--real needs --repo/],
    [["--real", "--repo", "acme/widgets", "--resume"], /--resume is for the fake GitHub/],
    [["--allow-actions"], /need --real/],
    [["--repo", "acme/widgets"], /need --real/],
    [["--host-port", "70000"], /--host-port must be a port/],
  ]) {
    const run = launch(t, args);
    assert.equal(await run.exited, 1, args.join(" "));
    assert.match(run.output.stderr, message, args.join(" "));
  }
});

// The banner is printed line by line, so wait for its last line before reading the rest.
function started(t, args) {
  const run = launch(t, args);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No host URL printed: ${run.output.stderr}`)), 15_000);
    run.child.stdout.on("data", () => {
      const match = /Preview host: (\S+)[\s\S]*View origin: \S+/.exec(run.output.stdout);
      if (match) {
        clearTimeout(timer);
        resolve({ ...run, url: match[1] });
      }
    });
    run.child.once("exit", () => reject(new Error(`Exited early: ${run.output.stderr}`)));
  });
}

async function eventually(check, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("the command line starts the fake host and serves its configuration", async (t) => {
  const run = await started(t, ["--resume"]);
  assert.match(run.output.stdout, /Mode: fake GitHub/);
  const config = JSON.parse((await raw(`${run.url}config`)).text);
  assert.equal(config.mode, "fake");
  assert.equal(config.resumeApp, SLUG);
});

test("the command line keeps real mode read-only until --allow-actions says otherwise", async (t) => {
  // /config runs no tool, so neither launch reaches gh or GitHub.
  const guarded = await started(t, ["--real", "--repo", "acme/widgets"]);
  assert.match(guarded.output.stdout, /Mode: real GitHub \(read-only\)/);
  const readOnly = JSON.parse((await raw(`${guarded.url}config`)).text);
  assert.deepEqual([readOnly.mode, readOnly.readOnly, readOnly.repo], ["real", true, "acme/widgets"]);

  const unlocked = await started(t, ["--real", "--repo", "acme/widgets", "--allow-actions"]);
  assert.match(unlocked.output.stdout, /Mode: real GitHub \(ACTIONS ENABLED\)/);
  assert.equal(JSON.parse((await raw(`${unlocked.url}config`)).text).readOnly, false);
  await eventually(() => /can now save credentials and dispatch workflows/.test(unlocked.output.stderr), "the unlocked host should warn on stderr");
});
