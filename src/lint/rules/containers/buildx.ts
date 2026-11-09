import { lineStart, lineText, replaceOnLine } from "../../fix.js";
import type { DockerfileModel, DockerStage } from "../../parsers/dockerfile.js";
import type { JobModel, Sourced, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import type { SourceFile, TextEdit } from "../../types.js";
import { commandWords, listOf, usesAction } from "../caching/shared.js";
import { commandsOf, jobRunsOnLabels } from "../helpers.js";

export function isBuildPush(step: StepModel): boolean {
  return usesAction(step, "docker/build-push-action");
}

export function usesQemu(job: JobModel): boolean {
  return job.steps.some((step) => usesAction(step, "docker/setup-qemu-action"));
}

/** True when a `with` value or command text contains a GitHub expression or shell variable (its value is unknown). */
export function isDynamic(text: string): boolean {
  return text.includes("${{") || text.includes("$");
}

/** A literal `with` input as a string, or undefined when absent or computed by an expression. */
export function literalWith(step: StepModel, key: string): string | undefined {
  const entry = step.with.get(key);
  if (!entry || entry.kind !== "literal" || entry.value === undefined || entry.value === null) return undefined;
  const text = String(entry.value);
  return isDynamic(text) ? undefined : text;
}

export interface CacheEntry {
  /** Lowercased `type`, `registry` for a bare reference. */
  type: string;
  attributes: Map<string, string>;
  /** The entry exactly as written (one line of a multi-line value). */
  text: string;
}

export function parseCacheEntry(text: string): CacheEntry {
  const attributes = new Map<string, string>();
  for (const part of text.split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) attributes.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  const type = attributes.get("type") ?? (text.includes("=") ? "" : "registry");
  return { type: type.toLowerCase(), attributes, text };
}

/** Entries of a build-push-action `cache-from`/`cache-to` input (none when the whole value is an expression). */
export function cacheEntries(entry: Sourced<unknown> | undefined): CacheEntry[] {
  if (!entry || entry.kind === "expression" || typeof entry.value !== "string") return [];
  return listOf(entry.value).map(parseCacheEntry);
}

/** Splits a `platforms` value (comma and/or newline separated). */
export function platformList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && !entry.startsWith("#"));
}

/** CPU architecture of an OCI platform (`linux/arm64/v8` -> `arm64`, `linux/x86_64` -> `amd64`). */
export function archOf(platform: string): string | undefined {
  const parts = platform.toLowerCase().split("/");
  const arch = parts.length >= 2 ? parts[1] : parts[0];
  switch (arch) {
    case "amd64":
    case "x86_64":
    case "x86-64":
      return "amd64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      return arch === undefined || arch === "" ? undefined : arch;
  }
}

const UBUNTU_X64 = /^ubuntu-(\d+\.\d+|latest)$/;
const UBUNTU_ARM = /^ubuntu-\d+\.\d+-arm$/;

/**
 * Native CPU architecture of a job's runner: GitHub-hosted Ubuntu labels, or a self-hosted runner carrying the
 * default `X64`/`ARM64` architecture label. Undefined when unknown (expressions, custom or larger-runner labels).
 */
export function runnerArch(job: JobModel): "amd64" | "arm64" | undefined {
  if (!job.runsOn || job.runsOn.kind !== "literal") return undefined;
  const labels = jobRunsOnLabels(job).map((label) => label.trim().toLowerCase());
  if (labels.length === 0 || labels.some((label) => label.includes("$"))) return undefined;
  if (labels.length === 1) {
    const label = labels[0] ?? "";
    if (UBUNTU_X64.test(label)) return "amd64";
    if (UBUNTU_ARM.test(label)) return "arm64";
    return undefined;
  }
  if (!labels.includes("self-hosted")) return undefined;
  const x64 = labels.includes("x64");
  const arm64 = labels.includes("arm64");
  if (x64 === arm64) return undefined;
  return x64 ? "amd64" : "arm64";
}

/** A `docker build` / `docker buildx build` invocation parsed from a shell command. */
export interface BuildCommand {
  /** The words up to and including the build verb, e.g. `docker buildx build`. */
  invocation: string;
  /** Flags by long name without dashes (`-f` -> `file`, `-o` -> `output`, `-t` -> `tag`). */
  flags: Map<string, string[]>;
  positional: string[];
}

const BOOLEAN_FLAGS = new Set([
  "load",
  "push",
  "no-cache",
  "pull",
  "quiet",
  "rm",
  "force-rm",
  "squash",
  "compress",
  "check",
  "debug",
]);
const SHORT_FLAGS: Record<string, string> = { f: "file", o: "output", t: "tag", q: "quiet" };

/** Index of the build verb in `docker build`, `docker image|builder build` or `docker buildx [--builder x] build|b`. */
export function dockerBuildIndex(words: string[]): number {
  if (words[0] !== "docker") return -1;
  if (words[1] === "build") return 1;
  if ((words[1] === "image" || words[1] === "builder") && words[2] === "build") return 2;
  if (words[1] !== "buildx") return -1;
  let index = 2;
  if (words[index] === "--builder") index += 2;
  else if (words[index]?.startsWith("--builder=")) index += 1;
  return words[index] === "build" || words[index] === "b" ? index : -1;
}

