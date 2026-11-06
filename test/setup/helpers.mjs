import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_PERMISSIONS } from "../../scripts/setup-app.mjs";
import { THEME_SCRIPT } from "../../scripts/setup-pages.mjs";
import { startSetup } from "../../scripts/setup-session.mjs";

export const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const pem = privateKey.export({ type: "pkcs1", format: "pem" });

export const saved = { app: { id: 123, slug: "ci-cd-optimizer-acme" }, copilot: true };
export const verification = { id: 76, url: "https://github.com/acme/widgets/actions/runs/76", branch: "main", sha: "a".repeat(40) };
export const successfulRun = {
  id: 76, repository: { full_name: "acme/widgets" }, path: ".github/workflows/cicd-optimizer-verify-app.yml",
  event: "workflow_dispatch", head_branch: "main", head_sha: verification.sha,
  status: "completed", conclusion: "success", run_attempt: 1,
};

export function verificationCommand(options = {}) {
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
    if (path === "repos/acme/widgets/actions/runs/76") {
      options.onRunRead?.();
      return JSON.stringify({ ...successfulRun, ...options.run });
    }
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

// A fake of the GitHub REST seam that startSetup takes as `request`; `calls` records every request.
export function fakeRequest(options = {}, calls = []) {
  return async (path, params = {}) => {
    calls.push({ path, ...params });
    if (path === "/user" && options.tokenFailure) throw new Error(`GitHub rejected the token ${params.token}.`);
    if (path.startsWith("/app-manifests/")) {
      if (options.conversionFailure) throw new Error("GitHub declined the registration.");
      return options.conversion ?? { id: 123, slug: "ci-cd-optimizer-acme", pem, client_secret: "NEVER-EXPOSE" };
    }
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
  };
}

// A fake `gh` for prepareSetup's reads, the saved-App lookup, credential writes and the verification workflow. `calls` records every command.
export function githubCommand(options = {}) {
  const { admin = true, type = "Organization", resume = saved, calls = [] } = options;
  const workflow = verificationCommand(options);
  return async (args, input) => {
    calls.push({ args, input });
    const path = args.at(-1);
    if (args[0] === "api" && path === "repos/acme/widgets") {
      return JSON.stringify({ full_name: "acme/widgets", default_branch: "main", permissions: { admin }, owner: { type, login: "acme" } });
    }
    if (args[0] === "api" && path === "user") return JSON.stringify({ login: "acme" });
    if (args[0] === "api" && path.startsWith("apps/")) return JSON.stringify(resume.app);
    if (args[0] === "variable" && args[1] === "get") return String(resume.app.id);
    if (args[0] === "secret" && args[1] === "list") {
      return JSON.stringify([{ name: "CICD_OPTIMIZER_APP_PRIVATE_KEY" }, ...(resume.copilot ? [{ name: "COPILOT_ASSIGN_TOKEN" }] : [])]);
    }
    if (args[0] === "secret" || args[0] === "variable") return "";
    return workflow(args, input);
  };
}

export const loopback = (state) => {
  const url = new URL(state.urls.setup);
  return { origin: url.origin, session: url.searchParams.get("session") };
};

// What the user's browser does: open the registration page, then GitHub redirects back with a code.
export async function registerInBrowser(state) {
  const page = await fetch(state.urls.register);
  assert.equal(page.status, 200);
  await page.text();
  const cookie = page.headers.get("set-cookie").split(";")[0];
  const nonce = new URL(state.registration.action).searchParams.get("state");
  const done = await fetch(`${loopback(state).origin}/registered?state=${nonce}&code=registration-code`, { headers: { Cookie: cookie }, redirect: "manual" });
  assert.equal(done.status, 303);
}

export async function makeAssets(t) {
  const directory = await mkdtemp(join(tmpdir(), "setup-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.html"), [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>CI/CD Optimizer setup</title>",
    `<script>${THEME_SCRIPT}</script><link rel="stylesheet" href="/assets/app.css"></head>`,
    "<body><div id=\"root\"></div><script type=\"module\" src=\"/assets/app.js\"></script></body></html>",
  ].join(""));
  await writeFile(join(directory, "app.js"), "export {};\n");
  await writeFile(join(directory, "app.css"), "body{margin:0}\n");
  return directory;
}

// A fake GitHub plus a JSON-API client for one loopback setup server.
export async function fixture(t, options = {}) {
  const calls = [];
  const writes = [];
  const seen = [];
  const assets = options.assets ?? await makeAssets(t);
  // Dropping an unsaved key on close warns on stderr; keep test output clean but inspectable.
  t.mock.method(console, "error", (...args) => options.log?.push(args.join(" ")));
  const setup = await startSetup({ repo: "acme/widgets", organization: options.organization ?? true, saved: options.saved }, {
    assets,
    refreshInterval: options.refreshInterval ?? 0,
    lifetime: options.lifetime,
    request: fakeRequest(options, calls),
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
  seen.push(await first.text());
  const build = (extra = {}) => {
    const headers = { "X-Setup-Session": setup.session, ...extra };
    for (const [name, value] of Object.entries(headers)) if (value === null) delete headers[name];
    return headers;
  };
  const api = async (path, init = {}) => {
    const response = await fetch(`${setup.origin}/api/${path}`, { ...init, headers: build(init.headers) });
    seen.push(await response.clone().text());
    return response;
  };
  const state = async () => (await api("state")).json();
  const post = (action, body = {}, headers = {}) => api(action, {
    method: "POST",
    headers: { Origin: setup.origin, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ confirm: true, ...body }),
  });
  // The registration state exists only until an App is registered, so capture it once.
  const initial = await state();
  const registrationState = initial.registration ? new URL(initial.registration.action).searchParams.get("state") : "unavailable";
  const callback = (headers = { Cookie: cookie }) => fetch(`${setup.origin}/registered?state=${registrationState}&code=registration-code`, { headers, redirect: "manual" });
  return { ...setup, assets, calls, writes, seen, cookie, api, state, initial, post, callback, registrationState };
}
