// A stand-in MCP Apps host for the setup panel. It runs the real stdio-server factory over an in-memory MCP client, serves the server's real
// ui:// resource into a sandboxed iframe on a different origin, and bridges it with the ext-apps AppBridge, as a chat host does.
// Fake GitHub by default; --real uses your gh login and refuses every state-changing tool unless --allow-actions is given.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { build } from "esbuild";
import { SETUP_RESOURCE_URI, SETUP_TOOLS, createSetupServer } from "../../mcp/setup-server.mjs";
import { fakeRequest, githubCommand, registerInBrowser } from "./helpers.mjs";

const path = (relative) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const MIME = "text/html;profile=mcp-app";
const JSON_TYPE = /^application\/json(?:;|$)/i;
const MAX_BODY = 16 * 1024;
const MAX_VIOLATIONS = 50;
const FIELD_LIMIT = 300;
const FAKE_REPO = "acme/widgets";
const FAKE_APP = "ci-cd-optimizer-acme";
// What the MCP Apps specification says a host enforces on a view that declares no csp, plus a report endpoint to make violations visible.
const VIEW_CSP = [
  "default-src 'none'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "media-src 'self' data:", "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'self'", "report-uri /csp-report",
].join("; ");
// Everything else, including checks that call GitHub, needs --allow-actions against a real account.
const READ_ONLY_TOOLS = new Set([SETUP_TOOLS.open, SETUP_TOOLS.status, SETUP_TOOLS.state]);
const SECURITY_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const clip = (value) => (typeof value === "string" ? value.slice(0, FIELD_LIMIT) : "");
const textOf = (result) => result.content.map((block) => block.text ?? "").join("\n");

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

const sendJson = (res, status, value, headers) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value), headers);

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Send valid JSON.");
  }
}

