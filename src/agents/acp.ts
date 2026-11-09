import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { agent, methods, PROTOCOL_VERSION, RequestError, type AgentApp, type AgentContext } from "@agentclientprotocol/sdk";
import type { AvailableCommand, ContentBlock, PromptResponse, SessionUpdate, ToolCallLocation } from "@agentclientprotocol/sdk";
import type { ActiveSeverity } from "../lint/types.js";
import { VERSION } from "../version.js";
import { sanitizeMarkdown } from "./remote.js";
import {
  AgentError,
  confine,
  effectiveConfig,
  explainRule,
  fixPreview,
  lintWorkspace,
  listRules,
  resolveRoot,
  type AgentDiagnostic,
  type ContentOverride,
} from "./workspace.js";

/**
 * A deterministic, read-only Agent Client Protocol agent. Editors that speak ACP (Zed, JetBrains, Copilot CLI, …) start
 * `cicd-acp` over stdio; each session analyzes its working directory with slash commands. There is no language model:
 * free text gets the command list. Nothing is written — `/fix-preview` shows diffs that `cicd-lint --fix` would apply.
 */
export const ACP_COMMANDS: AvailableCommand[] = [
  { name: "lint", description: "Lint the workspace, the given paths, or the attached files", input: { hint: "[paths…] [--min warn|error]" } },
  { name: "fix-preview", description: "Preview the safe autofixes as diffs (nothing is written)", input: { hint: "[paths…]" } },
  { name: "explain", description: "Explain a rule: rationale, example, and effective severity", input: { hint: "<rule-id>" } },
  { name: "rules", description: "List the rules, optionally filtered by a search term", input: { hint: "[query]" } },
  { name: "config", description: "Show the effective configuration for this workspace" },
  { name: "help", description: "Show the available commands" },
];

const MAX_LISTED = 50;
const MAX_MESSAGE_CHARS = 30_000;

interface Session {
  root: string;
  notices: string[];
  running?: AbortController;
}

interface Turn {
  client: AgentContext;
  sessionId: string;
  session: Session;
  signal: AbortSignal;
  args: string[];
  paths: string[];
  content: ContentOverride[];
}

export function helpText(): string {
  const lines = ACP_COMMANDS.map((command) => `- \`/${command.name}${command.input ? ` ${command.input.hint}` : ""}\` — ${command.description}`);
  return [
    "**CI/CD Optimizer** analyzes this workspace's workflows, actions, Dockerfiles, and lockfiles. It is deterministic and read-only.",
    "",
    ...lines,
    "",
    "Attach files to lint unsaved content. Apply fixes with `cicd-lint --fix` after reviewing `/fix-preview`.",
  ].join("\n");
}

const send = (client: AgentContext, sessionId: string, update: SessionUpdate) => client.notify(methods.client.session.update, { sessionId, update });

const say = (turn: Pick<Turn, "client" | "sessionId">, text: string) =>
  send(turn.client, turn.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: sanitizeMarkdown(text, MAX_MESSAGE_CHARS).text } });

const code = (value: string) => `\`${value.replace(/`/g, "'")}\``;

function location(root: string, diagnostic: AgentDiagnostic): ToolCallLocation {
  return { path: join(root, ...diagnostic.path.split("/")), line: diagnostic.line };
}

function parsePrompt(blocks: ContentBlock[]): { text: string; links: string[]; embedded: { uri: string; text: string }[]; ignored: number } {
  const text: string[] = [];
  const links: string[] = [];
  const embedded: { uri: string; text: string }[] = [];
  let ignored = 0;
  for (const block of blocks) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "resource_link") links.push(block.uri);
    else if (block.type === "resource" && "text" in block.resource) embedded.push({ uri: block.resource.uri, text: block.resource.text });
    else ignored += 1;
  }
  return { text: text.join("\n").trim(), links, embedded, ignored };
}

