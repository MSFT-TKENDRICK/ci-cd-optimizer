import { fix } from "../../fix.js";
import type { ProjectModel } from "../../project.js";
import { basename } from "../caching/shared.js";
import type { JobCommand } from "../helpers.js";
import { defineRule } from "../helpers.js";
import {
  commandDirectory,
  dirname,
  effectiveEnv,
  escapeRegExp,
  findUp,
  inDir,
  insertAfterWords,
  type JobContext,
  jobContexts,
  joinPath,
  toolCommands,
  withInserted,
  words,
} from "./shared.js";

/** uv options (global, `sync` and `run`) that take a separate value word. */
const VALUE_OPTIONS = new Set([
  "--allow-insecure-host",
  "--trusted-host",
  "--cache-dir",
  "--color",
  "--config-file",
  "--config-setting",
  "--config-settings",
  "-C",
  "--config-settings-package",
  "--default-index",
  "--directory",
  "--env-file",
  "--exclude-newer",
  "--exclude-newer-package",
  "--extra",
  "--extra-index-url",
  "--find-links",
  "-f",
  "--fork-strategy",
  "--group",
  "--index",
  "--index-strategy",
  "--index-url",
  "-i",
  "--keyring-provider",
  "--link-mode",
  "--no-binary-package",
  "--no-build-isolation-package",
  "--no-build-package",
  "--no-editable-package",
  "--no-extra",
  "--no-group",
  "--no-install-package",
  "--no-sources-package",
  "--only-group",
  "--output-format",
  "--package",
  "--prerelease",
  "--prerelease-package",
  "--project",
  "--python",
  "-p",
  "--python-platform",
  "--refresh-package",
  "--reinstall-package",
  "--resolution",
  "--upgrade-group",
  "--upgrade-package",
  "-P",
  "--with",
  "-w",
  "--with-editable",
  "--with-requirements",
]);
/**
 * Options under which the command does not re-lock the project (`--frozen`, `--no-sync`, no project), deliberately
 * changes it (`--upgrade*`), only inspects it, or runs a standalone script.
 */
const EXEMPT_OPTIONS = new Set([
  "--frozen",
  "--no-sync",
  "--no-project",
  "--no-workspace",
  "--no_workspace",
  "--script",
  "-s",
  "--isolated",
  "--check",
  "--dry-run",
  "--upgrade",
  "-U",
  "--upgrade-package",
  "-P",
  "--upgrade-group",
]);
const EXEMPT_ENV = ["UV_FROZEN", "UV_NO_SYNC", "UV_NO_PROJECT", "UV_ISOLATED"];
/** Non-uv commands that touch the lockfile or manifest (freshness checks, version bumps) make the job lock-aware. */
const LOCK_AWARE = /(?:^|[^\w.-])(?:uv\.lock|pyproject\.toml)\b/;

export interface UvCommand {
  subcommand: string;
  /** Command words up to and including the subcommand, as written. */
  prefix: string[];
  /** A flag or positional uv parses is a variable or expression, so it may expand to `--locked` or a script path. */
  dynamic: boolean;
  flags: Set<string>;
  values: Map<string, string>;
  /** The command `uv run` invokes. */
  target?: string;
  /** Words after the `uv run` target (they belong to the target, not to uv). */
  targetArgs: string[];
}

interface Scan {
  next: number;
  dynamic: boolean;
  flags: Set<string>;
  values: Map<string, string>;
}

function scan(list: string[], start: number, stopAtPositional: boolean): Scan {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  let dynamic = false;
  let index = start;
  for (; index < list.length; index += 1) {
    const word = list[index] ?? "";
    if (word === "--") break;
    const equals = word.indexOf("=");
    if (/[$`]/.test(equals > 0 && word.startsWith("--") ? word.slice(0, equals) : word)) dynamic = true;
    if (!word.startsWith("-") || word === "-") {
      if (stopAtPositional) break;
      continue;
    }
    if (word.startsWith("--") && equals > 0) values.set(word.slice(0, equals), word.slice(equals + 1));
    else if (VALUE_OPTIONS.has(word)) {
      values.set(word, list[index + 1] ?? "");
      index += 1;
    } else flags.add(word);
  }
  return { next: index, dynamic, flags, values };
}

/** Parses `uv [global options] <subcommand> [options] [-- | target args]`; undefined for anything else. */
export function parseUv(list: string[]): UvCommand | undefined {
  if (list[0] === undefined || basename(list[0]) !== "uv") return undefined;
  const global = scan(list, 1, true);
  const subcommand = list[global.next];
  if (subcommand === undefined || subcommand === "--") return undefined;
  const local = scan(list, global.next + 1, subcommand === "run");
  const targetAt = list[local.next] === "--" ? local.next + 1 : local.next;
  const target = subcommand === "run" ? list[targetAt] : undefined;
  return {
    subcommand,
    prefix: list.slice(0, global.next + 1),
    dynamic: global.dynamic || local.dynamic || (target !== undefined && /[$`]/.test(target)),
    flags: new Set([...global.flags, ...local.flags]),
    values: new Map([...global.values, ...local.values]),
    ...(target !== undefined ? { target } : {}),
    targetArgs: target !== undefined ? list.slice(targetAt + 1) : [],
  };
}