// A request handler that pins the Host header to its own origin (DNS rebinding) and dispatches "METHOD /path" routes.
function router(origin, routes) {
  const host = new URL(origin).host;
  const known = new Set(Object.keys(routes).map((key) => key.split(" ")[1]));
  return async (req, res) => {
    try {
      if (req.headers.host !== host) throw new HttpError(403, "Forbidden host.");
      const url = new URL(req.url, origin);
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new HttpError(known.has(url.pathname) ? 405 : 404, "Not found.");
      await handler(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      sendJson(res, status, { error: error?.message || "Preview host error." }, status === 413 ? { Connection: "close" } : undefined);
    }
  };
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server.address().port;
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

let hostBundle;
const bundleHost = () => {
  hostBundle ??= build({
    entryPoints: [path("ui/setup/preview/host.ts")], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
  }).then((result) => result.outputFiles[0].text, (error) => {
    hostBundle = undefined;
    throw error;
  });
  return hostBundle;
};

/**
 * @param {object} [options]
 * @param {boolean} [options.real] Use the real gh login and GitHub instead of the fake. Only the default policy changes here; tests may inject fakes.
 * @param {boolean} [options.readOnly] Refuse every tool the panel could use to change state. Defaults to `real`.
 * @param {string} [options.repo] OWNER/REPOSITORY; the fake GitHub only serves acme/widgets.
 * @param {string|null} [options.resumeApp] Slug of an already registered App.
 * @param {boolean} [options.sameOrigin] Serve the view from the host origin so a debugger can reach into it. Isolation does not hold.
 */
export async function startPreviewHost({
  real = false, readOnly = real, repo = FAKE_REPO, resumeApp = null, sameOrigin = false,
  hostPort = 0, viewPort = 0, command, request, lifetime, refreshInterval,
} = {}) {
  if (real && !repo) throw new Error("--real needs --repo OWNER/REPOSITORY.");
  const gh = [];
  const requests = [];
  const { server, closeSessions } = createSetupServer({
    command: command ?? (real ? undefined : githubCommand({ calls: gh })),
    request: request ?? (real ? undefined : fakeRequest({}, requests)),
    lifetime, refreshInterval,
  });
  const client = new Client({ name: "cicd-optimizer-preview-host", version: "1.0.0" }, {
    capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MIME] } } },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);

  const violations = [];
  let hostOrigin = "";
  let viewOrigin = "";

  async function readView() {
    const { contents } = await client.readResource({ uri: SETUP_RESOURCE_URI });
    const [content] = contents;
    if (content?.mimeType !== MIME || typeof content.text !== "string") throw new Error("The server returned no HTML view.");
    return content;
  }

  async function postedJson(req) {
    if (req.headers.origin !== hostOrigin) throw new HttpError(403, "Forbidden origin.");
    if (!JSON_TYPE.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Send JSON.");
    const body = parseJson(await readBody(req));
    if (!isObject(body)) throw new HttpError(400, "Send a JSON object.");
    return body;
  }

  const refusal = (name) => ({
    content: [{ type: "text", text: `The preview host is read-only, so it did not call ${name}. Restart with --allow-actions to let the panel change real state.` }],
    isError: true,
  });

  const hostRoutes = {
    "GET /": async (_req, res) => send(res, 200, "text/html; charset=utf-8", await readFile(path("ui/setup/preview/index.html"), "utf8")),
    "GET /host.js": async (_req, res) => send(res, 200, "text/javascript; charset=utf-8", await bundleHost()),
    "GET /config": async (_req, res) => {
      const { _meta } = await readView();
      sendJson(res, 200, {
        mode: real ? "real" : "fake", repo, resumeApp, readOnly,
        viewUrl: sameOrigin ? `${hostOrigin}/view` : `${viewOrigin}/view`,
        prefersBorder: _meta?.ui?.prefersBorder === true,
      });
    },
    "GET /violations": async (_req, res) => sendJson(res, 200, violations),
    "POST /rpc": async (req, res) => {
      const { method, params } = await postedJson(req);
      if (method === "tools/list") return sendJson(res, 200, { result: await client.listTools() });
      if (method !== "tools/call" || !isObject(params) || typeof params.name !== "string") throw new HttpError(400, "Unsupported request.");
      if (readOnly && !READ_ONLY_TOOLS.has(params.name)) return sendJson(res, 200, { result: refusal(params.name) });
      sendJson(res, 200, { result: await client.callTool({ name: params.name, arguments: isObject(params.arguments) ? params.arguments : {} }) });
    },
    // Stands in for the GitHub manifest round trip. Never reaches github.com, so it exists only against the fake.
    "POST /simulate-register": async (req, res) => {
      const { session } = await postedJson(req);
      if (real) throw new HttpError(409, "Registration is only simulated against the fake GitHub.");
      if (typeof session !== "string") throw new HttpError(400, "Send the panel session.");
      const result = await client.callTool({ name: SETUP_TOOLS.state, arguments: { session } });
      if (result.isError) throw new HttpError(403, textOf(result));
      await registerInBrowser(result.structuredContent.state);
      sendJson(res, 200, { registered: true });
    },
  };

  const viewRoutes = {
    "GET /view": async (_req, res) => send(res, 200, "text/html; charset=utf-8", (await readView()).text, { "Content-Security-Policy": VIEW_CSP }),
    "POST /csp-report": async (req, res) => {
      const parsed = parseJson(await readBody(req));
      const report = isObject(parsed?.["csp-report"]) ? parsed["csp-report"] : parsed;
      if (isObject(report) && violations.length < MAX_VIOLATIONS) {
        violations.push({
          directive: clip(report["effective-directive"] ?? report["violated-directive"]),
          blocked: clip(report["blocked-uri"]),
          document: clip(report["document-uri"]),
          source: clip(report["source-file"]),
        });
      }
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
    },
  };

  let handler;
  let viewHandler;
  const hostServer = createServer((req, res) => handler(req, res));
  const viewServer = sameOrigin ? hostServer : createServer((req, res) => viewHandler(req, res));
  const servers = [...new Set([hostServer, viewServer])];
  try {
    const port = await listen(hostServer, hostPort);
    hostOrigin = `http://127.0.0.1:${port}`;
    if (sameOrigin) {
      viewOrigin = hostOrigin;
      handler = router(hostOrigin, { ...hostRoutes, ...viewRoutes });
    } else {
      viewOrigin = `http://127.0.0.1:${await listen(viewServer, viewPort)}`;
      handler = router(hostOrigin, hostRoutes);
      viewHandler = router(viewOrigin, viewRoutes);
    }
  } catch (error) {
    await Promise.all(servers.map((item) => (item.listening ? stop(item) : undefined)));
    await client.close();
    await closeSessions();
    throw error;
  }

  return {
    hostUrl: `${hostOrigin}/`,
    viewUrl: `${viewOrigin}/view`,
    mode: real ? "real" : "fake",
    readOnly,
    violations,
    calls: { gh, requests },
    client,
    async close() {
      await Promise.all(servers.map(stop));
      await client.close();
      await closeSessions();
    },
  };
}

