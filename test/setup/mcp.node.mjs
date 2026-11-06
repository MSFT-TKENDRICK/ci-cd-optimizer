// Protocol tests for the stdio MCP App server: in-memory for behavior, a real child process for launch, stdout purity and exit.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { SETUP_RESOURCE_URI, SETUP_TOOLS, createSetupServer } from "../../mcp/setup-server.mjs";
import { fakeRequest, githubCommand, loopback, makeAssets, pem, registerInBrowser } from "./helpers.mjs";

const path = (relative) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const lf = (text) => text.replace(/\r\n/g, "\n");
const SERVER = path("mcp/setup-server.mjs");
const PANEL_CONTRACT = lf(await readFile(path("ui/setup/src/lib/types.ts"), "utf8"));
const BUILT_VIEW = lf(await readFile(path("dist-setup/mcp.html"), "utf8"));

const MIME = "text/html;profile=mcp-app";
const UI_CAPABILITIES = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MIME] } } };
const REPO = "acme/widgets";
const SLUG = "ci-cd-optimizer-acme";
const RESUME = { repo: REPO, resumeApp: SLUG };
const USER_TOKEN = "test-user-token";
const { open: OPEN, status: STATUS, state: STATE, verify: VERIFY } = SETUP_TOOLS;
const SAVE = SETUP_TOOLS["save-credentials"];
const CHECK = SETUP_TOOLS["check-verification"];
const SCAN = SETUP_TOOLS["run-scan"];
const PANEL_TOOLS = [STATE, SAVE, VERIFY, CHECK, SCAN];
// Strings that must never reach the model: the private key and the OAuth client secret the fake GitHub returns.
const KEY_LINE = pem.split("\n")[1];

const textOf = (result) => result.content.map((block) => block.text).join("\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeout = 5000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await sleep(interval);
  }
}

