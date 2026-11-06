#!/usr/bin/env node
// Stdio MCP server that renders the CI/CD Optimizer setup ceremony as an MCP App inside Copilot chat.
// It drives the same loopback state machine as `npm run setup`, in-process, so both surfaces share one implementation.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RESOURCE_MIME_TYPE, getUiCapability, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { gh } from "../scripts/setup-app.mjs";
import { SetupError, prepareSetup, startSetup } from "../scripts/setup-session.mjs";

// These names and the URI are a contract with the panel: MCP_TOOLS and MCP_RESOURCE_URI in ui/setup/src/lib/types.ts.
export const SETUP_RESOURCE_URI = "ui://cicd-optimizer/setup.html";
export const SETUP_TOOLS = Object.freeze({
  open: "cicd_optimizer_setup",
  status: "cicd_optimizer_setup_status",
  state: "setup_get_state",
  "save-credentials": "setup_save_credentials",
  verify: "setup_verify",
  "check-verification": "setup_check_verification",
  "run-scan": "setup_run_scan",
});

const DEFAULT_ASSETS = fileURLToPath(new URL("../dist-setup/", import.meta.url));
const REPO = /^[\w.-]+\/[\w.-]+$/;
const SLUG = /^[a-z0-9-]+$/;
const GENERIC_ERROR = "Setup failed. Retry the current step.";
const NOT_AUTHORIZED = "This setup view is not authorized for the active setup. Ask Copilot to run the CI/CD Optimizer setup again.";
const EXPIRED = `Setup expired. Call ${SETUP_TOOLS.open} to start again.`;
const INSTRUCTIONS = [
  `Call ${SETUP_TOOLS.open} to show an interactive panel that registers, installs and verifies the CI/CD Optimizer GitHub App for a repository.`,
  "The panel owns the ceremony: the user presses every button themselves. Never ask for or accept a token, private key or secret in chat,",
  `and never complete a step on the user's behalf. Use ${SETUP_TOOLS.status} to report progress.`,
].join(" ");

// The panel's actions. Authorizing the coding agent is deliberately absent: it needs a secret, which never travels through chat.
const ACTION_TOOLS = [
  ["save-credentials", "Save App credentials", "Save the registered App's private key and ID as repository secrets."],
  ["verify", "Verify installation", "Verify the App installation is limited to the selected repository."],
  ["check-verification", "Check verification", "Refresh the result of a requested verification run."],
  ["run-scan", "Run first scan", "Dispatch the first scan workflow."],
];

const digest = (value) => createHash("sha256").update(value).digest();
const validRepo = (repo) => typeof repo === "string" && REPO.test(repo) && !repo.split("/").some((part) => part === "." || part === "..");
const text = (value) => [{ type: "text", text: value }];
const version = () => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

async function loadView(directory) {
  try {
    // Hosts hash and cache the document, so keep it LF-only like the served shell.
    return (await readFile(join(directory, "mcp.html"), "utf8")).replace(/\r\n/g, "\n");
  } catch {
    throw new Error("Setup UI is not built. Run npm run build:ui.");
  }
}

function progress(state) {
  const done = state.steps.filter((step) => step.status === "complete").length;
  const current = state.steps.find((step) => step.status === "current");
  return current ? `${done} of ${state.steps.length} steps complete; next: ${current.title}.` : `All ${state.steps.length} steps complete.`;
}

// Model-visible text. It never includes snapshot URLs, because those carry the loopback session.
function describe(state) {
  return [
    `CI/CD Optimizer setup for ${state.repo}${state.resumed ? " (resumed from saved credentials)" : ""}: ${progress(state)}`,
    ...state.steps.map((step, index) => `${index + 1}. ${step.title}: ${step.status}`),
    state.installation.status === "unverified" ? "" : `Installation check: ${state.installation.status}.`,
    state.error ? `Last error (${state.error.step}): ${state.error.message}` : "",
    state.message ? `Last result: ${state.message}` : "",
    state.expired ? `This setup has expired. Call ${SETUP_TOOLS.open} to start again.` : `Expires at ${state.expiresAt}.`,
  ].filter(Boolean).join("\n");
}

const failure = (status, message, state) => ({
  isError: true,
  content: text(message),
  structuredContent: state ? { status, state } : { status },
});

