import { createServer } from "node:http";
import { randomBytes, createPrivateKey, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// Keep in sync with app.yml; the manifest parity test enforces this contract.
export const APP_PERMISSIONS = {
  actions: "read", checks: "write", contents: "write", issues: "write", metadata: "read",
  pull_requests: "write", security_events: "write", workflows: "write",
};

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const nonce = () => randomBytes(32).toString("hex");

export function appJwt(app) {
  const now = Math.floor(Date.now() / 1000);
  const encoded = (data) => Buffer.from(JSON.stringify(data)).toString("base64url");
  const input = `${encoded({ alg: "RS256", typ: "JWT" })}.${encoded({ iat: now - 60, exp: now + 300, iss: app.id })}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), createPrivateKey(app.pem)).toString("base64url")}`;
}

export async function githubRequest(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub request failed (HTTP ${response.status}). Check access and retry.`);
  if (response.status === 204) return undefined;
  try { return await response.json(); } catch { throw new Error("GitHub returned an invalid response. Retry the current step."); }
}

export function gh(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, GH_HOST: "github.com", GH_PAGER: "" } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    // Never echo command errors: remote error bodies may include submitted credentials.
    child.stderr.resume();
    child.on("error", () => reject(new Error("Cannot run gh. Install GitHub CLI and run gh auth login first.")));
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error("GitHub CLI failed. Check gh authentication and repository admin access, then retry.")));
    child.stdin.on("error", () => { /* An early child exit is reported by close. */ });
    child.stdin.end(input);
  });
}

export function registrationManifest(repo, origin) {
  // Omit hook_attributes entirely: GitHub validates even an inactive webhook's URL.
  return {
    name: `ci-cd-optimizer-${repo.split("/")[0].toLowerCase()}`,
    url: `https://github.com/${repo}`,
    description: "Dependabot-style CI/CD findings, telemetry, and optimization pull requests.",
    public: false,
    redirect_url: `${origin}/registered`,
    setup_url: `${origin}/installed`,
    default_permissions: APP_PERMISSIONS,
    default_events: [],
    request_oauth_on_install: false,
  };
}

const verificationWorkflow = "cicd-optimizer-verify-app.yml";
const api = (path) => ["api", "--hostname", "github.com", "-H", "X-GitHub-Api-Version: 2026-03-10", path];

export async function loadSavedSetup(repo, slug, command = gh) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) throw new Error("Specify a repository and an existing App slug.");
  const [identity, configuredId, credentials] = await Promise.all([
    command(api(`apps/${encodeURIComponent(slug)}`)),
    command(["variable", "get", "CICD_OPTIMIZER_APP_ID", "--repo", repo]),
    command(["secret", "list", "--repo", repo, "--json", "name"]),
  ]);
  const app = JSON.parse(identity);
  const secrets = JSON.parse(credentials);
  if (!Number.isSafeInteger(app.id) || app.id <= 0 || app.slug !== slug || String(app.id) !== configuredId.trim()) {
    throw new Error("The existing App does not match CICD_OPTIMIZER_APP_ID. Check the App slug and repository settings.");
  }
  if (!Array.isArray(secrets) || !secrets.some((secret) => secret.name === "CICD_OPTIMIZER_APP_PRIVATE_KEY")) {
    throw new Error("CICD_OPTIMIZER_APP_PRIVATE_KEY is not saved in this repository. Finish saving it before resuming.");
  }
  return { app: { id: app.id, slug: app.slug }, copilot: secrets.some((secret) => secret.name === "COPILOT_ASSIGN_TOKEN") };
}

export async function verifyInstallation(repo, app, request = githubRequest) {
  const token = appJwt(app);
  const [owner, name] = repo.split("/");
  const installation = await request(`/repos/${owner}/${name}/installation`, { token });
  if (installation.app_id !== app.id || installation.account?.login?.toLowerCase() !== owner.toLowerCase() ||
    installation.repository_selection !== "selected" || installation.suspended_at) {
    throw new Error("Install this App on the target account using Only select repositories, then retry.");
  }
  for (const [permission, level] of Object.entries(APP_PERMISSIONS)) {
    if (installation.permissions?.[permission] !== level && installation.permissions?.[permission] !== "write") {
      throw new Error(`Installation is missing ${permission}: ${level}. Review the App's permissions.`);
    }
  }
  const access = await request(`/app/installations/${installation.id}/access_tokens`, {
    method: "POST", token, body: { repositories: [name], permissions: APP_PERMISSIONS },
  });
  if (typeof access.token !== "string" || !access.token) throw new Error("GitHub did not return an installation token.");
  try {
    const repository = await request(`/repos/${owner}/${name}`, { token: access.token });
    if (repository.full_name?.toLowerCase() !== repo.toLowerCase()) throw new Error("Installation token cannot access the selected repository.");
  } finally {
    await request("/installation/token", { method: "DELETE", token: access.token });
  }
}