const HELP = `Usage: node test/setup/preview-host.mjs [options]

Shows the CI/CD Optimizer setup panel in a stand-in MCP Apps host. By default it uses a fake GitHub
(acme/widgets), so nothing leaves this machine.

  --real                  Use your gh login and the real GitHub. Read-only unless --allow-actions is also given.
  --repo OWNER/REPOSITORY Repository to set up (required with --real).
  --resume-app SLUG       Resume an App that is already registered with credentials saved (real).
  --resume                Start from saved credentials on the fake GitHub.
  --allow-actions         Let the panel run real actions (save credentials, dispatch workflows). Real only.
  --same-origin           Serve the view from the host origin so a debugger can reach into it. Isolation does not hold.
  --host-port N           Port for the host page (default: any free port).
  --view-port N           Port for the view (default: any free port).
  -h, --help              Show this help.
`;

function port(value, flag) {
  if (value === undefined) return 0;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65535) throw new Error(`${flag} must be a port from 0 to 65535.`);
  return number;
}

async function main() {
  const { values } = parseArgs({
    options: {
      real: { type: "boolean" }, repo: { type: "string" }, "resume-app": { type: "string" }, resume: { type: "boolean" },
      "allow-actions": { type: "boolean" }, "same-origin": { type: "boolean" }, "host-port": { type: "string" }, "view-port": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP);
  const real = values.real === true;
  if (real && !values.repo) throw new Error("--real needs --repo OWNER/REPOSITORY.");
  if (real && values.resume) throw new Error("--resume is for the fake GitHub; use --resume-app with --real.");
  if (!real && (values["allow-actions"] || values["resume-app"] || values.repo)) throw new Error("--repo, --resume-app and --allow-actions need --real.");

  const host = await startPreviewHost({
    real, readOnly: real && values["allow-actions"] !== true, repo: real ? values.repo : FAKE_REPO,
    resumeApp: real ? (values["resume-app"] ?? null) : (values.resume ? FAKE_APP : null),
    sameOrigin: values["same-origin"] === true,
    hostPort: port(values["host-port"], "--host-port"), viewPort: port(values["view-port"], "--view-port"),
  });
  console.log(`Preview host: ${host.hostUrl}`);
  console.log(`Mode: ${real ? `real GitHub (${host.readOnly ? "read-only" : "ACTIONS ENABLED"})` : "fake GitHub"}`);
  console.log(`View origin: ${host.viewUrl}`);
  if (!host.readOnly && real) console.error("Warning: the panel can now save credentials and dispatch workflows against your real repository.");
  if (values["same-origin"]) console.error("Warning: --same-origin removes the isolation between the host page and the view.");

  const shutDown = () => host.close().then(() => process.exit(0), () => process.exit(1));
  process.once("SIGINT", shutDown);
  process.once("SIGTERM", shutDown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}
