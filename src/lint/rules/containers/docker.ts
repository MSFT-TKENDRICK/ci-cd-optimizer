import { lineStart } from "../../fix.js";
import type { DockerInstruction, DockerStage, DockerfileModel } from "../../parsers/dockerfile.js";
import type { ProjectModel } from "../../project.js";
import type { SourceFile } from "../../types.js";

/** One shell command inside a Dockerfile `RUN` instruction. */
export interface ShellCommand {
  /** Command text with leading env assignments and wrappers (`sudo`, `then`, ...) removed. */
  text: string;
  words: string[];
  /** 1-based line where the command starts. */
  line: number;
  /** Absolute character offset of `text` in the file, or -1 when unknown (exec form). */
  offset: number;
}

export type Ecosystem =
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "pip"
  | "poetry"
  | "uv"
  | "go"
  | "bundler"
  | "cargo"
  | "maven"
  | "gradle"
  | "dotnet"
  | "composer";

const WRAPPERS = new Set(["sudo", "then", "do", "else", "elif", "if", "while", "until", "!", "exec", "time", "command", "nohup", "{", "env"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*/;

function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function blank(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}

function escapeOf(content: string): string {
  const directive = /^#\s*escape\s*=\s*(`|\\)/im.exec(content.split(/\r?\n/).slice(0, 5).join("\n"));
  return directive?.[1] ?? "\\";
}

function unquote(word: string): string {
  return word.replace(/^(["'])(.*)\1$/, "$2");
}

/** Splits a shell script into commands at `&&`, `||`, `|`, `;`, `&`, newlines and parentheses (quote aware). */
function splitShell(script: string, base: number): Array<{ text: string; offset: number }> {
  const result: Array<{ text: string; offset: number }> = [];
  let quote: string | undefined;
  let start = 0;
  const push = (end: number) => {
    const piece = script.slice(start, end);
    const lead = piece.length - piece.trimStart().length;
    const text = piece.trim();
    if (text) result.push({ text, offset: base + start + lead });
  };
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index] ?? "";
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"') index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(script[index - 1] ?? ""))) {
      push(index);
      const newline = script.indexOf("\n", index);
      index = newline < 0 ? script.length : newline;
      start = index + 1;
      continue;
    }
    if ("&|;\n()".includes(char)) {
      push(index);
      const next = script[index + 1];
      if ((char === "&" || char === "|") && next === char) index += 1;
      start = index + 1;
    }
  }
  push(script.length);
  return result;
}

function toCommand(content: string | undefined, piece: { text: string; offset: number }, fallbackLine: number): ShellCommand | undefined {
  let text = piece.text;
  let offset = piece.offset;
  for (;;) {
    const assignment = ASSIGNMENT.exec(text);
    if (assignment && assignment[0].length < text.length) {
      text = text.slice(assignment[0].length);
      offset += assignment[0].length;
      continue;
    }
    const first = /^(\S+)\s+/.exec(text);
    if (first?.[1] && WRAPPERS.has(first[1])) {
      text = text.slice(first[0].length);
      offset += first[0].length;
      continue;
    }
    break;
  }
  const words = text.split(/\s+/).filter(Boolean).map(unquote);
  if (words.length === 0) return undefined;
  const known = content !== undefined && offset >= 0;
  return { text, words, line: known ? lineAt(content, offset) : fallbackLine, offset: known ? offset : -1 };
}

/**
 * Shell commands of a `RUN` instruction with exact source positions. Handles line continuations, comments inside
 * continuations, BuildKit flags (`--mount=...`), heredocs (`RUN <<EOF`) and the JSON exec form.
 */
export function shellCommands(file: SourceFile | undefined, instruction: DockerInstruction): ShellCommand[] {
  if (instruction.keyword !== "RUN") return [];
  if (!file) {
    return splitShell(instruction.args, 0)
      .map((piece) => toCommand(undefined, { ...piece, offset: -1 }, instruction.line))
      .filter((command): command is ShellCommand => command !== undefined);
  }
  const content = file.content;
  const start = lineStart(content, instruction.line);
  const end = lineStart(content, instruction.endLine + 1);
  const escape = escapeOf(content);
  let raw = content.slice(start, end);
  // Blank comment lines inside continuations (with their newline) and the continuation escapes plus newlines,
  // keeping offsets intact so positions still map onto the original file.
  const rawLines = raw.split("\n");
  raw = rawLines
    .map((line, index) => {
      const eol = index === rawLines.length - 1 ? "" : "\n";
      return index > 0 && line.trim().startsWith("#") ? blank(line) + (eol ? " " : "") : line + eol;
    })
    .join("");
  const continuation = new RegExp(`${escape === "\\" ? "\\\\" : "`"}[ \\t]*\\r?\\n`, "g");
  raw = raw.replace(continuation, (match) => " ".repeat(match.length));

  let cursor = /^\s*RUN\s+/i.exec(raw)?.[0].length ?? 0;
  for (;;) {
    const flag = /^--[a-z-]+(?:=(?:"[^"]*"|\S+))?\s*/i.exec(raw.slice(cursor));
    if (!flag) break;
    cursor += flag[0].length;
  }
  const rest = raw.slice(cursor);

  if (rest.trimStart().startsWith("[")) {
    try {
      const parsed = JSON.parse(rest.trim()) as unknown;
      if (Array.isArray(parsed) && parsed.every((word) => typeof word === "string")) {
        const words = parsed as string[];
        if (/^(ba|da)?sh$/.test(words[0]?.split("/").pop() ?? "") && words[1] === "-c" && words[2] !== undefined) {
          return splitShell(words[2], 0)
            .map((piece) => toCommand(undefined, { ...piece, offset: -1 }, instruction.line))
            .filter((command): command is ShellCommand => command !== undefined);
        }
        return words.length > 0 ? [{ text: words.join(" "), words, line: instruction.line, offset: -1 }] : [];
      }
    } catch {
      // Not valid JSON: Docker treats it as shell form.
    }
  }

  const segments: Array<{ text: string; offset: number }> = [];
  const heredoc = /<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/.exec(rest);
  if (heredoc?.[1]) {
    const prefix = rest.slice(0, heredoc.index);
    const bodyStart = rest.indexOf("\n", heredoc.index);
    if (bodyStart >= 0) {
      const lines = rest.slice(bodyStart + 1).split("\n");
      let length = 0;
      for (const line of lines) {
        if (line.trim() === heredoc[1]) break;
        length += line.length + 1;
      }
      const body = rest.slice(bodyStart + 1, bodyStart + 1 + length);
      if (prefix.trim() === "" || /^(ba|da)?sh(\s+-\S+)*$/.test(prefix.trim())) {
        segments.push({ text: body, offset: start + cursor + bodyStart + 1 });
      } else {
        segments.push({ text: prefix, offset: start + cursor });
      }
    } else {
      segments.push({ text: prefix, offset: start + cursor });
    }
  } else {
    segments.push({ text: rest, offset: start + cursor });
  }
  return segments.flatMap((segment) =>
    splitShell(segment.text, segment.offset)
      .map((piece) => toCommand(content, piece, instruction.line))
      .filter((command): command is ShellCommand => command !== undefined),
  );
}

const VALUE_FLAGS = new Set(["--omit", "--include", "--workspace", "-w", "--prefix", "--cache", "--registry", "--loglevel", "--install-strategy"]);

function positionals(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg.startsWith("-")) {
      if (VALUE_FLAGS.has(arg)) index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function normalizePython(words: string[]): string[] {
  if (/^python[\d.]*$/.test(words[0] ?? "") && words[1] === "-m" && /^pip[\d.]*$/.test(words[2] ?? "")) {
    return ["pip", ...words.slice(3)];
  }
  if (/^pip[\d.]*$/.test(words[0] ?? "")) return ["pip", ...words.slice(1)];
  return words;
}

function hasRequirementFile(args: string[]): boolean {
  return args.some((arg) => arg === "-r" || arg === "--requirement" || /^-r\S/.test(arg) || arg.startsWith("--requirement="));
}

function tool(word: string | undefined): string {
  return (word ?? "").split("/").pop() ?? "";
}

/**
 * Detects a project dependency install (the command whose layer should only depend on manifests and lockfiles).
 * Global tool installs (`npm i -g pnpm`) and ad-hoc package installs (`npm i left-pad`) are not dependency installs.
 */
export function dependencyInstall(input: string[]): Ecosystem | undefined {
  const words = normalizePython(input);
  const [head, verb, ...rest] = words;
  const name = tool(head);
  switch (name) {
    case "npm":
      if (verb === "ci") return "npm";
      if ((verb === "install" || verb === "i") && !rest.some((arg) => arg === "-g" || arg === "--global")) {
        return positionals(rest).length === 0 ? "npm" : undefined;
      }
      return undefined;
    case "pnpm":
      if (verb === "fetch") return "pnpm";
      if ((verb === "install" || verb === "i") && !rest.some((arg) => arg === "-g" || arg === "--global")) return "pnpm";
      return undefined;
    case "yarn":
      if (verb === undefined || verb === "install" || verb.startsWith("-")) return "yarn";
      return undefined;
    case "bun":
      return (verb === "install" || verb === "i") && positionals(rest).length === 0 && !rest.includes("-g") ? "bun" : undefined;
    case "pip":
      return verb === "install" && hasRequirementFile(rest) ? "pip" : undefined;
    case "poetry":
      return verb === "install" ? "poetry" : undefined;
    case "uv":
      if (verb === "sync") return "uv";
      if (verb === "pip" && (rest[0] === "sync" || (rest[0] === "install" && hasRequirementFile(rest.slice(1))))) return "uv";
      return undefined;
    case "go":
      return verb === "mod" && rest[0] === "download" ? "go" : undefined;
    case "bundle":
      return verb === "install" ? "bundler" : undefined;
    case "cargo":
      return verb === "fetch" || verb === "build" ? "cargo" : undefined;
    case "mvn":
    case "mvnw":
      return [verb, ...rest].some((arg) => /^(dependency:(go-offline|resolve)|package|install|verify)$/.test(arg ?? ""))
        ? "maven"
        : undefined;
    case "gradle":
    case "gradlew":
      return [verb, ...rest].includes("dependencies") ? "gradle" : undefined;
    case "dotnet":
      return verb === "restore" ? "dotnet" : undefined;
    case "composer":
      return verb === "install" ? "composer" : undefined;
    default:
      return undefined;
  }
}

/** Compiles or packages an application with a language toolchain (signals a build that belongs in a builder stage). */
export function toolchainBuild(words: string[]): string | undefined {
  const [head, verb, ...rest] = words;
  const name = tool(head);
  if (name === "go" && verb === "build") return "go build";
  if (name === "cargo" && verb === "build") return "cargo build";
  if ((name === "mvn" || name === "mvnw") && [verb, ...rest].some((arg) => arg === "package" || arg === "install" || arg === "verify")) {
    return "mvn package";
  }
  if ((name === "gradle" || name === "gradlew") && [verb, ...rest].some((arg) => /^(:?[\w-]+:)*(build|assemble|bootJar|shadowJar|installDist)$/.test(arg ?? ""))) {
    return "gradle build";
  }
  if (name === "dotnet" && (verb === "publish" || verb === "build")) return `dotnet ${verb}`;
  return undefined;
}

export type PackageInstaller = "apt" | "apk";

/** `apt-get install` / `apt install` / `apk add`, with the index of the subcommand word. */
export function systemInstall(words: string[]): { installer: PackageInstaller; verbIndex: number; packages: string[] } | undefined {
  const name = tool(words[0]);
  let verbIndex = -1;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "-o" || word === "-c" || word === "-t" || word === "-X" || word === "--repository") {
      index += 1;
      continue;
    }
    if (!word.startsWith("-")) {
      verbIndex = index;
      break;
    }
  }
  const verb = words[verbIndex];
  if ((name === "apt-get" || name === "apt") && verb === "install") {
    return { installer: "apt", verbIndex, packages: words.slice(verbIndex + 1).filter((word) => !word.startsWith("-")) };
  }
  if (name === "apk" && verb === "add") {
    const packages: string[] = [];
    const rest = words.slice(verbIndex + 1);
    for (let index = 0; index < rest.length; index += 1) {
      const word = rest[index] ?? "";
      if (word === "-t" || word === "--virtual" || word === "-X" || word === "--repository") {
        index += 1;
        continue;
      }
      if (!word.startsWith("-")) packages.push(word);
    }
    return { installer: "apk", verbIndex, packages };
  }
  return undefined;
}

export interface CacheMount {
  target: string;
  sharing?: string;
  id?: string;
}

/** `RUN --mount=type=cache,...` mounts of an instruction. */
export function cacheMounts(instruction: DockerInstruction): CacheMount[] {
  const mounts: CacheMount[] = [];
  for (const value of instruction.flags.get("mount") ?? []) {
    const options = new Map<string, string>();
    for (const part of value.split(",")) {
      const [key, ...rest] = part.split("=");
      if (key) options.set(key.trim().toLowerCase(), rest.join("=").trim());
    }
    if (options.get("type") !== "cache") continue;
    const target = options.get("target") ?? options.get("dst") ?? options.get("destination");
    if (target === undefined) continue;
    const sharing = options.get("sharing");
    const id = options.get("id");
    mounts.push({ target, ...(sharing !== undefined ? { sharing } : {}), ...(id !== undefined ? { id } : {}) });
  }
  return mounts;
}

/** Sources of a `COPY`/`ADD` instruction copied from the build context (undefined for `--from` or heredoc copies). */
export function contextSources(instruction: DockerInstruction): string[] | undefined {
  if (instruction.keyword !== "COPY" && instruction.keyword !== "ADD") return undefined;
  if (instruction.flags.has("from")) return undefined;
  const args = instruction.args.trim();
  if (args.startsWith("<<")) return undefined;
  let parts: string[] = [];
  if (args.startsWith("[")) {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (Array.isArray(parsed)) parts = parsed.map(String);
    } catch {
      parts = args.split(/\s+/);
    }
  } else {
    parts = args.split(/\s+/).filter(Boolean);
  }
  return parts.length >= 2 ? parts.slice(0, -1).map(unquote) : undefined;
}

/** `COPY . .`, `COPY ./ /app`, `ADD . /src`, `COPY * ./` - copies the whole build context. */
export function isBroadCopy(instruction: DockerInstruction): boolean {
  const sources = contextSources(instruction);
  return sources !== undefined && sources.some((source) => /^(\.\/?|\.\/\*|\*)$/.test(source));
}

export function stageLabel(stage: DockerStage): string {
  return stage.name ?? String(stage.index);
}

export function hasSyntaxDirective(file: SourceFile | undefined): boolean {
  if (!file) return true;
  for (const line of file.content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("#")) return false;
    if (/^#\s*syntax\s*=/i.test(trimmed)) return true;
  }
  return false;
}

/** The registry host of an image reference (`docker.io` for unqualified Docker Hub references). */
export function registryHost(reference: string): string {
  const first = reference.split("/")[0] ?? "";
  if (reference.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")) {
    return first.toLowerCase();
  }
  return "docker.io";
}

export function isDockerHub(host: string): boolean {
  return ["docker.io", "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com"].includes(host);
}

/** True when a stage's base is another stage, `scratch`, or an unresolved build arg. */
export function isInternalBase(model: DockerfileModel, stage: DockerStage): boolean {
  if (stage.image === "scratch" || stage.image.includes("$")) return true;
  return model.stages.some((other) => other.index < stage.index && other.name !== undefined && other.name.toLowerCase() === stage.image.toLowerCase());
}

export function fileOf(project: ProjectModel, model: DockerfileModel): SourceFile | undefined {
  return project.files.get(model.path);
}

/** Last literal `WORKDIR` before an instruction in a stage. */
export function workdirBefore(stage: DockerStage, instruction: DockerInstruction): string | undefined {
  let workdir: string | undefined;
  for (const candidate of stage.instructions) {
    if (candidate === instruction) break;
    if (candidate.keyword === "WORKDIR") {
      const value = candidate.args.trim().replace(/^"|"$/g, "");
      if (value.includes("$")) workdir = undefined;
      else if (value.startsWith("/")) workdir = value;
      else workdir = workdir !== undefined ? `${workdir.replace(/\/$/, "")}/${value}` : undefined;
    }
  }
  return workdir;
}