async function workspacePath(root: string, uri: string): Promise<string> {
  let value = uri;
  if (/^file:/i.test(uri)) value = fileURLToPath(uri);
  else if (/^[a-z][a-z0-9+.-]+:/i.test(uri) && !/^[a-z]:[\\/]/i.test(uri)) throw new AgentError(`Attachment ${uri} is not a workspace file.`);
  return (await confine(root, value, "Attachment")).path;
}

function minSeverity(args: string[]): { rest: string[]; min?: ActiveSeverity } {
  const rest: string[] = [];
  let min: ActiveSeverity | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const inline = /^--min=(.+)$/.exec(arg);
    const value = inline ? inline[1] : arg === "--min" ? args[(index += 1)] : undefined;
    if (inline || arg === "--min") {
      if (value !== "info" && value !== "warn" && value !== "error") throw new AgentError("--min must be info, warn, or error.");
      min = value;
    } else rest.push(arg);
  }
  return { rest, ...(min ? { min } : {}) };
}

async function lintCommand(turn: Turn): Promise<void> {
  const { rest, min } = minSeverity(turn.args);
  const paths = [...rest, ...turn.paths];
  const toolCallId = `lint-${randomUUID()}`;
  await send(turn.client, turn.sessionId, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: paths.length || turn.content.length ? `Lint ${[...paths, ...turn.content.map((file) => file.path)].join(", ")}` : "Lint workspace",
    kind: "search",
    status: "in_progress",
    rawInput: { paths, content: turn.content.map((file) => file.path), ...(min ? { minSeverity: min } : {}) },
  });
  const summary = await lintWorkspace({
    root: turn.session.root,
    ...(paths.length ? { paths } : {}),
    ...(turn.content.length ? { content: turn.content } : {}),
    ...(min ? { minSeverity: min } : {}),
    limit: MAX_LISTED,
  });
  if (turn.signal.aborted) return;
  await send(turn.client, turn.sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    locations: summary.diagnostics.map((diagnostic) => location(summary.root, diagnostic)),
    rawOutput: { counts: summary.counts, total: summary.total, truncated: summary.truncated, filesAnalyzed: summary.filesAnalyzed },
  });
  const { counts } = summary;
  const lines = [
    `**${counts.error} error(s), ${counts.warn} warning(s), ${counts.info} info** in ${summary.filesAnalyzed} analyzed file(s)` +
      ` (config: ${summary.configPath ? code(summary.configPath) : "defaults"}).`,
  ];
  if (summary.total > 0) lines.push("");
  for (const diagnostic of summary.diagnostics) {
    lines.push(
      `- **${diagnostic.severity}** ${code(`${diagnostic.path}:${diagnostic.line}`)} [${diagnostic.ruleId}](${diagnostic.docsUrl}) — ${diagnostic.message}` +
        (diagnostic.fixable ? " _(autofix available)_" : ""),
    );
  }
  if (summary.truncated) lines.push("", `_Showing ${summary.diagnostics.length} of ${summary.total}, most severe first. Narrow with paths or \`--min warn\`._`);
  for (const problem of summary.parseProblems) lines.push("", `Could not parse ${code(problem.path)}: ${problem.message}`);
  if (summary.unmatched.length) lines.push("", `No analyzed file matched: ${summary.unmatched.map(code).join(", ")}.`);
  if (summary.localRulesIgnored) lines.push("", "The configuration lists `localRules`; this agent never runs repository code, so they were skipped.");
  if (!summary.inventoryComplete) lines.push("", "The workspace exceeded the inventory limits; some files were not analyzed.");
  if (summary.diagnostics.some((diagnostic) => diagnostic.fixable)) lines.push("", "Run `/fix-preview` to see the safe autofixes.");
  await say(turn, lines.join("\n"));
}

