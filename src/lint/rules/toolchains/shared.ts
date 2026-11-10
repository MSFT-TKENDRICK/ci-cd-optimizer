import { isMap, isPair, isScalar, isSeq, type Node } from "yaml";
import { insertLinesAfter, lineStart, lineText } from "../../fix.js";
import type { JobModel, WorkflowModel } from "../../parsers/workflow.js";
import { lineOfNode } from "../../parsers/yaml.js";
import { commandTokens, shellTokens } from "../../parsers/shell.js";
import type { ProjectModel } from "../../project.js";
import type { SourceFile, TextEdit } from "../../types.js";
import { basename, commandWords } from "../caching/shared.js";
import { commandsOf, expandedJobSteps, type ExpandedStep, type JobCommand } from "../helpers.js";

/** A job (or a composite action no workflow job expands) with its expanded steps and commands. */
export interface JobContext {
  workflow: WorkflowModel;
  job: JobModel;
  entries: ExpandedStep[];
  commands: JobCommand[];
}

function context(project: ProjectModel, workflow: WorkflowModel, job: JobModel): JobContext {
  const entries = expandedJobSteps(project, workflow, job);
  const commands = entries.flatMap((entry) =>
    commandsOf(entry.step).map(({ command, line }) => ({ ...entry, command, line })),
  );
  return { workflow, job, entries, commands };
}

/** Every workflow job, plus composite actions that no workflow job expands (their steps are checked on their own). */
export function jobContexts(project: ProjectModel): JobContext[] {
  const result: JobContext[] = [];
  const covered = new Set<string>();
  for (const workflow of project.workflows) {
    for (const job of workflow.jobs) {
      const ctx = context(project, workflow, job);
      for (const entry of ctx.entries) if (!entry.direct) covered.add(entry.path);
      result.push(ctx);
    }
  }
  for (const action of project.actions) {
    if (action.kind !== "composite-action" || covered.has(action.path)) continue;
    for (const job of action.jobs) {
      const ctx = context(project, action, job);
      for (const entry of ctx.entries) if (!entry.direct) covered.add(entry.path);
      result.push(ctx);
    }
  }
  return result;
}

/** Quote-aware words of the first program; shell expansion is deliberately not evaluated. */
export function words(command: string): string[] {
  return commandWords(command);
}