export async function requestSavedAppVerification(repo, app, command = gh) {
  const metadata = JSON.parse(await command(api(`repos/${repo}`)));
  if (metadata.full_name?.toLowerCase() !== repo.toLowerCase() || typeof metadata.default_branch !== "string" || !metadata.default_branch) {
    throw new Error("Cannot identify the target repository's default branch.");
  }
  const branch = metadata.default_branch;
  const commit = JSON.parse(await command(api(`repos/${repo}/commits/${encodeURIComponent(branch)}`)));
  if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error("Cannot identify the default branch commit.");
  let result;
  try {
    result = JSON.parse(await command([
      ...api(`repos/${repo}/actions/workflows/${verificationWorkflow}/dispatches`), "--method", "POST", "--input", "-",
    ], JSON.stringify({ ref: branch, inputs: { app_id: String(app.id) }, return_run_details: true })));
  } catch {
    throw new Error(`Cannot confirm dispatch of ${verificationWorkflow}. Ensure it is installed on the default branch and inspect Actions before retrying; a run may already have started.`);
  }
  if (!Number.isSafeInteger(result.workflow_run_id) || result.workflow_run_id <= 0 ||
    result.html_url?.toLowerCase() !== `https://github.com/${repo}/actions/runs/${result.workflow_run_id}`.toLowerCase()) {
    throw new Error("GitHub did not return a verification run ID. Inspect Actions before retrying; a run may already have started.");
  }
  return { id: result.workflow_run_id, url: result.html_url, branch, sha: commit.sha };
}

export async function checkSavedAppVerification(repo, verification, command = gh) {
  const run = JSON.parse(await command(api(`repos/${repo}/actions/runs/${verification.id}`)));
  if (run.id !== verification.id || run.repository?.full_name?.toLowerCase() !== repo.toLowerCase() ||
    run.path !== `.github/workflows/${verificationWorkflow}` || run.event !== "workflow_dispatch" ||
    run.head_branch !== verification.branch || run.head_sha !== verification.sha) {
    throw new Error("The verification run does not match this setup request. If the default branch changed, start another verification.");
  }
  if (["queued", "in_progress", "waiting", "pending", "requested"].includes(run.status)) return false;
  if (run.status !== "completed") throw new Error("GitHub returned an unrecognized verification run status.");
  if (run.conclusion !== "success") throw new Error("App verification did not succeed. Inspect the linked run, correct the installation or credentials, and retry.");
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error("GitHub did not identify the verification attempt.");
  const result = JSON.parse(await command(api(`repos/${repo}/actions/runs/${verification.id}/attempts/${run.run_attempt}/jobs?per_page=100`)));
  const job = result.jobs?.find((candidate) => candidate.name === "Verify selected-repository App access");
  if (job?.status !== "completed" || job.conclusion !== "success" ||
    !job.steps?.some((step) => step.name === "Verify App installation" && step.status === "completed" && step.conclusion === "success")) {
    throw new Error("The App verification step did not run successfully. A skipped verification is not proof of installation.");
  }
  return true;
}

