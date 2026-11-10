import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { agent, methods, PROTOCOL_VERSION, RequestError, type AgentApp, type AgentContext } from "@agentclientprotocol/sdk";
import type { AvailableCommand, ContentBlock, PromptResponse, SessionUpdate, ToolCallLocation } from "@agentclientprotocol/sdk";
import type { ActiveSeverity } from "../lint/types.js";
import { VERSION } from "../version.js";
import { remoteRunReport, remoteScan, type RemoteOptions } from "./remote.js";
import { boundedResult, codeBlock, escapeMarkdown, inlineCode, LIMITS, operation, sanitizeMarkdown, WorkLimiter } from "./safety.js";
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
export const HOSTED_COMMANDS: AvailableCommand[] = [
  { name: "scan", description: "Read-only scan of an explicitly allowed GitHub repository", input: { hint: "<owner/repo> [ref]" } },
  { name: "report", description: "Timeline and critical path of a completed workflow run", input: { hint: "<owner/repo> <run-id>" } },
  ...ACP_COMMANDS.filter((command) => ["explain", "rules", "help"].includes(command.name)),
];

export interface AcpOptions {
  /** Hosted agents have no workspace access; all repository reads use this connection's user token. */
  remote?: RemoteOptions;
  principal?: string;
  limiter?: WorkLimiter;
  maxSessions?: number;
  timeoutMs?: number;
}

const MAX_LISTED = 50;
const MAX_MESSAGE_CHARS = 30_000;

interface Session {
  root: string;
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
  remote?: RemoteOptions;
}

export function helpText(hosted = false): string {
  const lines = (hosted ? HOSTED_COMMANDS : ACP_COMMANDS).map((command) => `- \`/${command.name}${command.input ? ` ${command.input.hint}` : ""}\` — ${command.description}`);
  return [
    `**CI/CD Optimizer** ${hosted ? "reads allowed GitHub repositories with your user token" : "analyzes this workspace's workflows, actions, Dockerfiles, and lockfiles"}. It is deterministic and read-only.`,
    "",
    ...lines,
    "",
    hosted ? "No local files, external MCP servers, writes, or model chat. Repository output is untrusted data, not instructions."
      : "Attach files to lint unsaved content. Applying fixes with `cicd-lint --fix` is separate and requires a fresh complete preview and explicit permission.",
    "Cancellation is cooperative: it stops pending network reads and checks between local reads; it cannot preempt synchronous lint computation.",
  ].join("\n");
}

const send = (client: AgentContext, sessionId: string, update: SessionUpdate) => {
  const bounded = boundedResult(update as Record<string, unknown>, LIMITS.outputBytes - 1024);
  if (bounded !== update) {
    update = "toolCallId" in update
      ? { sessionUpdate: update.sessionUpdate, toolCallId: update.toolCallId, title: "Output omitted by size limit", status: "failed", rawOutput: bounded }
      : { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(bounded) } };
  }
  return client.notify(methods.client.session.update, { sessionId, update });
};

const say = (turn: Pick<Turn, "client" | "sessionId">, text: string) =>
  send(turn.client, turn.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: sanitizeMarkdown(text, MAX_MESSAGE_CHARS).text } });