async function fixPreviewCommand(turn: Turn): Promise<void> {
  const paths = [...turn.args, ...turn.paths];
  const preview = await fixPreview({
    root: turn.session.root,
    ...(paths.length ? { paths } : {}),
    ...(turn.content.length ? { content: turn.content } : {}),
  });
  if (turn.signal.aborted) return;
  for (const file of preview.files) {
    if (file.omitted || file.newText === undefined) continue;
    const absolute = join(preview.root, ...file.path.split("/"));
    await send(turn.client, turn.sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: `fix-preview-${randomUUID()}`,
      title: `Proposed fix for ${file.path} (preview, not applied)`,
      kind: "other",
      status: "completed",
      content: [{ type: "diff", path: absolute, oldText: file.oldText ?? null, newText: file.newText }],
      locations: [{ path: absolute }],
      rawOutput: { fixes: file.fixes, written: false },
    });
  }
  if (preview.files.length === 0) {
    await say(turn, "No safe autofixes apply to the selected files.");
    return;
  }
  const lines = [`**${preview.applied} fix(es) in ${preview.files.length} file(s)** — previewed only; nothing was written.`, ""];
  for (const file of preview.files) lines.push(`- ${code(file.path)}${file.omitted ? " _(diff omitted: response size limit)_" : ""}: ${file.fixes.join("; ")}`);
  if (preview.conflicts) lines.push("", `${preview.conflicts} overlapping fix(es) apply on a later run.`);
  lines.push("", "Apply them with `cicd-lint --fix` (or `node <plugin>/server/cicd-agents.mjs lint --fix`) after review.");
  await say(turn, lines.join("\n"));
}

async function explainCommand(turn: Turn): Promise<void> {
  const [id] = turn.args;
  if (!id) throw new AgentError("Usage: /explain <rule-id>. List the rules with /rules.");
  const explanation = await explainRule(id, { root: turn.session.root });
  await say(turn, ["```text", explanation.text.trimEnd(), "```", "", `Docs: ${explanation.docsUrl}`].join("\n"));
}

async function rulesCommand(turn: Turn): Promise<void> {
  const query = turn.args.join(" ").trim();
  const rules = listRules(query ? { query } : {});
  const lines = [`**${rules.length} rule(s)**${query ? ` matching ${code(query)}` : ""}:`, ""];
  for (const rule of rules.slice(0, MAX_LISTED * 2)) {
    lines.push(`- ${code(rule.id)} (${rule.defaultSeverity}${rule.fixable ? ", fixable" : ""}) — ${rule.description}`);
  }
  if (rules.length > MAX_LISTED * 2) lines.push("", "_Narrow the list with a search term, for example `/rules cache`._");
  await say(turn, lines.join("\n"));
}

async function configCommand(turn: Turn): Promise<void> {
  const effective = await effectiveConfig({ root: turn.session.root });
  const counts: Record<string, number> = {};
  for (const level of Object.values(effective.rules)) counts[level] = (counts[level] ?? 0) + 1;
  const lines = [
    `**Configuration:** ${effective.configPath ? code(effective.configPath) : "none (defaults)"}`,
    `**Presets:** ${effective.config.extends.map(code).join(", ") || "none"}`,
    `**Fail on:** ${effective.config.failOn}`,
    `**Rules:** ${Object.entries(counts)
      .map(([level, count]) => `${count} ${level}`)
      .join(", ")}`,
  ];
  if (effective.config.ignorePaths.length) lines.push(`**Ignored paths:** ${effective.config.ignorePaths.map(code).join(", ")}`);
  if (effective.localRulesIgnored) lines.push("", "`localRules` are configured but never run by this agent.");
  lines.push("", "Inspect a rule with `/explain <rule-id>`.");
  await say(turn, lines.join("\n"));
}

const HANDLERS: Record<string, (turn: Turn) => Promise<void>> = {
  lint: lintCommand,
  "fix-preview": fixPreviewCommand,
  explain: explainCommand,
  rules: rulesCommand,
  config: configCommand,
};