export function createSetupServer({
  command = gh, request, assets = DEFAULT_ASSETS, lifetime, refreshInterval, env = process.env,
} = {}) {
  const server = new McpServer({ name: "cicd-optimizer-setup", version: version() }, { instructions: INSTRUCTIONS });
  // One setup at a time. `token` authorizes the panel's tool calls and is never put in model-visible text.
  let active = null;
  let tail = Promise.resolve();

  const exclusive = (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
  const supportsApps = () => getUiCapability(server.server.getClientCapabilities())?.mimeTypes?.includes(RESOURCE_MIME_TYPE) === true;
  const authorized = (given) => active !== null && typeof given === "string" && timingSafeEqual(digest(given), digest(active.token));

  async function closeSessions() {
    const entry = active;
    active = null;
    await entry?.setup.close();
  }

  async function detectRepo() {
    if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
    try {
      return (await command(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
    } catch {
      return "";
    }
  }

  function opened(entry, state) {
    const lines = [`${state.resumed ? "Resumed" : "Started"} CI/CD Optimizer setup for ${state.repo}. ${progress(state)}`];
    lines.push(supportsApps()
      ? "The interactive setup panel is showing in chat. The user completes each step there."
      : `This host cannot show the interactive panel. Ask the user to open ${entry.setup.url} in a browser on this machine to complete setup.`);
    lines.push(`Do not ask for tokens or keys in chat. Call ${SETUP_TOOLS.status} to check progress.`);
    return { content: text(lines.join("\n")), structuredContent: { session: entry.token, state } };
  }

  const open = ({ repo, resumeApp }) => exclusive(async () => {
    const target = repo ?? await detectRepo();
    if (!validRepo(target)) return failure(400, "Pass repo as OWNER/REPOSITORY.");
    const key = `${target}\n${resumeApp ?? ""}`;
    if (active) {
      const current = await active.setup.getState();
      if (!current.expired) {
        if (active.key === key) return opened(active, current);
        // A registered App's private key exists only in this process until it is saved; replacing the session would lose it.
        if (current.app && !current.credentials.saved) {
          return failure(409, `The setup for ${current.repo} holds a registered App key that is not saved yet. Finish saving its credentials first.`);
        }
      }
      await closeSessions();
    }
    try {
      const setup = await startSetup(await prepareSetup({ repo: target, resumeApp }, command), { command, request, assets, lifetime, refreshInterval });
      active = { key, setup, token: randomBytes(32).toString("hex") };
    } catch (error) {
      return failure(error instanceof SetupError ? error.status : 502, error?.message || GENERIC_ERROR);
    }
    return opened(active, await active.setup.getState());
  });

  registerAppTool(server, SETUP_TOOLS.open, {
    title: "Set up CI/CD Optimizer",
    description: "Show an interactive panel that registers, installs and verifies the CI/CD Optimizer GitHub App for a repository, then runs the first scan. "
      + "Pass resumeApp (the App slug) when the App is already registered and its credentials are saved in the repository. "
      + "The user completes every step in the panel; never ask them to paste a token, key or secret into chat.",
    inputSchema: z.object({
      repo: z.string().max(140).regex(REPO, "Use OWNER/REPOSITORY.").optional()
        .describe("OWNER/REPOSITORY to set up. Defaults to GITHUB_REPOSITORY, then the repository of the current directory."),
      resumeApp: z.string().max(100).regex(SLUG, "Use the App slug, for example ci-cd-optimizer-owner.").optional()
        .describe("Slug of an App that is already registered with its credentials saved in this repository."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: SETUP_RESOURCE_URI } },
  }, open);

  server.registerTool(SETUP_TOOLS.status, {
    title: "CI/CD Optimizer setup status",
    description: "Report which setup steps are complete. Read-only; never returns links, keys or tokens.",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const ui = `This host ${supportsApps() ? "advertises" : "does not advertise"} MCP Apps support.`;
    if (!active) return { content: text(`No setup is in progress. Call ${SETUP_TOOLS.open} to start one. ${ui}`) };
    return { content: text(`${describe(await active.setup.getState())}\n${ui}`) };
  });

  const appOnly = { ui: { resourceUri: SETUP_RESOURCE_URI, visibility: ["app"] } };
  const session = z.string().min(1).max(200);

  // Callers must already have passed the token check.
  async function respond(entry, run) {
    try {
      const state = await run(entry.setup);
      return { content: text(state.message || progress(state)), structuredContent: { state } };
    } catch (error) {
      const status = error instanceof SetupError ? error.status : 500;
      // The session's own expiry text points at the CLI; chat users restart from the tool instead.
      const message = status === 410 ? EXPIRED : error instanceof SetupError ? error.message : GENERIC_ERROR;
      return failure(status, message, await entry.setup.getState());
    }
  }

  registerAppTool(server, SETUP_TOOLS.state, {
    title: "Read setup state",
    description: "Return the current setup snapshot for the panel.",
    inputSchema: z.object({ session }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    _meta: appOnly,
  }, async (args) => (authorized(args.session) ? respond(active, (setup) => setup.getState()) : failure(401, NOT_AUTHORIZED)));

  for (const [action, title, description] of ACTION_TOOLS) {
    registerAppTool(server, SETUP_TOOLS[action], {
      title,
      description: `${description} Panel only; requires the panel's session and an explicit confirmation.`,
      inputSchema: z.object({ session, confirm: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: appOnly,
    }, async (args) => (authorized(args.session) ? respond(active, (setup) => setup.act(action, { confirm: args.confirm })) : failure(401, NOT_AUTHORIZED)));
  }

  registerAppResource(server, "CI/CD Optimizer setup", SETUP_RESOURCE_URI, {
    description: "Guided GitHub App registration, installation and verification.",
  }, async () => ({
    // The panel draws its own card, so ask the host not to frame it a second time.
    contents: [{ uri: SETUP_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: await loadView(assets), _meta: { ui: { prefersBorder: false } } }],
  }));

  return { server, closeSessions };
}

async function main() {
  // Stdout carries the protocol; a stray console.log from any dependency would corrupt it.
  console.log = console.error;
  const { server, closeSessions } = createSetupServer();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // The loopback listener would otherwise keep the process alive after the host disconnects.
    closeSessions().catch(() => {}).finally(() => setTimeout(() => process.exit(0), 200).unref());
  };
  server.server.onclose = stop;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      stop();
      server.close().catch(() => {});
    });
  }
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}