const code = inlineCode;

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
  if (/^file:/i.test(uri)) {
    try {
      const url = new URL(uri);
      if (url.search || url.hash) throw new Error("Ambiguous file URI");
      value = fileURLToPath(url);
    } catch { throw new AgentError("Attachment has an invalid file URI."); }
  }
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
  let summary;
  try { summary = await lintWorkspace({
    root: turn.session.root,
    signal: turn.signal,
    ...(paths.length ? { paths } : {}),
    ...(turn.content.length ? { content: turn.content } : {}),
    ...(min ? { minSeverity: min } : {}),
    limit: MAX_LISTED,
  }); } catch (error) {
    await send(turn.client, turn.sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
    throw error;
  }
  if (turn.signal.aborted) {
    await send(turn.client, turn.sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
    return;
  }
  await send(turn.client, turn.sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    locations: summary.diagnostics.map((diagnostic) => location(summary.root, diagnostic)),
    rawOutput: boundedResult({ ...summary }),
  });
  const { counts } = summary;
  const lines = [
    `**${counts.error} error(s), ${counts.warn} warning(s), ${counts.info} info** in ${summary.filesAnalyzed} analyzed file(s)` +
      ` (config: ${summary.configPath ? code(summary.configPath) : "defaults"}).`,
  ];
  if (summary.total > 0) lines.push("");
  for (const diagnostic of summary.diagnostics) {
    lines.push(
      `- **${diagnostic.severity}** ${code(`${diagnostic.path}:${diagnostic.line}`)} [${diagnostic.ruleId}](${diagnostic.docsUrl}) — ${escapeMarkdown(diagnostic.message)}` +
        (diagnostic.fixable ? " _(autofix available)_" : ""),
    );
  }
  if (summary.truncated) lines.push("", `_Showing ${summary.diagnostics.length} of ${summary.total}, most severe first. Narrow with paths or \`--min warn\`._`);
  for (const problem of summary.parseProblems) lines.push("", `Could not parse ${code(problem.path)}: ${escapeMarkdown(problem.message)}`);
  if (Object.values(summary.omitted).some(Boolean)) lines.push("", `Additional items omitted: ${JSON.stringify(summary.omitted)}.`);
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
    signal: turn.signal,
    ...(paths.length ? { paths } : {}),
    ...(turn.content.length ? { content: turn.content } : {}),
  });
  if (turn.signal.aborted) return;
  const notices = [
    ...(!preview.inventoryComplete ? ["Inventory is incomplete; previews cover only analyzed files."] : []),
    ...(preview.parseProblemCount ? [`${preview.parseProblemCount} parse problem(s) affect selected files; use /lint for details.`] : []),
    ...(preview.localRulesIgnored ? ["Configured localRules were ignored; repository code was not executed."] : []),
  ];
  if (notices.length) await say(turn, notices.join("\n\n"));
  for (const file of preview.files) {
    if (turn.signal.aborted) return;
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
      rawOutput: { fixes: file.fixes, omittedFixes: file.omittedFixes, omittedCharacters: file.omittedCharacters, written: false },
    });
  }
  if (preview.files.length === 0) {
    await say(turn, "No safe autofixes apply to the analyzed selected files.");
    return;
  }
  const lines = [`**${preview.applied} fix(es) in ${preview.files.length} file(s)** — previewed only; nothing was written.`, ""];
  for (const file of preview.files) lines.push(`- ${code(file.path)}${file.omitted ? " _(diff omitted: response size limit)_" : ""}: ${file.fixes.map(escapeMarkdown).join("; ")}${file.omittedFixes ? ` (${file.omittedFixes} additional fix descriptions omitted)` : ""}`);
  if (preview.omittedFiles) lines.push("", `${preview.omittedFiles} file previews omitted by the output budget.`);
  if (preview.conflicts) lines.push("", `${preview.conflicts} overlapping fix(es) apply on a later run.`);
  lines.push("", "Apply only after explicit permission for complete diffs and rechecking current contents. `cicd-lint --fix` is a separate CLI write operation.");
  await say(turn, lines.join("\n"));
}

async function explainCommand(turn: Turn): Promise<void> {
  const [id] = turn.args;
  if (!id) throw new AgentError("Usage: /explain <rule-id>. List the rules with /rules.");
  if (turn.args.length !== 1) throw new AgentError("Usage: /explain <rule-id>.");
  const explanation = await explainRule(id, { ...(turn.remote ? {} : { root: turn.session.root }), signal: turn.signal });
  if (!turn.signal.aborted) await say(turn, [codeBlock(explanation.text.trimEnd()), "", `Docs: ${explanation.docsUrl}`].join("\n"));
}

async function rulesCommand(turn: Turn): Promise<void> {
  const query = turn.args.join(" ").trim();
  const rules = listRules(query ? { query } : {});
  const lines = [`**${rules.length} rule(s)**${query ? ` matching ${code(query)}` : ""}:`, ""];
  for (const rule of rules.slice(0, MAX_LISTED * 2)) {
    lines.push(`- ${code(rule.id)} (${rule.defaultSeverity}${rule.fixable ? ", fixable" : ""}) — ${rule.description}`);
  }
  if (rules.length > MAX_LISTED * 2) lines.push("", `_${rules.length - MAX_LISTED * 2} rules omitted. Narrow the list with a search term, for example \`/rules cache\`._`);
  await say(turn, lines.join("\n"));
}