/** Commands that change `uv.lock` or `pyproject.toml` on purpose; such jobs are not checked. */
function mutatesLock(uv: UvCommand, list: string[]): boolean {
  if (uv.subcommand === "add" || uv.subcommand === "remove") return true;
  if (uv.subcommand === "lock") return !["--check", "--locked", "--check-exists", "--dry-run"].some((flag) => uv.flags.has(flag));
  if (uv.subcommand === "version") {
    return list.slice(uv.prefix.length).some((word) => /^--bump\b/.test(word) || /^\d/.test(word));
  }
  return false;
}

/** Body of a TOML table (`[name]`) up to the next table header; undefined when the table is absent. */
function table(content: string, name: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const header = new RegExp(`^\\s*\\[\\s*${escapeRegExp(name).replace(/\\\./g, "\\s*\\.\\s*")}\\s*\\]\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

function globMatches(glob: string, path: string): boolean {
  const source = glob
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .split(/(\*\*|\*|\?)/)
    .map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : escapeRegExp(part)))
    .join("");
  return new RegExp(`^${source}$`).test(path);
}

/** The committed `uv.lock` for a project discovered from `dir` (workspace-aware); undefined when unknown or absent. */
function lockOf(project: ProjectModel, dir: string): string | undefined {
  const manifest = findUp(project, dir, "pyproject.toml");
  if (manifest === undefined) return undefined;
  const content = project.files.get(manifest)?.content ?? "";
  // `managed = false` makes `uv run` ignore the project.
  if (/^\s*managed\s*=\s*false\b/m.test(table(content, "tool.uv") ?? "")) return undefined;
  const root = dirname(manifest);
  const own = inDir(root, "uv.lock");
  if (project.files.has(own)) return own;
  if (table(content, "tool.uv.workspace") !== undefined) return undefined;
  let parent = root;
  while (parent !== "") {
    parent = dirname(parent);
    const workspace = table(project.files.get(inDir(parent, "pyproject.toml"))?.content ?? "", "tool.uv.workspace");
    if (workspace === undefined) continue;
    // An `exclude` list may leave this package outside the workspace.
    if (/^\s*exclude\s*=/m.test(workspace)) return undefined;
    const members = [.../\bmembers\s*=\s*\[([^\]]*)\]/.exec(workspace)?.[1]?.matchAll(/["']([^"']+)["']/g) ?? []].map(
      (match) => match[1] ?? "",
    );
    const relative = parent === "" ? root : root.slice(parent.length + 1);
    if (!members.some((glob) => globMatches(glob, relative))) return undefined;
    const lock = inDir(parent, "uv.lock");
    return project.files.has(lock) ? lock : undefined;
  }
  return undefined;
}

/** Lockfile for a command in `dir`; with an unknown directory every project must share one lockfile. */
function lockFor(project: ProjectModel, dir: string | undefined): string | undefined {
  if (dir !== undefined) return lockOf(project, dir);
  const manifests = [...project.files.keys()].filter((path) => basename(path) === "pyproject.toml");
  const locks = manifests.map((path) => lockOf(project, dirname(path)));
  const first = locks[0];
  return first !== undefined && locks.every((lock) => lock === first) ? first : undefined;
}

/** Directory uv discovers the project from: the shell directory, then `--directory`, then `--project` (or their env). */
function projectDirectory(ctx: JobContext, command: JobCommand, uv: UvCommand, env: Map<string, string>): string | undefined {
  let dir = commandDirectory(ctx, command);
  const directory = uv.values.get("--directory") ?? env.get("UV_WORKING_DIR") ?? env.get("UV_WORKING_DIRECTORY");
  const projectPath = uv.values.get("--project") ?? env.get("UV_PROJECT");
  for (const target of [directory, projectPath]) {
    if (target === undefined || dir === undefined) continue;
    dir = /[$`~*]/.test(target) ? undefined : joinPath(dir, target);
  }
  return dir;
}

