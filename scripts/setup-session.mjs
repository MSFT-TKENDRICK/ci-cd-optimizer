import { createHash, createPrivateKey, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_PERMISSIONS, checkSavedAppVerification, gh, githubRequest, loadSavedSetup, registrationManifest,
  requestSavedAppVerification, verifyInstallation,
} from "./setup-app.mjs";
import { escapeHtml, pageCsp, renderPage, shellCsp } from "./setup-pages.mjs";

const REPO = /^[\w.-]+\/[\w.-]+$/;
const SLUG = /^[a-z0-9-]+$/;
const MAX_BODY = 4096;
const LIFETIME_MS = 3_600_000;
const REFRESH_INTERVAL_MS = 2_500;
const GENERIC_ERROR = "Setup failed. Retry the current step.";
const INVALID_RESPONSE = "GitHub returned an invalid response. Retry the current step.";
const DEFAULT_ASSETS = fileURLToPath(new URL("../dist-setup/", import.meta.url));
const BASE_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff" };

export const SETUP_STEPS = Object.freeze([
  Object.freeze({ id: "register", title: "Register the App" }),
  Object.freeze({ id: "credentials", title: "Store the key" }),
  Object.freeze({ id: "install", title: "Install and verify" }),
  Object.freeze({ id: "authorize", title: "Authorize the coding agent" }),
  Object.freeze({ id: "scan", title: "Run the first scan" }),
]);

export class SetupError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "SetupError";
    this.status = status;
  }
}

const digest = (value) => createHash("sha256").update(value).digest();
const validRepo = (repo) => typeof repo === "string" && REPO.test(repo) && !repo.split("/").some((part) => part === "." || part === "..");
const same = (left, right) => typeof left === "string" && typeof right === "string" && timingSafeEqual(digest(left), digest(right));
const nonce = () => randomBytes(32).toString("hex");
const errorText = (error) => error instanceof SetupError ? error.message : error instanceof SyntaxError ? INVALID_RESPONSE : error?.message || GENERIC_ERROR;

function usableKey(pem) {
  try {
    createPrivateKey(pem);
    return true;
  } catch {
    return false;
  }
}

export async function prepareSetup({ repo, resumeApp } = {}, command = gh) {
  if (!validRepo(repo)) throw new Error("Use --repo OWNER/REPOSITORY.");
  const read = async (path) => JSON.parse(await command(["api", "--hostname", "github.com", path]));
  const metadata = await read(`repos/${repo}`);
  const actor = await read("user");
  if (!metadata.permissions?.admin) throw new Error("Repository admin access is required to save setup credentials.");
  const organization = metadata.owner?.type === "Organization";
  if (!organization && metadata.owner?.login?.toLowerCase() !== actor.login?.toLowerCase()) throw new Error("Register a private App as the repository owner.");
  return { repo, organization, saved: resumeApp ? await loadSavedSetup(repo, resumeApp, command) : undefined };
}

async function loadAssets(directory) {
  try {
    const [html, js, css] = await Promise.all(["index.html", "app.js", "app.css"].map((name) => readFile(join(directory, name))));
    // Browsers hash inline script text after normalizing newlines, so the served HTML must already be LF-only.
    return { html: html.toString("utf8").replace(/\r\n/g, "\n"), js, css };
  } catch {
    throw new Error("Setup UI is not built. Run npm run build:ui.");
  }
}

function send(res, status, body, type, headers = {}) {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), ...BASE_HEADERS, ...headers });
  res.end(body);
}

const sendJson = (res, status, data, headers) => send(res, status, JSON.stringify(data), "application/json; charset=utf-8", headers);

function sendPage(res, status, title, text, { headers, extra = "", forms = false } = {}) {
  const body = `<div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${extra}</div>`;
  send(res, status, renderPage({ title, body }), "text/html; charset=utf-8", { "Content-Security-Policy": pageCsp({ forms }), ...headers });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > MAX_BODY) {
      req.resume();
      reject(new SetupError(413, "Request too large."));
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        failed = true;
        reject(new SetupError(413, "Request too large."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const value = text ? JSON.parse(text) : {};
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Not an object.");
        resolve(value);
      } catch {
        reject(new SetupError(400, "Send a JSON object."));
      }
    });
    req.on("error", () => reject(new SetupError(400, "Request failed.")));
  });
}

