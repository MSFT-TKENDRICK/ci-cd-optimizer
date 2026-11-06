import { createPrivateKey, sign } from "node:crypto";
import { spawn } from "node:child_process";

// Keep in sync with app.yml; the manifest parity test enforces this contract.
export const APP_PERMISSIONS = {
  actions: "read", checks: "write", contents: "write", issues: "write", metadata: "read",
  pull_requests: "write", security_events: "write", workflows: "write",
};

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
  if (installation.app_id !== app.id) {
    throw new Error("The installed App ID does not match CICD_OPTIMIZER_APP_ID. Check the saved App configuration.");
  }
  if (installation.account?.login?.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("The App installation does not belong to the target repository's owner. Check the installation account.");
  }
  if (installation.suspended_at) {
    throw new Error("The App installation is suspended. Its owner must resume it in GitHub App settings before verification.");
  }
  if (installation.repository_selection === "all") {
    throw new Error("The App installation grants access to all repositories. Its owner must choose Only select repositories and include the target repository before verification.");
  }
  if (installation.repository_selection !== "selected") {
    throw new Error("GitHub did not report a recognized repository selection for this installation. Inspect its settings before retrying.");
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