// A host: the real server over an in-memory transport, a fake GitHub, and the panel's real built assets unless overridden.
async function connect(t, { ui = true, env = {}, assets, lifetime, command, ...fakes } = {}) {
  // Dropping an unsaved key on close warns on stderr; keep test output clean.
  if (!console.error.mock) t.mock.method(console, "error", () => {});
  const gh = [];
  const requests = [];
  const { server, closeSessions } = createSetupServer({
    command: command ?? githubCommand({ ...fakes, calls: gh }),
    request: fakeRequest(fakes, requests),
    assets, lifetime, refreshInterval: 0, env,
  });
  const client = new Client({ name: "test-host", version: "1.0.0" }, { capabilities: ui ? UI_CAPABILITIES : {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  t.after(async () => {
    await client.close();
    await closeSessions();
  });
  return { client, gh, requests, closeSessions, call: (name, args = {}) => client.callTool({ name, arguments: args }) };
}

async function openPanel(h, args = RESUME) {
  const result = await h.call(OPEN, args);
  assert.ok(!result.isError, textOf(result));
  return { result, ...result.structuredContent };
}

function assertFailure(result, status, message) {
  assert.equal(result.isError, true, textOf(result));
  assert.equal(result.structuredContent.status, status, textOf(result));
  if (message instanceof RegExp) assert.match(textOf(result), message);
  else assert.equal(textOf(result), message);
}

// Everything the model can read: text only, never a link, a session or a credential.
function assertModelSafe(result, ...secrets) {
  const text = textOf(result);
  assert.doesNotMatch(text, /127\.0\.0\.1|localhost|session=/i, text);
  for (const secret of secrets) assert.ok(!text.includes(secret), `model-visible text leaked a secret: ${text}`);
}

function assertNoCredentials(result) {
  const everything = JSON.stringify(result);
  for (const secret of [KEY_LINE, "PRIVATE KEY", "NEVER-EXPOSE", USER_TOKEN]) assert.ok(!everything.includes(secret), `result leaked ${secret}`);
}

test("lists an open tool, a status tool and app-only panel tools, none of which can take a secret", async (t) => {
  const h = await connect(t);
  const { tools } = await h.client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), Object.values(SETUP_TOOLS).sort());
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const properties = (name) => Object.keys(byName[name].inputSchema.properties ?? {}).sort();

  assert.equal(byName[OPEN]._meta.ui.resourceUri, SETUP_RESOURCE_URI);
  assert.equal(byName[OPEN]._meta["ui/resourceUri"], SETUP_RESOURCE_URI);
  assert.equal(byName[OPEN]._meta.ui.visibility, undefined, "the model must be able to call the open tool");
  assert.deepEqual(properties(OPEN), ["repo", "resumeApp"]);
  assert.equal(byName[STATUS]._meta?.ui, undefined);
  assert.equal(byName[STATUS].annotations.readOnlyHint, true);
  assert.deepEqual(properties(STATUS), []);

  for (const name of PANEL_TOOLS) {
    assert.deepEqual(byName[name]._meta.ui, { resourceUri: SETUP_RESOURCE_URI, visibility: ["app"] }, `${name} must be hidden from the model`);
    assert.deepEqual(byName[name].inputSchema.required, ["session"], name);
    assert.deepEqual(properties(name), name === STATE ? ["session"] : ["confirm", "session"], name);
  }
  assert.equal(byName[STATE].annotations.readOnlyHint, true);
  for (const name of [SAVE, VERIFY, CHECK, SCAN]) {
    assert.deepEqual(byName[name].annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, name);
  }
  for (const tool of tools) {
    for (const property of Object.keys(tool.inputSchema.properties ?? {})) {
      assert.doesNotMatch(property, /token|secret|key|pem|password|credential/i, `${tool.name}.${property}`);
    }
  }
  assert.match(h.client.getInstructions(), /Never ask for or accept a token, private key or secret in chat/);
});

test("tool names, resource URI, step ids and state keys match the panel's contract", async (t) => {
  const h = await connect(t);
  const body = (pattern) => PANEL_CONTRACT.match(pattern)?.[1] ?? assert.fail(`The panel contract no longer matches ${pattern}`);
  const tools = Object.fromEntries([...body(/export const MCP_TOOLS = \{([\s\S]*?)\}/).matchAll(/(?:"([\w-]+)"|(\w+)):\s*"([^"]+)"/g)]
    .map((match) => [match[1] ?? match[2], match[3]]));
  assert.deepEqual(tools, {
    open: OPEN, state: STATE, "save-credentials": SAVE, verify: VERIFY, "check-verification": CHECK, "run-scan": SCAN,
  });
  assert.equal(body(/export const MCP_RESOURCE_URI = "([^"]+)"/), SETUP_RESOURCE_URI);

  const stepIds = [...body(/SETUP_STEP_IDS = \[([^\]]*)\]/).matchAll(/"(\w+)"/g)].map((match) => match[1]);
  const stateKeys = [...body(/const STATE_KEY_RECORD[^=]*= \{([\s\S]*?)\n\};/).matchAll(/^\s*(\w+): true,$/gm)].map((match) => match[1]).sort();
  assert.equal(stateKeys.length, 18);
  for (const args of [{ repo: REPO }, RESUME]) {
    const { state } = await openPanel(h, args);
    assert.deepEqual(Object.keys(state).sort(), stateKeys);
    assert.deepEqual(state.steps.map(({ id }) => id), stepIds);
  }
});