export async function startSetup(
  { repo, organization = false, saved } = {},
  { request = githubRequest, command = gh, assets = DEFAULT_ASSETS, lifetime = LIFETIME_MS, refreshInterval = REFRESH_INTERVAL_MS } = {},
) {
  if (saved && (!Number.isSafeInteger(saved.app?.id) || saved.app.id <= 0 || typeof saved.app.slug !== "string" || !SLUG.test(saved.app.slug))) {
    throw new Error("Invalid saved App identity.");
  }
  if (!validRepo(repo)) throw new Error("Use --repo OWNER/REPOSITORY.");
  const files = await loadAssets(assets);
  const shellPolicy = shellCsp(files.html);
  const [owner] = repo.split("/");
  const session = nonce();
  const registrationState = nonce();
  const expiresAt = new Date(Date.now() + lifetime).toISOString();
  const maxAge = Math.max(1, Math.ceil(lifetime / 1000));

  let app = saved ? { id: saved.app.id, slug: saved.app.slug } : undefined;
  let stored = Boolean(saved);
  let installed = false;
  let copilot = saved?.copilot === true;
  let scanRequested = false;
  let verification;
  let verificationFailed = false;
  let busy = false;
  let expired = false;
  let message = "";
  let failure = null;
  let lastRefresh = 0;
  let origin = "";
  let cookieName = "";

  const registrationAction = () => `${organization
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : "https://github.com/settings/apps/new"}?state=${registrationState}`;
  const tokenSettings = `https://github.com/settings/personal-access-tokens/new?name=CI%2FCD%20Optimizer%20assignment&description=Assign%20optimization%20issues%20to%20Copilot&target_name=${encodeURIComponent(owner)}&expires_in=30&issues=write`;
  const sessionCookie = () => `${cookieName}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  const cookieToken = (req) => (req.headers.cookie ?? "").split(/;\s*/).map((part) => part.split("=")).find(([name]) => name === cookieName)?.[1];

  function snapshot() {
    const done = { register: Boolean(app), credentials: stored, install: installed, authorize: copilot, scan: scanRequested };
    const current = SETUP_STEPS.find((step) => !done[step.id])?.id ?? null;
    return {
      repo, owner, organization, resumed: Boolean(saved), expiresAt, expired, busy,
      app: app ? { id: app.id, slug: app.slug } : null,
      credentials: { saved: stored },
      installation: {
        status: installed ? "verified" : verificationFailed ? "failed" : verification ? "running" : "unverified",
        run: verification ? { id: verification.id, url: verification.url } : null,
      },
      copilot: { saved: copilot },
      scan: { requested: scanRequested, actionsUrl: `https://github.com/${repo}/actions` },
      message, error: failure,
      urls: {
        register: app ? null : `${origin}/register?session=${session}`,
        install: app ? `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new` : null,
        tokenSettings, setup: `${origin}/?session=${session}`, actions: `https://github.com/${repo}/actions`,
      },
      registration: app ? null : { action: registrationAction(), manifest: JSON.stringify(registrationManifest(repo, origin)) },
      current,
      steps: SETUP_STEPS.map((step) => ({ ...step, status: done[step.id] ? "complete" : step.id === current ? "current" : "upcoming" })),
    };
  }

  async function refreshVerification() {
    installed = false;
    verificationFailed = false;
    try {
      installed = await checkSavedAppVerification(repo, verification, command);
    } catch (error) {
      verificationFailed = true;
      throw error;
    }
    message = installed
      ? "Installation verified in GitHub Actions; the verification token was revoked."
      : "Verification is still queued or running. This page checks automatically.";
  }

  const actions = {
    "save-credentials": {
      step: "credentials",
      check: () => stored ? "Credentials are already saved. Replace them from GitHub App settings if needed." : !app?.pem ? "Register the App before saving credentials." : undefined,
      async run() {
        await command(["secret", "set", "CICD_OPTIMIZER_APP_PRIVATE_KEY", "--repo", repo], app.pem);
        await command(["variable", "set", "CICD_OPTIMIZER_APP_ID", "--repo", repo, "--body", String(app.id)]);
        stored = true;
        message = "App credentials saved. Install on the selected repository next.";
      },
    },
    verify: {
      step: "install",
      check: () => !stored ? "Save the App credentials before verifying the installation."
        : verification && !installed && !verificationFailed ? "Verification is already running. No additional run was started." : undefined,
      async run() {
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
      },
    },
    "check-verification": {
      step: "install",
      check: () => saved && verification ? undefined : "Request a verification run first.",
      run: refreshVerification,
    },
    "authorize-copilot": {
      step: "authorize",
      check: () => installed ? undefined : "Verify the installation before authorizing the coding agent.",
      async run({ token }) {
        const value = typeof token === "string" ? token.trim() : "";
        if (!value || value.length > 1024 || /[\s\0]/.test(value)) throw new SetupError(400, "Enter a valid user token.");
        try {
          await request("/user", { token: value });
          await request(`/repos/${repo}/issues?state=open&per_page=1`, { token: value });
          await command(["secret", "set", "COPILOT_ASSIGN_TOKEN", "--repo", repo], value);
        } catch (error) {
          // Never let a pasted credential come back in an error message.
          throw new SetupError(502, errorText(error).replaceAll(value, "[redacted]"));
        }
        copilot = true;
        message = "Assignment credential saved. Run the scan to verify an actual coding-agent assignment.";
      },
    },
    "run-scan": {
      step: "scan",
      check: () => !installed ? "Verify the installation before running a scan." : !copilot ? "Authorize the coding agent before running a scan." : undefined,
      async run() {
        await command(["workflow", "run", "cicd-optimizer-scan.yml", "--repo", repo]);
        scanRequested = true;
        message = `Scan requested. Check https://github.com/${repo}/actions and the issue's assignees and linked PR. A dispatch alone is not proof of assignment.`;
      },
    },
  };

  async function act(action, payload = {}) {
    if (expired) throw new SetupError(410, "Setup expired. Restart npm run setup.");
    if (!Object.hasOwn(actions, action)) throw new SetupError(404, "Unknown setup action.");
    if (busy) throw new SetupError(409, "Another setup step is running. Wait for it to finish.");
    if (payload?.confirm !== true) throw new SetupError(400, "Confirm this action before continuing.");
    const definition = actions[action];
    const unavailable = definition.check(payload);
    if (unavailable) throw new SetupError(409, unavailable);
    busy = true;
    failure = null;
    message = "";
    try {
      await definition.run(payload);
    } catch (error) {
      failure = { step: definition.step, message: errorText(error) };
      throw new SetupError(error instanceof SetupError ? error.status : 502, failure.message);
    } finally {
      busy = false;
    }
    return snapshot();
  }

  async function getState() {
    // Several pollers (browser tab, chat panel) may ask at once; throttle upstream checks.
    if (!expired && !busy && verification && !installed && !verificationFailed && Date.now() - lastRefresh >= refreshInterval) {
      busy = true;
      try {
        await refreshVerification();
      } catch (error) {
        failure = { step: "install", message: errorText(error) };
        message = "";
      } finally {
        lastRefresh = Date.now();
        busy = false;
      }
    }
    return snapshot();
  }

  async function completeRegistration(req, res, url) {
    if (!same(cookieToken(req), session) || !same(url.searchParams.get("state"), registrationState) || app || busy) {
      return sendPage(res, 403, "Invalid or consumed registration", "Restart setup if this registration was already used.");
    }
    const code = url.searchParams.get("code");
    if (!code) return sendPage(res, 400, "Missing registration code", "GitHub did not return a registration code.");
    if (code.length > 200 || !/^[a-zA-Z0-9_-]+$/.test(code)) return sendPage(res, 400, "Invalid registration code", "GitHub returned an unexpected registration code.");
    busy = true;
    failure = null;
    try {
      const credentials = await request(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" });
      if (!Number.isSafeInteger(credentials?.id) || credentials.id <= 0 || typeof credentials.slug !== "string" || !SLUG.test(credentials.slug) ||
        typeof credentials.pem !== "string" || !usableKey(credentials.pem)) {
        throw new SetupError(502, "Invalid App credentials returned by GitHub. Inspect the registration in GitHub settings.");
      }
      app = { id: credentials.id, slug: credentials.slug, pem: credentials.pem };
      message = "App registered. Save its credentials to this repository next.";
      res.writeHead(303, { Location: `/?session=${session}`, ...BASE_HEADERS });
      res.end();
    } catch (error) {
      failure = { step: "register", message: errorText(error) };
      sendPage(res, 502, "Registration needs attention", failure.message);
    } finally {
      busy = false;
    }
  }

  async function handleApi(req, res, url) {
    if (!same(req.headers["x-setup-session"], session)) {
      return sendJson(res, 401, { error: "Missing or invalid setup session. Reopen the link printed by npm run setup." });
    }
    if (url.pathname === "/api/state") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "Use GET." });
      return sendJson(res, 200, await getState());
    }
    const action = url.pathname.slice("/api/".length);
    if (!Object.hasOwn(actions, action)) return sendJson(res, 404, { error: "Unknown setup action." });
    if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
    if (req.headers.origin !== origin) return sendJson(res, 403, { error: "Forbidden origin." });
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) return sendJson(res, 415, { error: "Send application/json." });
    try {
      return sendJson(res, 200, await act(action, await readJson(req)));
    } catch (error) {
      const status = error instanceof SetupError ? error.status : 500;
      const text = error instanceof SetupError ? error.message : GENERIC_ERROR;
      return sendJson(res, status, { error: text, state: snapshot() }, status === 413 ? { Connection: "close" } : {});
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", origin);
    const api = url.pathname.startsWith("/api/");
    const refuse = (status, title, text) => api ? sendJson(res, status, { error: text }) : sendPage(res, status, title, text);
    if (expired) return refuse(410, "Setup expired", "Restart npm run setup.");
    if (req.headers.host !== new URL(origin).host) return refuse(403, "Invalid host", "Open the exact setup URL printed by npm run setup.");
    if (api) return handleApi(req, res, url);
    if (req.method === "GET" && url.pathname === "/") {
      const headers = { "Content-Security-Policy": shellPolicy };
      if (same(url.searchParams.get("session"), session)) headers["Set-Cookie"] = sessionCookie();
      return send(res, 200, files.html, "text/html; charset=utf-8", headers);
    }
    if (req.method === "GET" && url.pathname === "/assets/app.js") return send(res, 200, files.js, "text/javascript; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/assets/app.css") return send(res, 200, files.css, "text/css; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/register") {
      if (!same(url.searchParams.get("session"), session)) return sendPage(res, 403, "Forbidden", "Open the registration link from the setup panel.");
      if (app) return sendPage(res, 409, "Already registered", "This setup already has a registered App.");
      const permissions = Object.entries(APP_PERMISSIONS).map(([name, level]) => `<li><code>${escapeHtml(name)}</code>: ${escapeHtml(level)}</li>`).join("");
      const form = `<form method="post" action="${escapeHtml(registrationAction())}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(registrationManifest(repo, origin)))}"><button type="submit">Continue to GitHub</button></form>`;
      return sendPage(res, 200, "Register the CI/CD Optimizer App", `GitHub will ask you to review and approve a private App owned by ${owner}. It requests no account-wide user permissions:`, {
        forms: true, headers: { "Set-Cookie": sessionCookie() },
        extra: `<ul>${permissions}</ul>${form}<p class="muted">After GitHub redirects back, return to the setup panel.</p>`,
      });
    }
    if (req.method === "GET" && url.pathname === "/registered") return completeRegistration(req, res, url);
    if (req.method === "GET" && url.pathname === "/installed") {
      return sendPage(res, 200, "Installation recorded", "GitHub redirected here after the install step. Nothing has been verified yet. Return to the setup panel and press Verify installation. You can close this tab.");
    }
    return refuse(404, "Not found", "There is nothing at this address.");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error instanceof SetupError ? error.status : 500;
      const text = error instanceof SetupError ? error.message : GENERIC_ERROR;
      if ((req.url ?? "").startsWith("/api/")) sendJson(res, status, { error: text });
      else sendPage(res, status, "Setup needs attention", text);
    });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  origin = `http://127.0.0.1:${port}`;
  cookieName = `optimizer_setup_${port}`;

  const stop = () => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  const shutDown = () => {
    if (app && !stored) console.error("App key was not saved. Generate a replacement in GitHub App settings before using the App.");
    app = undefined;
    expired = true;
    return stop();
  };
  const timer = setTimeout(() => void shutDown(), lifetime);
  timer.unref();

  return {
    url: `${origin}/?session=${session}`, origin, session, getState, act,
    close() {
      clearTimeout(timer);
      return shutDown();
    },
  };
}