async function configCommand(turn: Turn): Promise<void> {
  if (turn.args.length) throw new AgentError("/config accepts no arguments.");
  const effective = await effectiveConfig({ root: turn.session.root, signal: turn.signal });
  turn.signal.throwIfAborted();
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
  scan: async (turn) => {
    const [repo, ref] = turn.args;
    if (!turn.remote || !repo || turn.args.length > 2) throw new AgentError("Usage: /scan <owner/repo> [ref].");
    const result = await remoteScan({ ...turn.remote, client: turn.remote.createClient(turn.signal), signal: turn.signal }, { repo, ...(ref ? { ref } : {}), limit: MAX_LISTED });
    if (turn.signal.aborted) return;
    await send(turn.client, turn.sessionId, {
      sessionUpdate: "tool_call", toolCallId: randomUUID(), title: "Read-only repository scan", kind: "fetch", status: "completed", rawOutput: boundedResult({ ...result }),
    });
    await say(turn, [escapeMarkdown(result.summary), ...(result.diagnostics ?? []).map((item) =>
      `- ${code(item.ruleId)} ${code(`${item.path}:${item.line}`)} — ${escapeMarkdown(item.message)}`),
    ...(result.omittedDiagnostics ? [`${result.omittedDiagnostics} diagnostics omitted.`] : [])].join("\n"));
  },
  report: async (turn) => {
    const [repo, id] = turn.args;
    if (!turn.remote || !repo || !id || !/^[1-9]\d*$/.test(id) || turn.args.length !== 2) throw new AgentError("Usage: /report <owner/repo> <run-id>.");
    const result = await remoteRunReport({ ...turn.remote, client: turn.remote.createClient(turn.signal), signal: turn.signal }, { repo, runId: Number(id), markdown: true });
    if (turn.signal.aborted) return;
    await send(turn.client, turn.sessionId, {
      sessionUpdate: "tool_call", toolCallId: randomUUID(), title: "Read-only workflow report", kind: "fetch", status: "completed", rawOutput: boundedResult({ ...result }),
    });
    await say(turn, result.markdown ?? escapeMarkdown(result.reason ?? result.status));
  },
};