test("the panel resource is the built single-file view and references nothing external", async (t) => {
  const h = await connect(t);
  const { resources } = await h.client.listResources();
  assert.deepEqual(resources.map(({ uri, mimeType }) => ({ uri, mimeType })), [{ uri: SETUP_RESOURCE_URI, mimeType: MIME }]);
  const { contents } = await h.client.readResource({ uri: SETUP_RESOURCE_URI });
  assert.equal(contents.length, 1);
  assert.equal(contents[0].uri, SETUP_RESOURCE_URI);
  assert.equal(contents[0].mimeType, MIME);
  assert.equal(contents[0].text, BUILT_VIEW);
  assert.deepEqual(contents[0]._meta.ui, { prefersBorder: false });
  // The host sandbox allows no network, so the document must be self-contained.
  assert.doesNotMatch(contents[0].text, /<script[^>]+\ssrc=/);
  assert.doesNotMatch(contents[0].text, /<link[^>]+href="(?!data:)/);
});

test("reading the panel fails clearly when the UI is not built, and unknown resources are not found", async (t) => {
  const unbuilt = await connect(t, { assets: await makeAssets(t) });
  await assert.rejects(unbuilt.client.readResource({ uri: SETUP_RESOURCE_URI }), /Setup UI is not built\. Run npm run build:ui\./);
  const h = await connect(t);
  await assert.rejects(h.client.readResource({ uri: "ui://nope" }), /not found/i);
});

test("a fresh open boots the panel and keeps links, sessions and tokens out of the model's text", async (t) => {
  const h = await connect(t);
  const { result, session, state } = await openPanel(h, { repo: REPO });
  assert.deepEqual(Object.keys(result.structuredContent).sort(), ["session", "state"]);
  assert.match(session, /^[a-f0-9]{64}$/);
  assert.equal(state.repo, REPO);
  assert.equal(state.organization, true);
  assert.equal(state.resumed, false);
  assert.equal(state.expired, false);
  assert.equal(state.app, null);
  assert.equal(state.current, "register");
  assert.match(state.registration.action, /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=[a-f0-9]{64}$/);
  assert.equal(textOf(result), [
    "Started CI/CD Optimizer setup for acme/widgets. 0 of 5 steps complete; next: Register the App.",
    "The interactive setup panel is showing in chat. The user completes each step there.",
    "Do not ask for tokens or keys in chat. Call cicd_optimizer_setup_status to check progress.",
  ].join("\n"));
  const { session: loopbackSession } = loopback(state);
  assert.notEqual(session, loopbackSession, "the panel token must not be the loopback session");
  assertModelSafe(result, session, loopbackSession, state.registration.action);
  assert.deepEqual(h.gh.map(({ args }) => args.join(" ")), ["api --hostname github.com repos/acme/widgets", "api --hostname github.com user"]);
});

test("a resumed open reads the saved App without writing anything", async (t) => {
  const h = await connect(t);
  const { result, session, state } = await openPanel(h);
  assert.deepEqual(Object.keys(result.structuredContent).sort(), ["session", "state"]);
  assert.equal(session.length, 64);
  assert.match(textOf(result), /^Resumed CI\/CD Optimizer setup for acme\/widgets\. 3 of 5 steps complete; next: Install and verify\./);
  assert.equal(state.resumed, true);
  assert.deepEqual(state.app, { id: 123, slug: SLUG });
  assert.equal(state.registration, null);
  assert.equal(state.current, "install");
  assert.deepEqual(state.credentials, { saved: true });
  assert.deepEqual(state.copilot, { saved: true });
  assert.deepEqual(state.installation, { status: "unverified", run: null });
  assertModelSafe(result, session);
  assert.deepEqual(h.gh.map(({ args }) => args.join(" ")), [
    "api --hostname github.com repos/acme/widgets",
    "api --hostname github.com user",
    `api --hostname github.com -H X-GitHub-Api-Version: 2026-03-10 apps/${SLUG}`,
    "variable get CICD_OPTIMIZER_APP_ID --repo acme/widgets",
    "secret list --repo acme/widgets --json name",
  ]);
});

test("the open tool rejects malformed repositories before any GitHub call", async (t) => {
  const h = await connect(t);
  for (const repo of ["not-a-repo", "acme/widgets/extra", "acme/wid gets", " acme/widgets"]) {
    const result = await h.call(OPEN, { repo });
    assert.equal(result.isError, true, repo);
    assert.match(textOf(result), /Use OWNER\/REPOSITORY/, repo);
    assert.equal(result.structuredContent, undefined, repo);
  }
  for (const repo of ["../escape", "acme/..", "./widgets"]) assertFailure(await h.call(OPEN, { repo }), 400, "Pass repo as OWNER/REPOSITORY.");
  const slug = await h.call(OPEN, { repo: REPO, resumeApp: "Not A Slug!" });
  assert.equal(slug.isError, true);
  assert.match(textOf(slug), /App slug/);
  assert.equal(h.gh.length, 0);
});

test("unknown arguments are dropped, so a token passed to the open tool is never stored or echoed", async (t) => {
  const h = await connect(t);
  const result = await h.call(OPEN, { repo: REPO, token: "canary-token-value" });
  assert.ok(!result.isError, textOf(result));
  assert.ok(!JSON.stringify(result).includes("canary-token-value"));
  assert.ok(!JSON.stringify(h.gh).includes("canary-token-value"));
  assert.ok(!JSON.stringify(h.requests).includes("canary-token-value"));
});

test("an unknown tool is a protocol error, and no authorize-copilot tool exists", async (t) => {
  const h = await connect(t);
  await assert.rejects(h.call("nope"), (error) => error.code === -32602 && /Tool nope not found/.test(error.message));
  for (const name of ["setup_authorize_copilot", "authorize-copilot", "setup_save_token"]) {
    await assert.rejects(h.call(name, { session: "x", token: USER_TOKEN }), /not found/i, name);
  }
});

test("panel tools reject any session the open tool did not issue", async (t) => {
  const none = await connect(t);
  for (const name of PANEL_TOOLS) assertFailure(await none.call(name, { session: "anything", confirm: true }), 401, /not authorized/);
  assert.equal(none.gh.length, 0);

  const h = await connect(t);
  const { session, state } = await openPanel(h);
  const before = h.gh.length;
  // The loopback session opens the browser page; it must not also drive the panel's tools.
  for (const given of ["wrong", "x".repeat(64), loopback(state).session, session.toUpperCase(), `${session} `]) {
    for (const name of PANEL_TOOLS) {
      const result = await h.call(name, { session: given, confirm: true });
      assertFailure(result, 401, /not authorized/);
      assert.deepEqual(result.structuredContent, { status: 401 }, "an unauthorized caller must not receive the setup state");
    }
  }
  assert.equal(h.gh.length, before, "an unauthorized call must not touch GitHub");
  const good = await h.call(STATE, { session });
  assert.ok(!good.isError, textOf(good));
  assert.equal(good.structuredContent.state.repo, REPO);
});

test("panel tools validate their arguments", async (t) => {
  const h = await connect(t);
  await openPanel(h);
  const before = h.gh.length;
  for (const name of PANEL_TOOLS) {
    const invalid = [{}, { session: 5 }, { session: "" }, { session: "x".repeat(201) }];
    // The state tool declares no confirm property, so unknown properties are dropped there and the call reaches the session check.
    if (name !== STATE) invalid.push({ session: "x", confirm: "yes" });
    for (const args of invalid) {
      const result = await h.call(name, args);
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.equal(result.structuredContent, undefined, `${name} ${JSON.stringify(args)}`);
    }
  }
  const dropped = await h.call(STATE, { session: "x", confirm: "yes" });
  assertFailure(dropped, 401, /not authorized/);
  assert.equal(h.gh.length, before);
});

test("actions need an explicit confirmation and are refused out of order", async (t) => {
  const h = await connect(t);
  const { session } = await openPanel(h);
  const act = (name, args = {}) => h.call(name, { session, ...args });
  const before = h.gh.length;
  for (const confirm of [undefined, false]) {
    const result = await act(VERIFY, { confirm });
    assertFailure(result, 400, "Confirm this action before continuing.");
    assert.equal(result.structuredContent.state.current, "install");
  }
  assertFailure(await act(SCAN, { confirm: true }), 409, "Verify the installation before running a scan.");
  assertFailure(await act(CHECK, { confirm: true }), 409, "Request a verification run first.");
  assertFailure(await act(SAVE, { confirm: true }), 409, /already saved/);
  assert.equal(h.gh.length, before, "refused actions must not reach GitHub");
});

test("a resumed setup verifies, checks and scans through the panel's tools", async (t) => {
  const h = await connect(t);
  const { session, state: opened } = await openPanel(h);
  const act = async (name) => {
    const result = await h.call(name, { session, confirm: true });
    assert.ok(!result.isError, textOf(result));
    assertModelSafe(result, session, loopback(opened).session);
    return result;
  };

  let result = await act(VERIFY);
  assert.equal(textOf(result), "Verification requested in GitHub Actions. This page checks automatically.");
  assert.equal(result.structuredContent.state.installation.status, "running");
  assert.equal(result.structuredContent.state.current, "install");
  assert.equal(h.gh.filter(({ args }) => args.includes("POST")).length, 1);

  result = await act(CHECK);
  assert.equal(textOf(result), "Installation verified in GitHub Actions; the verification token was revoked.");
  assert.equal(result.structuredContent.state.installation.status, "verified");
  assert.equal(result.structuredContent.state.current, "scan");

  result = await act(SCAN);
  assert.equal(textOf(result), "Scan requested. Check https://github.com/acme/widgets/actions and the issue's assignees and linked PR. A dispatch alone is not proof of assignment.");
  const { state } = result.structuredContent;
  assert.equal(state.scan.requested, true);
  assert.equal(state.current, null);
  assert.deepEqual(state.steps.map(({ status }) => status), Array(5).fill("complete"));
  assert.deepEqual(h.gh.at(-1).args, ["workflow", "run", "cicd-optimizer-scan.yml", "--repo", REPO]);
  assert.ok(!h.gh.some(({ args }) => args[1] === "set"), "a resumed setup never writes credentials");

  const status = await h.call(STATUS);
  assert.equal(textOf(status), [
    "CI/CD Optimizer setup for acme/widgets (resumed from saved credentials): All 5 steps complete.",
    "1. Register the App: complete",
    "2. Store the key: complete",
    "3. Install and verify: complete",
    "4. Authorize the coding agent: complete",
    "5. Run the first scan: complete",
    "Installation check: verified.",
    "Last result: Scan requested. Check https://github.com/acme/widgets/actions and the issue's assignees and linked PR. A dispatch alone is not proof of assignment.",
    `Expires at ${state.expiresAt}.`,
    "This host advertises MCP Apps support.",
  ].join("\n"));
  assertModelSafe(status, session);
});

test("a queued verification cannot be dispatched twice and finishes when GitHub reports success", async (t) => {
  const run = { status: "queued", conclusion: null };
  const h = await connect(t, { run });
  const { session } = await openPanel(h);
  const act = (name) => h.call(name, { session, confirm: true });
  const dispatches = () => h.gh.filter(({ args }) => args.includes("POST")).length;

  const started = await act(VERIFY);
  assert.equal(started.structuredContent.state.installation.status, "running");
  assert.deepEqual(started.structuredContent.state.installation.run, { id: 76, url: "https://github.com/acme/widgets/actions/runs/76" });
  assert.equal(dispatches(), 1);

  const again = await act(VERIFY);
  assertFailure(again, 409, "Verification is already running. No additional run was started.");
  assert.equal(again.structuredContent.state.installation.status, "running");
  assert.equal(dispatches(), 1);

  const waiting = await act(CHECK);
  assert.equal(textOf(waiting), "Verification is still queued or running. This page checks automatically.");
  assert.equal(waiting.structuredContent.state.installation.status, "running");

  Object.assign(run, { status: "completed", conclusion: "success" });
  const done = await act(CHECK);
  assert.equal(done.structuredContent.state.installation.status, "verified");
  assert.equal(dispatches(), 1);
});

test("a failed verification is reported to the panel and can be retried", async (t) => {
  const run = { conclusion: "failure" };
  const h = await connect(t, { run });
  const { session } = await openPanel(h);
  const act = (name) => h.call(name, { session, confirm: true });
  const dispatches = () => h.gh.filter(({ args }) => args.includes("POST")).length;
  const reason = "App verification did not succeed. Inspect the linked run, correct the installation or credentials, and retry.";

  await act(VERIFY);
  const failed = await act(CHECK);
  assertFailure(failed, 502, reason);
  assert.equal(failed.structuredContent.state.installation.status, "failed");
  assert.deepEqual(failed.structuredContent.state.error, { step: "install", message: reason });

  run.conclusion = "success";
  const retried = await act(VERIFY);
  assert.ok(!retried.isError, textOf(retried));
  assert.equal(dispatches(), 2);
  assert.equal(retried.structuredContent.state.installation.status, "running");
  assert.equal(retried.structuredContent.state.error, null);
  assert.equal((await act(CHECK)).structuredContent.state.installation.status, "verified");
});

test("a fresh setup finishes through the panel's tools plus the two browser-only steps, and no secret reaches the model", async (t) => {
  const h = await connect(t);
  const { session, state: first } = await openPanel(h, { repo: REPO });
  const { origin, session: loopbackSession } = loopback(first);
  const results = [];
  const act = async (name) => {
    const result = await h.call(name, { session, confirm: true });
    results.push(result);
    assertModelSafe(result, session, loopbackSession, USER_TOKEN);
    return result;
  };
  const read = async () => {
    const result = await h.call(STATE, { session });
    results.push(result);
    return result.structuredContent.state;
  };

  assertFailure(await act(SAVE), 409, "Register the App before saving credentials.");

  await registerInBrowser(first);
  let state = await read();
  assert.deepEqual(state.app, { id: 123, slug: SLUG });
  assert.equal(state.registration, null);
  assert.equal(state.urls.register, null);
  assert.equal(state.urls.install, `https://github.com/apps/${SLUG}/installations/new`);
  assert.equal(state.current, "credentials");
  assert.equal(h.gh.filter(({ args }) => args[1] === "set").length, 0);

  let result = await act(SAVE);
  assert.equal(textOf(result), "App credentials saved. Install on the selected repository next.");
  assert.equal(result.structuredContent.state.current, "install");
  assert.deepEqual(h.gh.filter(({ args }) => args[1] === "set"), [
    { args: ["secret", "set", "CICD_OPTIMIZER_APP_PRIVATE_KEY", "--repo", REPO], input: pem },
    { args: ["variable", "set", "CICD_OPTIMIZER_APP_ID", "--repo", REPO, "--body", "123"], input: undefined },
  ]);

  result = await act(VERIFY);
  assert.equal(textOf(result), "Installation verified with a short-lived repository-scoped token, which has been revoked.");
  assert.equal(result.structuredContent.state.current, "authorize");
  assert.ok(h.requests.some((request) => request.path === "/installation/token" && request.method === "DELETE"), "the short-lived token must be revoked");

  // The coding agent's token is a secret, so it is accepted only by the loopback page and never by a tool.
  assertFailure(await act(SCAN), 409, "Authorize the coding agent before running a scan.");
  const authorized = await fetch(`${origin}/api/authorize-copilot`, {
    method: "POST",
    headers: { "X-Setup-Session": loopbackSession, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true, token: USER_TOKEN }),
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(h.gh.at(-1), { args: ["secret", "set", "COPILOT_ASSIGN_TOKEN", "--repo", REPO], input: USER_TOKEN });

  state = await read();
  assert.deepEqual(state.copilot, { saved: true });
  assert.equal(state.current, "scan");
  result = await act(SCAN);
  assert.deepEqual(h.gh.at(-1).args, ["workflow", "run", "cicd-optimizer-scan.yml", "--repo", REPO]);
  assert.deepEqual(result.structuredContent.state.steps.map(({ status }) => status), Array(5).fill("complete"));

  assert.ok(results.length >= 6);
  for (const each of results) assertNoCredentials(each);
  assertNoCredentials(await h.call(STATUS));
});

test("opening again with the same arguments reuses the panel, even while two opens race", async (t) => {
  const h = await connect(t);
  const [a, b] = await Promise.all([h.call(OPEN, RESUME), h.call(OPEN, RESUME)]);
  assert.equal(a.structuredContent.session, b.structuredContent.session);
  assert.equal(h.gh.filter(({ args }) => args.at(-1) === `repos/${REPO}`).length, 1, "the racing opens must start one setup");
  const reads = h.gh.length;
  const again = await openPanel(h);
  assert.equal(again.session, a.structuredContent.session);
  assert.equal(h.gh.length, reads);
  assert.equal(textOf(again.result), textOf(a));
});

test("opening with different arguments replaces the setup and retires the old panel and its loopback port", async (t) => {
  const h = await connect(t);
  const first = await openPanel(h, { repo: REPO });
  assert.equal((await fetch(first.state.urls.setup)).status, 200);
  const second = await openPanel(h);
  assert.notEqual(second.session, first.session);
  assert.equal(second.state.resumed, true);
  assertFailure(await h.call(STATE, { session: first.session }), 401, /not authorized/);
  await assert.rejects(fetch(first.state.urls.setup), "the replaced setup must stop listening");
  assert.equal((await fetch(second.state.urls.setup)).status, 200);
});

test("a setup holding an App key that is not saved yet is never replaced", async (t) => {
  const h = await connect(t);
  const first = await openPanel(h, { repo: REPO });
  await registerInBrowser(first.state);

  const refused = await h.call(OPEN, RESUME);
  assertFailure(refused, 409, /holds a registered App key that is not saved yet/);
  assert.equal(refused.structuredContent.state, undefined);
  const same = await openPanel(h, { repo: REPO });
  assert.equal(same.session, first.session, "asking for the same setup again must keep it");
  assert.equal((await h.call(STATE, { session: first.session })).structuredContent.state.app.id, 123);

  const saved = await h.call(SAVE, { session: first.session, confirm: true });
  assert.ok(!saved.isError, textOf(saved));
  const replaced = await openPanel(h);
  assert.notEqual(replaced.session, first.session);
  assertFailure(await h.call(STATE, { session: first.session }), 401, /not authorized/);
});

test("without MCP Apps support the open tool hands over the local setup link instead of a panel", async (t) => {
  const h = await connect(t, { ui: false });
  const { result, session, state } = await openPanel(h);
  const text = textOf(result);
  assert.ok(text.includes(state.urls.setup));
  assert.match(text, /This host cannot show the interactive panel\./);
  assert.ok(!text.includes(session), "the panel token is never model-visible");
  assert.equal((await fetch(state.urls.setup)).status, 200);

  const status = textOf(await h.call(STATUS));
  assert.match(status, /This host does not advertise MCP Apps support\.$/);
  assertModelSafe({ content: [{ text: status }] }, session);
});

test("the repository defaults from GITHUB_REPOSITORY, then the gh working directory, and is validated", async (t) => {
  const fromEnv = await connect(t, { env: { GITHUB_REPOSITORY: REPO } });
  assert.equal((await openPanel(fromEnv, {})).state.repo, REPO);

  const base = githubCommand();
  const fromGh = await connect(t, { command: async (args, input) => (args[0] === "repo" ? `${REPO}\n` : base(args, input)) });
  assert.equal((await openPanel(fromGh, {})).state.repo, REPO);

  assertFailure(await (await connect(t)).call(OPEN, {}), 400, "Pass repo as OWNER/REPOSITORY.");
  const invalid = await connect(t, { env: { GITHUB_REPOSITORY: "../etc" } });
  assertFailure(await invalid.call(OPEN, {}), 400, "Pass repo as OWNER/REPOSITORY.");
  assert.equal(invalid.gh.length, 0);
});

test("a setup that cannot start explains why and leaves nothing running", async (t) => {
  const denied = await connect(t, { admin: false });
  const result = await denied.call(OPEN, { repo: REPO });
  assertFailure(result, 502, "Repository admin access is required to save setup credentials.");
  assert.equal(result.structuredContent.state, undefined);
  assertFailure(await denied.call(STATE, { session: "anything" }), 401, /not authorized/);

  const base = githubCommand();
  const mismatched = await connect(t, { command: async (args, input) => (args[0] === "variable" ? "999" : base(args, input)) });
  assertFailure(await mismatched.call(OPEN, RESUME), 502, "The existing App does not match CICD_OPTIMIZER_APP_ID. Check the App slug and repository settings.");
});

test("an expired setup tells the panel to restart, and opening again issues a new session", async (t) => {
  const h = await connect(t, { lifetime: 100 });
  const first = await openPanel(h);
  await waitFor(async () => (await h.call(STATE, { session: first.session })).structuredContent.state.expired);

  const result = await h.call(VERIFY, { session: first.session, confirm: true });
  assertFailure(result, 410, "Setup expired. Call cicd_optimizer_setup to start again.");
  assert.equal(result.structuredContent.state.expired, true);
  assert.equal(h.gh.filter(({ args }) => args.includes("POST")).length, 0, "an expired setup must not act");

  const second = await openPanel(h);
  assert.notEqual(second.session, first.session);
  assert.equal(second.state.expired, false);
  assertFailure(await h.call(STATE, { session: first.session }), 401, /not authorized/);
});

test("closing the sessions stops the loopback listener and invalidates the panel", async (t) => {
  const h = await connect(t);
  const { session, state } = await openPanel(h);
  assert.equal((await fetch(state.urls.setup)).status, 200);
  await h.closeSessions();
  await assert.rejects(fetch(state.urls.setup));
  assertFailure(await h.call(STATE, { session }), 401, /not authorized/);
  assert.match(textOf(await h.call(STATUS)), /^No setup is in progress\. Call cicd_optimizer_setup to start one\./);
  await h.closeSessions();
});

test("a host can launch the stdio server, list its tools and read its panel", async (t) => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: "pipe" });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "stdio-host", version: "1.0.0" }, { capabilities: UI_CAPABILITIES });
  const errors = [];
  client.onerror = (error) => errors.push(error);
  t.after(() => client.close());
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), Object.values(SETUP_TOOLS).sort());
  const { contents } = await client.readResource({ uri: SETUP_RESOURCE_URI });
  assert.equal(contents[0].text, BUILT_VIEW);
  assert.equal(contents[0].mimeType, MIME);
  const status = await client.callTool({ name: STATUS, arguments: {} });
  assert.equal(textOf(status), `No setup is in progress. Call cicd_optimizer_setup to start one. This host advertises MCP Apps support.`);
  assertFailure(await client.callTool({ name: STATE, arguments: { session: "nope" } }), 401, /not authorized/);
  assert.deepEqual(errors, [], stderr.join(""));
});

test("the stdio server writes only protocol messages to stdout and exits cleanly when the host disconnects", async (t) => {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(() => child.kill());
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const lines = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop();
    lines.push(...parts.filter(Boolean));
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  // Parsing every line here is the point: a stray log line would throw and fail the test.
  const reply = (id) => waitFor(() => lines.map((line) => JSON.parse(line)).find((message) => message.id === id));

  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw-host", version: "1.0.0" } } });
  const initialized = await reply(1);
  assert.equal(initialized.result.serverInfo.name, "cicd-optimizer-setup");
  assert.match(initialized.result.instructions, /Never ask for or accept a token/);
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  const listed = await reply(2);
  assert.deepEqual(listed.result.tools.map(({ name }) => name).sort(), Object.values(SETUP_TOOLS).sort());

  child.stdin.end();
  const [code, signal] = await once(child, "exit", { signal: AbortSignal.timeout(10_000) });
  assert.deepEqual([code, signal], [0, null], stderr.join(""));
  for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, "2.0");
});