/** Leading `VAR=value` assignments of a command. */
export function inlineEnv(command: string): Map<string, string> {
  const result = new Map<string, string>();
  let envWrapper = false;
  for (const { value: word } of shellTokens(command)) {
    if (!envWrapper && basename(word) === "env") {
      envWrapper = true;
      continue;
    }
    if (envWrapper && word === "--") continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(word);
    if (!match) break;
    result.set(match[1] ?? "", (match[2] ?? "").replace(/^(["'])(.*)\1$/, "$2"));
  }
  return result;
}

function conditionalScript(script: string): boolean {
  return /\|\||(?:^|[\n;])\s*(?:if|then|elif|else|case|for|while|until)\b/.test(script);
}

/** Prefix/environment effects requiring shell or external configuration evaluation. */
export function unknownCommandEnvironment(ctx: JobContext, command: JobCommand): boolean {
  const parsed = commandTokens(command.command);
  const first = parsed[0];
  if (!first) return true;
  if (parsed.some((token) => /[$`]/.test(token.value) && !/^'[^']*'$/.test(token.raw))) return true;
  const all = shellTokens(command.command);
  const prefix = all.slice(0, all.length - commandTokens(command.command).length);
  if (prefix.some((token) => ["sudo", "doas", "su"].includes(basename(token.value)))) return true;
  if (prefix.some((token) => basename(token.value) === "env") &&
      prefix.some((token) => token.value.startsWith("-") && token.value !== "--")) return true;
  const before = ctx.commands.slice(0, ctx.commands.indexOf(command))
    .filter((other) => other.step === command.step && other.owner === command.owner);
  if (ctx.commands.some((other) => entryIndex(ctx, other) < entryIndex(ctx, command) &&
      /\$(?:GITHUB_ENV|\{GITHUB_ENV\})/.test(other.command) && githubEnvPairs(other.command).size === 0)) return true;
  return before.some((other) => /^(?:source|\.|eval|unset)\s/.test(other.command) ||
      shellTokens(other.command).length === 0 ||
      (shellTokens(other.command).length > 0 && commandTokens(other.command).length === 0)) ||
    (before.length > 0 && conditionalScript(command.step.run?.value ?? ""));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

/** `NAME=value` pairs one command appends to `$GITHUB_ENV` (empty when it does not write that file). */
export function githubEnvPairs(command: string): Map<string, string> {
  const result = new Map<string, string>();
  const tokens = shellTokens(command);
  let end = 0;
  for (const token of tokens) {
    const start = command.indexOf(token.raw, end);
    if (start < 0) return result;
    end = start + token.raw.length;
  }
  if (!/^>>?\s*(?:"\$(?:GITHUB_ENV|\{GITHUB_ENV\})"|\$(?:GITHUB_ENV|\{GITHUB_ENV\}))\s*$/.test(command.slice(end).trim())) return result;
  const verb = tokens[0]?.value;
  const payload = verb === "echo" ? tokens.slice(1) : verb === "printf" && tokens[1]?.value === "%s\\n" ? tokens.slice(2) : [];
  if (payload.length !== 1) return result;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=([^\n\r]*)$/.exec(payload[0]?.value ?? "");
  if (match) {
    result.set(match[1] ?? "", match[2] ?? "");
  }
  return result;
}

/** Position of a step in the job's expanded step list (-1 when absent). */
export function entryIndex(ctx: JobContext, entry: ExpandedStep): number {
  return ctx.entries.findIndex((other) => other.step === entry.step && other.owner === entry.owner);
}

/**
 * Variables written to `$GITHUB_ENV` by the steps that run before `before` (every step when omitted). The runner applies
 * these writes once the writing step finishes, so they never affect the writing step itself.
 */
export function githubEnvWrites(ctx: JobContext, before?: ExpandedStep): Map<string, string> {
  const result = new Map<string, string>();
  const stop = before === undefined ? Number.POSITIVE_INFINITY : entryIndex(ctx, before);
  for (const command of ctx.commands) {
    if (entryIndex(ctx, command) >= stop) break;
    for (const [key, value] of githubEnvPairs(command.command)) {
      result.set(key, command.step.if || command.owner.if || conditionalScript(command.step.run?.value ?? "") ? "${unknown}" : value);
    }
  }
  return result;
}

/** `export VAR=value` statements of the step script that runs `command`, before it. */
function exportsBefore(ctx: JobContext, command: JobCommand): Map<string, string> {
  const result = new Map<string, string>();
  for (const other of ctx.commands) {
    if (other === command) break;
    if (other.step !== command.step || other.owner !== command.owner) continue;
    const tokens = shellTokens(other.command);
    if (tokens[0]?.value !== "export") continue;
    for (const token of tokens.slice(1)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(token.value);
      if (match) result.set(match[1] ?? "", match[2] ?? "");
    }
  }
  return result;
}

/**
 * Best-effort environment of a step (and, when given, one of its commands), in the runner's precedence order: workflow
 * and job `env:`, then `$GITHUB_ENV` writes of earlier steps (they overwrite the job-level values), then the calling
 * step's and the step's own `env:`, earlier `export`s and the command's inline assignments. Values are strings;
 * expressions are kept verbatim.
 */
export function effectiveEnv(ctx: JobContext, entry: ExpandedStep, command?: JobCommand): Map<string, string> {
  const env = new Map<string, string>();
  for (const scope of [ctx.workflow.env, ctx.job.env]) {
    for (const [key, value] of Object.entries(scope)) env.set(key, stringValue(value));
  }
  for (const [key, value] of githubEnvWrites(ctx, entry)) env.set(key, value);
  for (const scope of [...(entry.direct ? [] : [entry.owner.env]), entry.step.env]) {
    for (const [key, value] of Object.entries(scope)) env.set(key, stringValue(value));
  }
  if (command) {
    for (const [key, value] of exportsBefore(ctx, command)) env.set(key, value);
    for (const [key, value] of inlineEnv(command.command)) env.set(key, value);
  }
  return env;
}

function child(node: unknown, key: string): unknown {
  if (!isMap(node)) return undefined;
  const pair = node.items.find((item) => isPair(item) && isScalar(item.key) && String(item.key.value) === key);
  return pair?.value;
}

function keyLine(workflow: WorkflowModel, map: unknown, key: string): number | undefined {
  if (!isMap(map)) return undefined;
  const pair = map.items.find((item) => isPair(item) && isScalar(item.key) && String(item.key.value) === key);
  return pair ? lineOfNode(workflow.source, pair.key as Node) : undefined;
}

export type EnvScope = { kind: "workflow" } | { kind: "job"; job: JobModel } | { kind: "step"; key: string };

/** Line of `key` inside the `env:` mapping of a workflow, job or step (undefined when it cannot be located). */
export function envKeyLine(workflow: WorkflowModel, scope: EnvScope, key: string): number | undefined {
  const root = workflow.source.doc.contents;
  if (scope.kind === "workflow") return keyLine(workflow, child(root, "env"), key);
  if (scope.kind === "job") return keyLine(workflow, child(child(child(root, "jobs"), scope.job.id), "env"), key);
  const match = /^(?:jobs\.([^.]+)\.steps|runs\.steps)\[(\d+)\]$/.exec(scope.key);
  if (!match) return undefined;
  const parent = match[1] !== undefined ? child(child(root, "jobs"), match[1]) : child(root, "runs");
  const stepsNode = child(parent, "steps");
  if (!isSeq(stepsNode)) return undefined;
  return keyLine(workflow, child(stepsNode.items[Number(match[2])], "env"), key);
}

export interface EnvSource {
  value: string;
  path: string;
  /** Line that sets the effective value (undefined when it cannot be located). */
  line: number | undefined;
  /** A YAML `env:` key, or a shell assignment (inline, `export` or a `$GITHUB_ENV` write). */
  origin: "yaml" | "shell";
}

/** `effectiveEnv` for a single variable, with the location that sets the value the command sees. */
export function envSource(project: ProjectModel, ctx: JobContext, command: JobCommand, name: string): EnvSource | undefined {
  let result: EnvSource | undefined;
  const yaml = (values: Record<string, unknown>, model: WorkflowModel | undefined, scope: EnvScope, path: string): void => {
    if (!(name in values)) return;
    const line = model === undefined ? undefined : envKeyLine(model, scope, name);
    result = { value: stringValue(values[name]).trim(), path, line, origin: "yaml" };
  };
  yaml(ctx.workflow.env, ctx.workflow, { kind: "workflow" }, ctx.workflow.path);
  yaml(ctx.job.env, ctx.workflow, { kind: "job", job: ctx.job }, ctx.workflow.path);
  const stop = entryIndex(ctx, command);
  for (const other of ctx.commands) {
    if (entryIndex(ctx, other) >= stop) break;
    const value = githubEnvPairs(other.command).get(name);
    if (value !== undefined) result = {
      value: other.step.if || other.owner.if || conditionalScript(other.step.run?.value ?? "") ? "${unknown}" : value,
      path: other.path, line: other.line, origin: "shell",
    };
  }
  if (!command.direct) yaml(command.owner.env, ctx.workflow, { kind: "step", key: command.owner.key }, ctx.workflow.path);
  const model = command.direct ? ctx.workflow : project.actions.find((action) => action.path === command.path);
  yaml(command.step.env, model, { kind: "step", key: command.step.key }, command.path);
  const exported = exportsBefore(ctx, command);
  if (exported.has(name)) {
    const line = [...ctx.commands]
      .reverse()
      .find((other) => other.step === command.step && other.owner === command.owner && other.line <= command.line &&
        shellTokens(other.command)[0]?.value === "export" &&
        shellTokens(other.command).some((token) => token.value.startsWith(`${name}=`)))?.line;
    result = { value: exported.get(name) ?? "", path: command.path, line, origin: "shell" };
  }
  const inline = inlineEnv(command.command).get(name);
  if (inline !== undefined) result = { value: inline, path: command.path, line: command.line, origin: "shell" };
  return result;
}

/** Joins a repository-relative directory ("" = root) with a relative path. Undefined for absolute or escaping paths. */
export function joinPath(dir: string, path: string): string | undefined {
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path)) return undefined;
  const parts = dir === "" ? [] : dir.split("/");
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/");
}

export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function inDir(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** Normalises a literal `working-directory`; undefined when it depends on expressions, variables or absolute paths. */
function normaliseDirectory(value: string): string | undefined {
  const stripped = value.trim().replace(/^\$\{\{\s*github\.workspace\s*\}\}\/?/, "").replace(/^\$GITHUB_WORKSPACE\/?/, "");
  if (stripped.includes("$") || stripped.includes("`")) return undefined;
  return joinPath("", stripped);
}

/**
 * Repository-relative directory a command runs in ("" = root), following `working-directory` defaults and earlier
 * literal `cd`/`pushd` in the same step. Undefined when it cannot be determined statically.
 */
export function commandDirectory(ctx: JobContext, command: JobCommand): string | undefined {
  const configured =
    command.step.workingDirectory ??
    (command.direct ? (ctx.job.workingDirectory ?? ctx.workflow.workingDirectory) : undefined);
  let dir: string | undefined = configured === undefined ? "" : normaliseDirectory(configured);
  for (const other of ctx.commands) {
    if (other === command) break;
    if (other.step !== command.step || other.owner !== command.owner || dir === undefined) continue;
    const [verb, target, extra] = words(other.command);
    if (verb === "popd") {
      dir = undefined;
      continue;
    }
    if (verb !== "cd" && verb !== "pushd") continue;
    if (/\|\||(?:^|\n)\s*(?:if|case|for|while|until)\b/.test(command.step.run?.value ?? "")) return undefined;
    if (target === undefined || extra !== undefined || target === "-" || /[$`~*]/.test(target)) dir = undefined;
    else dir = joinPath(dir, target);
  }
  return dir;
}

/** Nearest `name` in `dir` or one of its ancestors. */
export function findUp(project: ProjectModel, dir: string, name: string): string | undefined {
  let current: string | undefined = dir;
  while (current !== undefined) {
    const candidate = inDir(current, name);
    if (project.files.has(candidate)) return candidate;
    current = current === "" ? undefined : dirname(current);
  }
  return undefined;
}

/**
 * `findUp` that tolerates an unknown directory: then every `marker` file (for example each `Cargo.toml`) must resolve
 * `name`, so the answer holds whichever of them the command targets.
 */
export function findUpFrom(project: ProjectModel, dir: string | undefined, marker: string, name: string): string | undefined {
  if (dir !== undefined) return findUp(project, dir, name);
  const markers = [...project.files.keys()].filter((path) => basename(path) === marker);
  const found = markers.map((path) => findUp(project, dirname(path), name));
  return found[0] !== undefined && found.every((path) => path === found[0]) ? found[0] : undefined;
}

export interface PropertyEntry {
  value: string;
  line: number;
}

/** Parses a Java `.properties` file (`=`, `:` or whitespace separators, `#`/`!` comments, `\` continuations). */
export function parseProperties(content: string): Map<string, PropertyEntry> {
  const result = new Map<string, PropertyEntry>();
  const lines = content.split("\n").map((line) => line.replace(/\r$/, ""));
  for (let index = 0; index < lines.length; index += 1) {
    const startLine = index + 1;
    let text = (lines[index] ?? "").replace(/^\s+/, "");
    if (text === "" || text.startsWith("#") || text.startsWith("!")) continue;
    while (/(?:^|[^\\])(?:\\\\)*\\$/.test(text) && index + 1 < lines.length) {
      index += 1;
      text = text.slice(0, -1) + (lines[index] ?? "").replace(/^\s+/, "");
    }
    const match = /^((?:\\.|[^=:\s\\])*)\s*[=:]?\s*(.*)$/.exec(text);
    if (!match) continue;
    result.set((match[1] ?? "").replace(/\\(.)/g, "$1"), { value: (match[2] ?? "").trim(), line: startLine });
  }
  return result;
}

/** Edit appending whole lines at the end of a file (adding a line break first when the file lacks a trailing one). */
export function appendLines(file: SourceFile, lines: string[]): TextEdit {
  if (file.content === "") return insertLinesAfter(file, 0, lines);
  const count = file.content.split("\n").length;
  return insertLinesAfter(file, file.content.endsWith("\n") ? count - 1 : count, lines);
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Zero-width edit inserting `text` right after the given command words on `line` (for example after `cargo build`).
 * The words must occur exactly once on that line, otherwise there is no safe position and undefined is returned.
 */
export function insertAfterWords(file: SourceFile, line: number, prefix: string[], text: string): TextEdit | undefined {
  if (prefix.length === 0) return undefined;
  const pattern = new RegExp(`(?<![\\w./-])${prefix.map(escapeRegExp).join("\\s+")}(?![\\w=-])`, "g");
  const content = lineText(file.content, line);
  const matches = [...content.matchAll(pattern)];
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) return undefined;
  const offset = lineStart(file.content, line) + match.index + match[0].length;
  return { path: file.path, start: offset, end: offset, text };
}

/**
 * The raw command with `text` inserted after its prefix words, retaining quoting and wrappers.
 */
export function withInserted(raw: string, list: string[], prefix: string[], text: string): string {
  const all = shellTokens(raw);
  const command = commandTokens(raw);
  if (prefix.length === 0 || !prefix.every((word, index) => command[index]?.value === word) || command.length !== list.length) {
    return `# Add ${text.trim()} after checking the tool's argument boundaries:\n${raw}`;
  }
  const count = all.length - command.length + prefix.length;
  let end = 0;
  for (const token of all.slice(0, count)) {
    const start = raw.indexOf(token.raw, end);
    if (start < 0) return `# Add ${text.trim()} after checking the tool's argument boundaries:\n${raw}`;
    end = start + token.raw.length;
  }
  return `${raw.slice(0, end)}${text}${raw.slice(end)}`;
}

/** Replace one actual command token, leaving wrappers, other arguments and their quoting untouched. */
export function withReplacedToken(raw: string, index: number, replacement: string): string | undefined {
  const all = shellTokens(raw);
  const command = commandTokens(raw);
  if (index < 0 || index >= command.length) return undefined;
  const target = all.length - command.length + index;
  let end = 0;
  for (const [position, token] of all.entries()) {
    const start = raw.indexOf(token.raw, end);
    if (start < 0) return undefined;
    end = start + token.raw.length;
    if (position === target) return raw.slice(0, start) + replacement + raw.slice(end);
  }
  return undefined;
}

/** The run commands of a job whose first word is the given tool (by basename, so `./gradlew` matches `gradlew`). */
export function toolCommands(ctx: JobContext, ...tools: string[]): Array<{ command: JobCommand; words: string[] }> {
  const result: Array<{ command: JobCommand; words: string[] }> = [];
  for (const command of ctx.commands) {
    if (unknownCommandEnvironment(ctx, command)) continue;
    const list = words(command.command);
    const first = list[0];
    if (first !== undefined && tools.includes(basename(first))) result.push({ command, words: list });
  }
  return result;
}