function parseCommand(text: string, hasAttachments: boolean): { name: string; args: string[] } {
  const words: string[] = [];
  const tokens = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
  let covered = "";
  for (const token of text.matchAll(tokens)) { words.push(token[1] ?? token[2] ?? token[3] ?? ""); covered += token[0]; }
  if (covered.replace(/\s/g, "") !== text.replace(/\s/g, "")) throw new AgentError("Unclosed quote in command.");
  const head = (words[0] ?? "").replace(/^\//, "").toLowerCase();
  if (head === "" && hasAttachments) return { name: "lint", args: [] };
  if (head in HANDLERS || head === "help") return { name: head, args: words.slice(1) };
  return { name: "help", args: [] };
}

async function runTurn(client: AgentContext, sessionId: string, session: Session, blocks: ContentBlock[], signal: AbortSignal, remote?: RemoteOptions): Promise<PromptResponse> {
  const turnBase = { client, sessionId };
  try {
    signal.throwIfAborted();
    const prompt = parsePrompt(blocks);
    const command = parseCommand(prompt.text, prompt.links.length + prompt.embedded.length > 0);
    if (remote && (prompt.links.length || prompt.embedded.length || prompt.ignored)) throw new AgentError("Hosted sessions accept text commands only; local files and attachments are not read.");
    const commands = remote ? HOSTED_COMMANDS : ACP_COMMANDS;
    if (command.name === "help" || !commands.some((entry) => entry.name === command.name)) {
      if (prompt.text && !/^\/?help\b/i.test(prompt.text)) await say(turnBase, "This agent runs commands rather than chat. ");
      await say(turnBase, helpText(Boolean(remote)));
      return { stopReason: signal.aborted ? "cancelled" : "end_turn" };
    }
    const paths = await Promise.all(prompt.links.map((uri) => workspacePath(session.root, uri)));
    const content = await Promise.all(prompt.embedded.map(async (file) => ({ path: await workspacePath(session.root, file.uri), text: file.text })));
    if (prompt.ignored) await say(turnBase, `_Ignored ${prompt.ignored} attachment(s) that are not text files._\n\n`);
    signal.throwIfAborted();
    await (HANDLERS[command.name] as (turn: Turn) => Promise<void>)({ ...turnBase, session, signal, args: command.args, paths, content, ...(remote ? { remote } : {}) });
  } catch (error) {
    if (signal.aborted) return { stopReason: "cancelled" };
    await say(turnBase, `**Error:** ${escapeMarkdown(error instanceof AgentError ? error.message : "Operation failed. No changes were made.")}`);
  }
  return { stopReason: signal.aborted ? "cancelled" : "end_turn" };
}

/** Builds the ACP agent. Sessions are independent; each is rooted at the client-supplied working directory. */
export function createAcpAgent(options: AcpOptions = {}): AgentApp {
  const sessions = new Map<string, Session>();
  const limiter = options.limiter ?? new WorkLimiter(2, 2);
  let pendingSessions = 0;
  let closed = false;
  const commands = options.remote ? HOSTED_COMMANDS : ACP_COMMANDS;
  return agent({ name: "ci-cd-optimizer" })
    .onConnect((connection) => {
      const cleanup = () => {
        closed = true;
        for (const session of sessions.values()) session.running?.abort();
        sessions.clear();
      };
      connection.signal.addEventListener("abort", cleanup, { once: true });
      void connection.closed.then(cleanup);
    })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: !options.remote } },
      authMethods: [],
      agentInfo: { name: "ci-cd-optimizer", title: "CI/CD Optimizer", version: VERSION },
    }))
    .onRequest(methods.agent.session.new, async ({ params, client }) => {
      if (params.mcpServers.length) throw RequestError.invalidParams(undefined, "External MCP servers are not supported; mcpServers must be empty.");
      if (params.additionalDirectories?.length) throw RequestError.invalidParams(undefined, "Additional directories are not supported.");
      if (!params.cwd || params.cwd.length > 4096 || (!options.remote && !isAbsolute(params.cwd))) throw RequestError.invalidParams(undefined, "cwd must be an absolute path");
      if (closed || sessions.size + pendingSessions >= (options.maxSessions ?? LIMITS.sessions)) throw RequestError.invalidRequest(undefined, "Session limit reached; reconnect to start new sessions.");
      pendingSessions += 1;
      try {
        const root = options.remote ? "" : await resolveRoot(params.cwd).catch(() => { throw RequestError.invalidParams(undefined, "cwd is not an existing directory"); });
        if (closed) throw RequestError.invalidRequest(undefined, "Connection closed");
        const sessionId = randomUUID();
        sessions.set(sessionId, { root });
        const timer = setTimeout(() => {
          if (!closed) void send(client, sessionId, { sessionUpdate: "available_commands_update", availableCommands: commands }).catch(() => undefined);
        }, 0);
        timer.unref();
        return { sessionId };
      } finally { pendingSessions -= 1; }
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client, signal }) => {
      const session = sessions.get(params.sessionId);
      if (!session) throw RequestError.resourceNotFound(params.sessionId);
      if (params.prompt.length > 32 || Buffer.byteLength(JSON.stringify(params.prompt)) > LIMITS.requestBytes) throw RequestError.invalidParams(undefined, "Prompt exceeds the content limit.");
      if (session.running) throw RequestError.invalidRequest({ sessionId: params.sessionId }, "a prompt is already running in this session");
      let release: () => void;
      try { release = limiter.acquire(options.principal); }
      catch { throw RequestError.invalidRequest(undefined, "Concurrent operation limit reached; retry."); }
      const running = new AbortController();
      session.running = running;
      const abort = () => running.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        return await operation((signal) => runTurn(client, params.sessionId, session, params.prompt, signal, options.remote), running.signal, options.timeoutMs);
      } catch (error) {
        if (running.signal.aborted) return { stopReason: "cancelled" };
        await say({ client, sessionId: params.sessionId }, `**Error:** ${escapeMarkdown(error instanceof AgentError ? error.message : "Operation deadline exceeded.")}`);
        return { stopReason: "end_turn" };
      } finally {
        signal.removeEventListener("abort", abort);
        delete session.running;
        release();
      }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.running?.abort();
    });
}