export async function startSetup({ repo, organization = false, saved }, { request = githubRequest, command = gh } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Use --repo OWNER/REPOSITORY.");
  if (saved && (!Number.isSafeInteger(saved.app?.id) || saved.app.id <= 0 || typeof saved.app.slug !== "string" || !/^[a-z0-9-]+$/.test(saved.app.slug))) {
    throw new Error("Invalid saved App identity.");
  }
  const state = nonce();
  const csrf = nonce();
  const session = nonce();
  const template = await readFile(new URL("./setup-app.html", import.meta.url), "utf8");
  let origin;
  let app = saved ? { id: saved.app.id, slug: saved.app.slug } : undefined;
  let stored = Boolean(saved);
  let installed = false;
  let copilot = saved?.copilot === true;
  let verification;
  let verificationFailed = false;
  let busy = false;
  let expired = false;
  let message = "";
  const base = () => `${origin}/?session=${session}`;
  const installUrl = () => `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`;
  const page = (res, content, status = 200) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(template.replace("<!-- CONTENT -->", content));
  };
  const statusPage = (res) => {
    if (verification && !installed && !verificationFailed) res.setHeader("Refresh", "5; url=/");
    const form = (action, label, extra = "") => `<form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}">${extra}<button>${label}</button></form>`;
    const settings = `https://github.com/settings/personal-access-tokens/new?name=CI%2FCD%20Optimizer%20assignment&description=Assign%20optimization%20issues%20to%20Copilot&target_name=${encodeURIComponent(repo.split("/")[0])}&expires_in=30&issues=write`;
    const manifest = registrationManifest(repo, origin);
    const registration = organization
      ? `https://github.com/organizations/${encodeURIComponent(repo.split("/")[0])}/settings/apps/new`
      : "https://github.com/settings/apps/new";
    page(res, `<h1>CI/CD Optimizer setup</h1><p class="muted">${escape(repo)} · Actions-hosted mode</p>
      <p>Register once, install on this repository, and authorize the coding-agent handoff. No paid hosting or public webhook is needed.</p>
      ${message ? `<p role="status">${escape(message)}</p>` : ""}
      <section><h2>1. Register the App</h2>${app ? `<p>Registered: ${escape(app.slug)} (ID ${app.id}).</p>` :
        `<p>GitHub will ask you to approve a private App with Actions read access and write access to checks, contents, issues, pull requests, security events and workflows. No account-wide user permissions.</p>
        <p>Already saved an App? Restart with <code>--resume-app YOUR-APP-SLUG</code> instead of registering another.</p>
        <form action="${registration}?state=${state}" method="post"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>Review registration on GitHub</button></form>`}</section>
      ${app ? `<section><h2>2. Store the App key</h2>${saved ? "<p>Resumed from repository settings. The private key remains in GitHub; this process does not have it. No credentials were replaced.</p>" :
        "<p>The generated key stays in this process until saved. It is never printed, written to disk, or returned to the browser. Closing setup before saving requires generating a replacement key in GitHub.</p>"}
        ${stored ? "<p>Saved CICD_OPTIMIZER_APP_PRIVATE_KEY and CICD_OPTIMIZER_APP_ID.</p>" :
        `<p>This writes or replaces CICD_OPTIMIZER_APP_PRIVATE_KEY and CICD_OPTIMIZER_APP_ID in <strong>${escape(repo)}</strong>.</p>${form("/save", "Save credentials to this repository")}`}</section>` : ""}
      ${stored ? `<section><h2>3. Install and verify</h2><p>Choose <strong>Only select repositories</strong> and select <strong>${escape(repo)}</strong>. Installation grants access; it does not authorize Copilot as you.</p>
        <p><a href="${installUrl()}">Install on GitHub</a></p>${saved ?
        `<p>Verification runs in this repository's GitHub Actions using the saved key. It checks access and creates then revokes a repository-scoped token; it does not run a scan, create findings, or assign agents. Actions usage may consume your plan's allowance.</p>
        ${verification ? `<p><a href="${escape(verification.url)}" target="_blank" rel="noreferrer">View verification run</a></p>${form("/verify-result", "Check verification result")}` : ""}
        ${!verification || installed || verificationFailed ? form("/verify", verification ? "Verify again" : "Verify installation") : "<p>Verification is running. This page checks automatically; you do not need to press another button.</p>"}` : form("/verify", "Verify installation")}
        ${installed ? "<p>Installation and repository-scoped token verified.</p>" : ""}</section>` : ""}
      ${installed ? `<section><h2>4. Authorize the coding agent</h2><p>GitHub requires a Copilot-licensed user's token to start coding agents. App installation tokens cannot do this. Create a fine-grained token limited to <strong>${escape(repo)}</strong> with <strong>Issues: read and write</strong>, and an expiry. Select this repository explicitly on GitHub.</p>
        <p><a href="${settings}" target="_blank" rel="noreferrer">Create a scoped assignment token on GitHub</a></p>
        <p>Paste it below to validate repository visibility and save it directly as COPILOT_ASSIGN_TOKEN. This cannot prove your Copilot license or Issues write permission until an assignment succeeds. Never paste the token into chat.</p>
        ${form("/copilot", "Validate and save assignment token", '<label>Assignment token <input required type="password" name="token" autocomplete="off" maxlength="1024"></label>')}
        ${copilot ? "<p>Assignment token stored. Existing copilot:ready findings will be retried by the next scan.</p>" : "<p>Not authorized yet: copilot:ready is a queue label, not a running agent.</p>"}</section>` : ""}
      ${installed && copilot ? `<section><h2>5. Run the first scan</h2><p>This runs the repository's existing scan workflow, including configured issue/PR writes and coding-agent assignments. Copilot usage consumes your plan's allowance.</p>${form("/scan", "Run scan and assign pending findings")}</section>` : ""}
      ${stored ? `<p>To resume after stopping or updating setup, run <code>npm run setup -- --repo ${escape(repo)} --resume-app ${escape(app.slug)}</code>. Saved credentials remain in GitHub.</p>` : ""}
      <p class="muted">This setup server listens only on 127.0.0.1 and expires after one hour. For webhook hosting and a durable database, follow docs/github-app.md.</p>`);
  };
  async function refreshVerification() {
    installed = false;
    verificationFailed = false;
    try { installed = await checkSavedAppVerification(repo, verification, command); }
    catch (error) { verificationFailed = true; throw error; }
    message = installed ? "Installation verified in GitHub Actions; the verification token was revoked." : "Verification is still queued or running. This page checks automatically.";
  }
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader("Cache-Control", "no-store");
      // no-referrer makes native form POSTs send Origin: null; keep local origins and suppress external referrers.
      res.setHeader("Referrer-Policy", "same-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'");
      if (expired) { page(res, "<h1>Setup expired</h1><p>Restart npm run setup.</p>", 410); return; }
      if (req.headers.host !== new URL(origin).host) { page(res, "<h1>Invalid host</h1>", 403); return; }
      const url = new URL(req.url, origin);
      const cookie = (req.headers.cookie ?? "").split(";").map((part) => part.trim());
      const authorized = cookie.includes(`optimizer_setup=${session}`);
      if (req.method === "GET" && url.pathname === "/" && (authorized || url.searchParams.get("session") === session)) {
        res.setHeader("Set-Cookie", `optimizer_setup=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`);
        if (verification && !installed && !verificationFailed && !busy) {
          busy = true;
          try { await refreshVerification(); } finally { busy = false; }
        }
        statusPage(res); return;
      }
      if (req.method === "GET" && url.pathname === "/registered") {
        if (!authorized || url.searchParams.get("state") !== state || app || busy) { page(res, "<h1>Invalid or consumed registration</h1>", 403); return; }
        const code = url.searchParams.get("code");
        if (!code || !/^[a-zA-Z0-9_-]+$/.test(code) || code.length > 200) { page(res, "<h1>Missing registration code</h1>", 400); return; }
        busy = true;
        try {
          const created = await request(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" });
          if (!Number.isSafeInteger(created.id) || created.id <= 0 || typeof created.slug !== "string" || !/^[a-z0-9-]+$/.test(created.slug) || typeof created.pem !== "string") {
            throw new Error("Invalid App credentials returned by GitHub. Inspect the registration in GitHub settings.");
          }
          createPrivateKey(created.pem);
          // Keep only the credential used for installation authentication, never OAuth secrets.
          app = { id: created.id, slug: created.slug, pem: created.pem };
        } finally { busy = false; }
        res.writeHead(303, { Location: "/" }); res.end(); return;
      }
      if (req.method === "GET" && url.pathname === "/installed" && authorized) {
        // Callback query parameters are not proof of installation; verify with App authentication.
        res.writeHead(303, { Location: "/" }); res.end(); return;
      }
      if (req.method !== "POST" || !authorized || req.headers.origin !== origin || busy) {
        page(res, '<h1>Forbidden</h1><p>This request was blocked before performing any setup action. Return to the current setup page in this browser and use its button, rather than refreshing or opening an action URL.</p><a href="/">Return to setup</a>', 403);
        return;
      }
      let raw = "";
      for await (const chunk of req) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 4096) { page(res, "<h1>Request too large</h1>", 413); return; }
      }
      const body = new URLSearchParams(raw);
      if (body.get("csrf") !== csrf) { page(res, "<h1>Invalid form token</h1>", 403); return; }
      if (busy) { page(res, "<h1>Another setup step is running</h1>", 409); return; }
      busy = true;
      try {
        if (url.pathname === "/save" && app?.pem) {
          await command(["secret", "set", "CICD_OPTIMIZER_APP_PRIVATE_KEY", "--repo", repo], app.pem);
          await command(["variable", "set", "CICD_OPTIMIZER_APP_ID", "--repo", repo, "--body", String(app.id)]);
          stored = true;
          message = "App credentials saved. Install on the selected repository next.";
        } else if (url.pathname === "/verify" && stored) {
          installed = false;
          if (saved) {
            verification = undefined;
            verificationFailed = false;
            verification = await requestSavedAppVerification(repo, app, command);
            message = "Verification requested in GitHub Actions. This page checks automatically.";
          } else {
            await verifyInstallation(repo, app, request);
            installed = true;
            message = "Installation verified with a short-lived repository-scoped token, which has been revoked.";
          }
        } else if (url.pathname === "/verify-result" && saved && verification) {
          await refreshVerification();
        } else if (url.pathname === "/copilot" && installed) {
          const token = body.get("token")?.trim();
          if (!token || /[\s\0]/.test(token) || token.length > 1024) throw new Error("Enter a valid user token.");
          await request("/user", { token });
          await request(`/repos/${repo}/issues?state=open&per_page=1`, { token });
          await command(["secret", "set", "COPILOT_ASSIGN_TOKEN", "--repo", repo], token);
          copilot = true;
          message = "Assignment credential saved. Run the scan to verify an actual coding-agent assignment.";
        } else if (url.pathname === "/scan" && installed && copilot) {
          await command(["workflow", "run", "cicd-optimizer-scan.yml", "--repo", repo]);
          message = `Scan requested. Check https://github.com/${repo}/actions and the issue's assignees and linked PR. A dispatch alone is not proof of assignment.`;
        } else { page(res, "<h1>Step not available</h1>", 409); return; }
      } finally { busy = false; }
      res.writeHead(303, { Location: "/" }); res.end();
    })().catch((error) => {
      message = error instanceof Error ? error.message : "Setup failed. Retry the current step.";
      // The dependency helpers sanitize remote errors before they reach this page.
      if (!res.headersSent) page(res, `<h1>Setup needs attention</h1><p>${escape(message)}</p><a href="/">Return to setup</a>`, 502);
      else res.end();
    });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const expiry = setTimeout(() => { expired = true; app = undefined; server.close(); server.closeAllConnections(); }, 3_600_000);
  expiry.unref();
  return {
    url: base(), origin,
    close: async () => {
      clearTimeout(expiry);
      if (app && !stored) console.error("App key was not saved. Generate a replacement in GitHub App settings before using the App.");
      app = undefined;
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}

async function main() {
  const { values } = parseArgs({ options: { repo: { type: "string" }, "resume-app": { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    console.log("Usage: npm run setup -- --repo OWNER/REPOSITORY [--resume-app APP-SLUG]\nRequires Node 22+ and an authenticated GitHub CLI with repository admin access. Resume reuses saved credential metadata without retrieving or replacing secrets. Every credential/installation step requires an explicit button.");
    return;
  }
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Use --repo OWNER/REPOSITORY.");
  const metadata = JSON.parse(await gh(["api", "--hostname", "github.com", `repos/${repo}`]));
  const actor = JSON.parse(await gh(["api", "--hostname", "github.com", "user"]));
  if (!metadata.permissions?.admin) throw new Error("Repository admin access is required to save setup credentials.");
  const organization = metadata.owner.type === "Organization";
  if (!organization && metadata.owner.login.toLowerCase() !== actor.login.toLowerCase()) throw new Error("Register a private App as the repository owner.");
  const saved = values["resume-app"] ? await loadSavedSetup(repo, values["resume-app"]) : undefined;
  const setup = await startSetup({ repo, organization, saved });
  console.log(`Open in your signed-in browser:\n${setup.url}\nNo credentials are logged. Stop with Ctrl+C after completing setup.`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void setup.close(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