function unquote(word: string): string {
  return word.replace(/^(["'])(.*)\1$/, "$2");
}

export function parseBuildCommand(command: string): BuildCommand | undefined {
  const all = commandWords(command);
  const end = all.findIndex((word) => /^(\||\d?>>?|<|&)/.test(word));
  const words = end < 0 ? all : all.slice(0, end);
  const index = dockerBuildIndex(words);
  if (index < 0) return undefined;
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  const add = (name: string, value: string): void => {
    flags.set(name, [...(flags.get(name) ?? []), unquote(value)]);
  };
  const args = words.slice(index + 1);
  for (let position = 0; position < args.length; position += 1) {
    const word = args[position] ?? "";
    let name: string | undefined;
    let inline: string | undefined;
    const long = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/i.exec(word);
    const short = /^-([a-zA-Z])(.*)$/.exec(word);
    if (long?.[1]) {
      name = long[1].toLowerCase();
      inline = long[2];
    } else if (short?.[1]) {
      name = SHORT_FLAGS[short[1]] ?? short[1];
      inline = short[2] === "" ? undefined : short[2]?.replace(/^=/, "");
    } else {
      positional.push(unquote(word));
      continue;
    }
    if (inline !== undefined) add(name, inline);
    else if (BOOLEAN_FLAGS.has(name)) add(name, "true");
    else if (args[position + 1] !== undefined && !(args[position + 1] ?? "").startsWith("-")) {
      add(name, args[position + 1] ?? "");
      position += 1;
    } else add(name, "true");
  }
  return { invocation: words.slice(0, index + 1).join(" "), flags, positional };
}

/** True when a boolean CLI flag is set (`--load`, `--load=true`). */
export function flagSet(build: BuildCommand, name: string): boolean {
  return (build.flags.get(name) ?? []).some((value) => value.toLowerCase() !== "false");
}

export interface BuildSite {
  workflow: WorkflowModel;
  job: JobModel;
  step: StepModel;
  /** Set for a `docker build` command in a `run` step. */
  command?: { text: string; line: number; build: BuildCommand };
}

/** Every image build of a job: `docker/build-push-action` steps and `docker [buildx] build` commands. */
export function jobBuilds(workflow: WorkflowModel, job: JobModel): BuildSite[] {
  const sites: BuildSite[] = [];
  for (const step of job.steps) {
    if (isBuildPush(step)) {
      sites.push({ workflow, job, step });
      continue;
    }
    for (const { command, line } of commandsOf(step)) {
      const build = parseBuildCommand(command);
      if (build) sites.push({ workflow, job, step, command: { text: command, line, build } });
    }
  }
  return sites;
}

function normalizePath(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function joinPath(...parts: string[]): string | undefined {
  return normalizePath(parts.filter((part) => part !== "").join("/"));
}

/**
 * The Dockerfile a build uses. `file` is relative to the working directory and defaults to `<context>/Dockerfile`;
 * an absent context (build-push-action's Git context) is the repository root. A literal path is looked up exactly;
 * when `file` or `context` is computed, falls back to the repository's only Dockerfile. Remote contexts resolve to
 * nothing.
 */
export function resolveDockerfile(
  project: ProjectModel,
  file: string | undefined,
  context: string | undefined,
  workingDirectory = "",
): DockerfileModel | undefined {
  if ((file !== undefined && isDynamic(file)) || (context !== undefined && isDynamic(context))) {
    return project.dockerfiles.length === 1 ? project.dockerfiles[0] : undefined;
  }
  const cwd = workingDirectory.startsWith("/") || isDynamic(workingDirectory) ? undefined : workingDirectory;
  if (cwd === undefined) return undefined;
  let contextPath = "";
  if (context !== undefined) {
    const defaultContext = /^\{\{\s*defaultContext\s*\}\}(?::(.*))?$/.exec(context.trim());
    if (defaultContext) contextPath = defaultContext[1] ?? "";
    else if (context === "-" || /^[a-z][a-z0-9+.-]*:\/\/|^git@|\.git(#.*)?$/i.test(context)) return undefined;
    else contextPath = joinPath(cwd, context) ?? "\0";
  }
  if (contextPath === "\0") return undefined;
  const path = file !== undefined ? joinPath(cwd, file) : joinPath(contextPath, "Dockerfile");
  if (path === undefined) return undefined;
  return project.dockerfiles.find((model) => model.path === path);
}

/** The Dockerfile of a build site (build-push-action `file`/`context` or CLI `-f`/context argument). */
export function siteDockerfile(project: ProjectModel, site: BuildSite): DockerfileModel | undefined {
  if (site.command) {
    const { build } = site.command;
    const context = build.positional[0];
    if (context === undefined) return undefined;
    const workingDirectory = site.step.workingDirectory ?? site.job.workingDirectory ?? site.workflow.workingDirectory ?? "";
    return resolveDockerfile(project, build.flags.get("file")?.[0], context, workingDirectory);
  }
  const fileEntry = site.step.with.get("file");
  const contextEntry = site.step.with.get("context");
  const file = fileEntry?.value === undefined || fileEntry.value === null ? undefined : String(fileEntry.value);
  const context = contextEntry?.value === undefined || contextEntry.value === null ? undefined : String(contextEntry.value);
  return resolveDockerfile(project, file, context);
}

/** True when any stage is pinned to the build platform (`FROM --platform=$BUILDPLATFORM`), i.e. it cross-compiles. */
export function crossCompiles(model: DockerfileModel): boolean {
  return model.instructions.some(
    (instruction) => instruction.keyword === "FROM" && (instruction.flags.get("platform") ?? []).some((value) => value.includes("BUILDPLATFORM")),
  );
}

export function stageByReference(model: DockerfileModel, reference: string, before: number): DockerStage | undefined {
  const wanted = reference.toLowerCase();
  if (/^\d+$/.test(wanted)) {
    const index = Number(wanted);
    return index < before ? model.stages[index] : undefined;
  }
  return model.stages.find((stage) => stage.index < before && stage.name?.toLowerCase() === wanted);
}

/** Stages a stage copies or mounts from (`COPY --from=<stage>`, `RUN --mount=...,from=<stage>`). */
export function stageDependencies(model: DockerfileModel, stage: DockerStage): DockerStage[] {
  const result: DockerStage[] = [];
  for (const instruction of stage.instructions) {
    const references = [...(instruction.flags.get("from") ?? [])];
    for (const mount of instruction.flags.get("mount") ?? []) {
      const from = /(?:^|,)from=([^,]+)/.exec(mount)?.[1];
      if (from) references.push(from);
    }
    for (const reference of references) {
      const dependency = stageByReference(model, reference, stage.index);
      if (dependency && !result.includes(dependency)) result.push(dependency);
    }
  }
  return result;
}

/** The stage itself and the stages it is built `FROM`, nearest first. */
export function stageAncestry(model: DockerfileModel, stage: DockerStage): DockerStage[] {
  const chain: DockerStage[] = [stage];
  let current = stage;
  for (;;) {
    const parent = stageByReference(model, current.image, current.index);
    if (!parent || chain.includes(parent)) return chain;
    chain.push(parent);
    current = parent;
  }
}

/** The line of a (possibly multi-line) `with` input that contains `text`, searching the key line and its block. */
export function withEntryLine(file: SourceFile, entry: Sourced<unknown>, text: string): number | undefined {
  const lines = typeof entry.value === "string" ? entry.value.split("\n").length : 1;
  const keyIndent = /^\s*/.exec(lineText(file.content, entry.line))?.[0].length ?? 0;
  for (let line = entry.line; line <= entry.line + lines + 1; line += 1) {
    const content = lineText(file.content, line);
    if (line > entry.line && content.trim() !== "" && (/^\s*/.exec(content)?.[0].length ?? 0) <= keyIndent) return undefined;
    if (content.includes(text)) return line;
  }
  return undefined;
}

/** Replaces one cache entry of a build-push-action input with `replacement`. */
export function replaceWithEntry(file: SourceFile | undefined, entry: Sourced<unknown>, text: string, replacement: string): TextEdit | undefined {
  if (!file) return undefined;
  const line = withEntryLine(file, entry, text);
  return line === undefined ? undefined : replaceOnLine(file, line, text, replacement);
}

/** `cache-to` / `cache-from` entries of a build site (CLI flags or build-push-action inputs). */
export function siteCacheEntries(site: BuildSite, key: "cache-to" | "cache-from"): CacheEntry[] {
  if (site.command) return (site.command.build.flags.get(key) ?? []).map(parseCacheEntry);
  return cacheEntries(site.step.with.get(key));
}

/** The line a cache entry is written on: the command line for the CLI, the entry's own line for an input. */
export function siteCacheLine(project: ProjectModel, site: BuildSite, key: "cache-to" | "cache-from", entry: CacheEntry): number {
  if (site.command) return site.command.line;
  const sourced = site.step.with.get(key);
  const file = project.files.get(site.workflow.path);
  return (sourced && file ? withEntryLine(file, sourced, entry.text) : undefined) ?? sourced?.line ?? site.step.line;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces the value of a CLI flag (`--cache-to type=gha`) in a command that starts on `line`, following `\`
 * continuation lines. Undefined when the value is not written literally.
 */
export function replaceFlagValue(file: SourceFile | undefined, line: number, flag: string, value: string, replacement: string): TextEdit | undefined {
  if (!file) return undefined;
  const pattern = new RegExp(`--${escapeRegExp(flag)}(?:=|\\s+)(["']?)${escapeRegExp(value)}\\1(?=[\\s\\\\]|$)`);
  for (let current = line; current < line + 100; current += 1) {
    const text = lineText(file.content, current);
    const match = pattern.exec(text);
    if (match) {
      const quote = match[1] ?? "";
      const start = lineStart(file.content, current) + match.index + match[0].length - quote.length - value.length;
      return { path: file.path, start, end: start + value.length, text: replacement };
    }
    if (!/\\\s*$/.test(text)) return undefined;
  }
  return undefined;
}
