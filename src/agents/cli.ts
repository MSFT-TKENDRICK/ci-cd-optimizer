import { parseArgs } from "node:util";
import type { GitHubClient } from "../github/client.js";
import { githubReader } from "./github.js";
import { normalizeRepository, type RemoteOptions } from "./remote.js";
import { AgentError, resolveRoot } from "./workspace.js";

export interface AgentIO {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Injected in tests; defaults to a REST client authenticated with GITHUB_TOKEN / GH_TOKEN. */
  github?: (token: string) => GitHubClient;
}

export interface AgentServerOptions {
  /** Fixed workspace from --root. Without it the server uses the client's first file:// root, then `fallbackRoot`. */
  root?: string;
  /** The server's working directory, used when there is no --root and the client offers no roots. */
  fallbackRoot: string;
  /** Where the agent plugin is installed (CICD_OPTIMIZER_PLUGIN_ROOT / PLUGIN_ROOT); never analyzed as the workspace. */
  pluginRoot?: string;
  remote?: RemoteOptions;
  /** Human-readable startup notes for stderr (never stdout, which carries the protocol). */
  notices: string[];
}

export type AgentCommand = { kind: "help"; text: string } | { kind: "version" } | ({ kind: "serve" } & AgentServerOptions);

export const MCP_USAGE = `Usage: cicd-mcp [options]

Read-only MCP server (stdio) for the CI/CD Optimizer linter and reports.

Options:
  --root <dir>        Workspace to analyze. Default: the client's first file:// root
                      (MCP roots), else the current directory.
  --enable-remote     Add the read-only GitHub tools (scan_repository, workflow_run_report).
                      Needs GITHUB_TOKEN or GH_TOKEN.
  --repo <owner/repo> Explicit repository allowlist (required with --enable-remote;
                      repeatable). Other repositories are refused.
  -h, --help          Show this help
  -v, --version       Show the version

Workspace tools also accept an absolute "root" argument, for clients that start the
server outside the workspace without MCP roots (for example Copilot CLI plugins).
It must stay inside --root or the client's roots when those are set.

Docs: https://github.com/MSFT-TKENDRICK/ci-cd-optimizer/blob/main/docs/agents.md
`;

export const ACP_USAGE = `Usage: cicd-acp [options]

Read-only Agent Client Protocol agent (stdio) for the CI/CD Optimizer linter.
Editors start it as an external agent; each session analyzes its absolute cwd.
Commands: /lint [paths] [--min info|warn|error], /fix-preview [paths],
/explain <rule-id>, /rules [query], /config, /help. Attach files to lint them.

Docs: https://github.com/MSFT-TKENDRICK/ci-cd-optimizer/blob/main/docs/agents.md

Options:
  -h, --help     Show this help
  -v, --version  Show the version
`;

/** Remote reads require process opt-in, an explicit allowlist, and a token. Ambient tokens alone do nothing. */
export async function mcpCommand(argv: string[], io: AgentIO): Promise<AgentCommand> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      root: { type: "string" },
      "enable-remote": { type: "boolean" },
      repo: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) return { kind: "help", text: MCP_USAGE };
  if (values.version) return { kind: "version" };
  const root = values.root === undefined ? undefined : await resolveRoot(values.root);
  const pluginRoot = io.env.CICD_OPTIMIZER_PLUGIN_ROOT || io.env.PLUGIN_ROOT || undefined;
  const notices: string[] = [];
  const base: AgentServerOptions = { ...(root ? { root } : {}), fallbackRoot: io.cwd, ...(pluginRoot ? { pluginRoot } : {}), notices };
  if (values.repo?.length && !values["enable-remote"]) throw new AgentError("--repo only applies with --enable-remote.");
  if (!values["enable-remote"]) return { kind: "serve", ...base };

  const allow = [...new Set((values.repo ?? []).map(normalizeRepository))];
  if (!allow.length || allow.length > 100) throw new AgentError("--enable-remote requires 1–100 explicit --repo owner/repo entries.");
  const token = io.env.GITHUB_TOKEN || io.env.GH_TOKEN;
  if (!token) throw new AgentError("--enable-remote requires GITHUB_TOKEN or GH_TOKEN in the server environment.");
  notices.push(`GitHub tools enabled (read-only, dry run) for: ${allow.join(", ")}.`);
  return {
    kind: "serve", ...base,
    remote: {
      allow, repositoryIds: new Map(),
      createClient: (signal) => io.github ? io.github(token) : githubReader(token, { signal, ...(io.env.GITHUB_API_URL ? { baseUrl: io.env.GITHUB_API_URL } : {}) }),
    },
  };
}

export function acpCommand(argv: string[]): AgentCommand | { kind: "serve-acp" } {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: { help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } },
  });
  if (values.help) return { kind: "help", text: ACP_USAGE };
  if (values.version) return { kind: "version" };
  return { kind: "serve-acp" };
}