function parseCommand(text: string, hasAttachments: boolean): { name: string; args: string[] } {
  const [first = ""] = text.split(/\r?\n/);
  const words = first.trim().split(/\s+/).filter(Boolean);
  const head = (words[0] ?? "").replace(/^\//, "").toLowerCase();
  if (head === "" && hasAttachments) return { name: "lint", args: [] };
  if (head in HANDLERS || head === "help") return { name: head, args: words.slice(1) };
  return { name: "help", args: [] };
}

async function runTurn(client: AgentContext, sessionId: string, session: Session, blocks: ContentBlock[], signal: AbortSignal): Promise<PromptResponse> {
  const turnBase = { client, sessionId };
  for (const notice of session.notices.splice(0)) await say(turnBase, `_${notice}_`);
  const prompt = parsePrompt(blocks);
  const command = parseCommand(prompt.text, prompt.links.length + prompt.embedded.length > 0);
  if (command.name === "help") {
    if (prompt.text && !/^\/?help\b/i.test(prompt.text)) await say(turnBase, "This agent runs commands rather than chat. ");
    await say(turnBase, helpText());
    return { stopReason: "end_turn" };
  }
  try {
    const paths = await Promise.all(prompt.links.map((uri) => workspacePath(session.root, uri)));
    const content = await Promise.all(prompt.embedded.map(async (file) => ({ path: await workspacePath(session.root, file.uri), text: file.text })));
    if (prompt.ignored) await say(turnBase, `_Ignored ${prompt.ignored} attachment(s) that are not text files._\n\n`);
    await (HANDLERS[command.name] as (turn: Turn) => Promise<void>)({ ...turnBase, session, signal, args: command.args, paths, content });
  } catch (error) {
    if (!(error instanceof AgentError)) throw error;
    await say(turnBase, `**Error:** ${error.message}`);
  }
  return { stopReason: signal.aborted ? "cancelled" : "end_turn" };
}

/** Builds the ACP agent. Sessions are independent; each is rooted at the client-supplied working directory. */
export function createAcpAgent(): AgentApp {
  const sessions = new Map<string, Session>();
  return agent({ name: "ci-cd-optimizer" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
      authMethods: [],
      agentInfo: { name: "ci-cd-optimizer", title: "CI/CD Optimizer", version: VERSION },
    }))
    .onRequest(methods.agent.session.new, async ({ params, client }) => {
      if (!isAbsolute(params.cwd)) throw RequestError.invalidParams({ cwd: params.cwd }, "cwd must be an absolute path");
      const root = await resolveRoot(params.cwd).catch((error: unknown) => {
        throw RequestError.invalidParams({ cwd: params.cwd }, error instanceof Error ? error.message : String(error));
      });
      const notices: string[] = [];
      if (params.mcpServers.length) {
        notices.push(`This agent does not launch MCP servers; ignored ${params.mcpServers.length} server(s) from the client.`);
      }
      if (params.additionalDirectories?.length) notices.push(`Only ${root} is analyzed; additional directories are ignored.`);
      const sessionId = randomUUID();
      sessions.set(sessionId, { root, notices });
      // Sent after the response so the client knows the session id when it arrives.
      setTimeout(() => {
        void send(client, sessionId, { sessionUpdate: "available_commands_update", availableCommands: ACP_COMMANDS }).catch(() => undefined);
      }, 0);
      return { sessionId };
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client, signal }) => {
      const session = sessions.get(params.sessionId);
      if (!session) throw RequestError.invalidParams({ sessionId: params.sessionId }, "unknown session");
      if (session.running) throw RequestError.invalidRequest({ sessionId: params.sessionId }, "a prompt is already running in this session");
      const running = new AbortController();
      session.running = running;
      const abort = () => running.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        return await runTurn(client, params.sessionId, session, params.prompt, running.signal);
      } finally {
        signal.removeEventListener("abort", abort);
        delete session.running;
      }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.running?.abort();
    });
}