export default defineRule({
  meta: {
    id: "toolchains/uv-sync-unlocked",
    ruleset: "toolchains",
    description: "`uv sync` and `uv run` in CI should pass `--locked` so the committed `uv.lock` is enforced instead of silently re-locked.",
    rationale:
      "uv keeps `uv.lock` up to date automatically: `uv sync` re-locks the project before syncing unless `--locked` or `--frozen` is provided, and `uv run` locks and syncs the project before invoking the command. When a dependency was added or changed in `pyproject.toml` without committing the regenerated lockfile, CI therefore resolves fresh versions from the index, rewrites `uv.lock` on the runner and tests a dependency graph that nobody reviewed and that developers do not use. With `--locked` (or `UV_LOCKED=1`) uv asserts that `uv.lock` will remain unchanged and exits with an error when it is missing or needs to be updated.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.astral.sh/uv/concepts/projects/sync/",
      "https://docs.astral.sh/uv/reference/cli/#uv-sync--locked",
      "https://docs.astral.sh/uv/reference/environment/#uv_locked",
    ],
    impact: "medium",
    fixable: true,
    example: {
      bad: "# uv.lock is committed\n- run: uv sync --all-extras\n- run: uv run pytest",
      good: "# uv.lock is committed\n- run: uv sync --locked --all-extras\n- run: uv run pytest",
    },
  },
  check({ project, report }) {
    for (const ctx of jobContexts(project)) {
      const commands = toolCommands(ctx, "uv").map((entry) => ({ ...entry, uv: parseUv(entry.words) }));
      if (commands.length === 0) continue;
      if (commands.some(({ uv, words: list }) => uv !== undefined && mutatesLock(uv, list))) continue;
      if (ctx.commands.some(({ command }) => basename(words(command)[0] ?? "") !== "uv" && LOCK_AWARE.test(command))) continue;
      const verified = new Set<string>();
      for (const { command, words: list, uv } of commands) {
        if (uv === undefined || !["sync", "run", "lock"].includes(uv.subcommand)) continue;
        if (uv.dynamic) continue;
        const env = effectiveEnv(ctx, command, command);
        const lock = lockFor(project, projectDirectory(ctx, command, uv, env));
        // The first command per lockfile decides: once it ran with `--locked`, later commands reuse the verified lock.
        if (lock === undefined || verified.has(lock)) continue;
        if (uv.subcommand === "lock") {
          if (uv.flags.has("--check") || uv.flags.has("--locked")) verified.add(lock);
          continue;
        }
        if (uv.flags.has("--locked") || env.has("UV_LOCKED")) {
          verified.add(lock);
          continue;
        }
        const options = [...uv.flags, ...uv.values.keys()];
        if (options.some((option) => EXEMPT_OPTIONS.has(option)) || EXEMPT_ENV.some((name) => env.has(name))) continue;
        const target = uv.target;
        if (uv.subcommand === "run" && (target === undefined || /\.pyw?$/i.test(target) || /^https?:/i.test(target) || target === "-")) {
          continue;
        }
        verified.add(lock);
        const raw = command.command.trim();
        const suggested = withInserted(raw, list, uv.prefix, " --locked");
        const file = project.files.get(command.path);
        const edit = file ? insertAfterWords(file, command.line, uv.prefix, " --locked") : undefined;
        const repair = fix(`Add --locked to uv ${uv.subcommand}`, edit);
        const misplaced = uv.targetArgs.includes("--locked")
          ? ` (the \`--locked\` after \`${target ?? ""}\` is passed to that command, not to uv)`
          : "";
        const what =
          uv.subcommand === "run"
            ? `\`${raw}\` locks and syncs the project before running \`${target ?? ""}\`, and without \`--locked\`${misplaced} uv`
            : `\`${raw}\` runs without \`--locked\`, and uv re-locks the project before syncing, so it`;
        report({
          path: command.path,
          line: command.line,
          key: `uv-lock:${ctx.workflow.path}:${ctx.job.id}:${lock}`,
          message: `${what} silently rewrites the committed \`${lock}\` on the runner when it no longer matches \`pyproject.toml\` instead of failing, so CI installs dependency versions nobody reviewed.`,
          suggestion: `Pass \`--locked\` right after the subcommand so uv exits with an error when \`${lock}\` is missing or out of date:\n\n${suggested}\n\nLater uv commands in the same job then reuse the verified lockfile. Alternatively set \`UV_LOCKED: 1\` in the job's \`env:\` to cover every uv command, or use \`--frozen\` to install exactly what the lockfile pins without checking it against \`pyproject.toml\`.`,
          related: [{ path: lock, line: 1 }],
          ...(repair ? { fix: repair } : {}),
        });
      }
    }
  },
});
