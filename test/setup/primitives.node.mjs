import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  APP_PERMISSIONS, appJwt, registrationManifest, loadSavedSetup,
  requestSavedAppVerification, checkSavedAppVerification,
} from "../../scripts/setup-app.mjs";
import { verifyConfiguredApp } from "../../scripts/verify-app.mjs";
import { pem, publicKey, saved, verification, verificationCommand } from "./helpers.mjs";

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

test("App JWT is a short-lived signed RS256 credential", () => {
  const jwt = appJwt({ id: 123, pem });
  const [header, payload, signature] = jwt.split(".");
  assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")), true);
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, 123);
  assert.ok(claims.exp - claims.iat <= 600);
});

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

test("saved-App workflow is manual, verification-only, and keeps inputs out of shell interpolation", async () => {
  const workflow = (await readFile(new URL("../../.github/workflows/cicd-optimizer-verify-app.yml", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(workflow, /on:\n {2}workflow_dispatch:/);
  assert.ok(!/^\s+(push|pull_request|schedule|workflow_run):/m.test(workflow));
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.match(workflow, /name: Verify selected-repository App access/);
  assert.match(workflow, /name: Verify App installation\n\s+run: node scripts\/verify-app\.mjs/);
  assert.match(workflow, /EXPECTED_APP_ID: \$\{\{ inputs\.app_id \}\}/);
  assert.match(workflow, /APP_PRIVATE_KEY: \$\{\{ secrets\.CICD_OPTIMIZER_APP_PRIVATE_KEY \}\}/);
  assert.ok(!workflow.includes("COPILOT_ASSIGN_TOKEN"));
  assert.ok(!workflow.includes("cicd-optimizer-scan"));
  assert.ok(!workflow.includes("upload-artifact"));
});
