import type { ProjectModel } from "../../project.js";
import { basename, usesAction } from "../caching/shared.js";
import type { JobCommand } from "../helpers.js";
import { defineRule } from "../helpers.js";
import {
  commandDirectory,
  dirname,
  effectiveEnv,
  escapeRegExp,
  findUp,
  inDir,
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
  "--script",
  "-s",
  "--check",
  "--dry-run",
  "--upgrade",
  "-U",
  "--upgrade-package",
  "-P",
  "--upgrade-group",
]);
const EXEMPT_ENV = ["UV_FROZEN", "UV_NO_SYNC", "UV_NO_PROJECT"];
const ENV_SINCE: Record<string, number[]> = {
  UV_LOCKED: [0, 4, 25],
  UV_FROZEN: [0, 4, 25],
  UV_NO_SYNC: [0, 4, 18],
  UV_NO_PROJECT: [0, 11, 8],
};

/** Unknown versions/expressions may honor the setting; known older releases must not be exempted by it. */
function envEnabled(ctx: JobContext, command: JobCommand, env: Map<string, string>, name: string): boolean {
  const value = env.get(name);
  if (value === undefined || /^(?:|0|false|no|off)$/i.test(value.trim())) return false;
  const selected = ctx.entries.slice(0, ctx.entries.findIndex((entry) => entry.step === command.step && entry.owner === command.owner))
    .filter(({ step }) => usesAction(step, "astral-sh/setup-uv")).at(-1);
  const setup = selected && !selected.step.if && !selected.owner.if ? selected.step : undefined;
  const version = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(setup?.with.get("version")?.value ?? ""));
  const minimum = ENV_SINCE[name];
  if (version && minimum) {
    for (let index = 0; index < 3; index += 1) {
      const difference = Number(version[index + 1]) - (minimum[index] ?? 0);
      if (difference < 0) return false;
      if (difference > 0) break;
    }
  }
  return true;
}
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
      "Project-mode uv sync/run can update uv.lock when freshness checks require it; a compatible existing lock need not change. --locked rejects required lock changes, whereas --frozen skips freshness checks and --no-sync avoids synchronization. Environment equivalents depend on uv version and boolean values. This rule observes visible lock policy, not actual resolution, review history or whole-build reproducibility.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://docs.astral.sh/uv/concepts/projects/sync/",
      "https://docs.astral.sh/uv/reference/cli/#uv-sync--locked",
      "https://docs.astral.sh/uv/reference/environment/#uv_locked",
    ],
    impact: "medium",
    fixable: false,
    example: {
      bad: "# uv.lock is committed\n- run: uv sync --all-extras\n- run: uv run pytest",
      good: "# uv.lock is committed\n- run: uv sync --locked --all-extras\n- run: uv run --locked pytest",
    },
  },
  check({ project, report }) {
    for (const ctx of jobContexts(project)) {
      const commands = toolCommands(ctx, "uv").map((entry) => ({ ...entry, uv: parseUv(entry.words) }));
      if (commands.length === 0) continue;
      if (commands.some(({ uv, words: list }) => uv !== undefined && mutatesLock(uv, list))) continue;
      if (ctx.commands.some(({ command }) => /^(?:sed|perl|python\d*|rm|cp|mv)$/.test(basename(words(command)[0] ?? "")) && LOCK_AWARE.test(command))) continue;
      const reported = new Set<string>();
      for (const { command, words: list, uv } of commands) {
        if (uv === undefined || !["sync", "run", "lock"].includes(uv.subcommand)) continue;
        if (uv.dynamic) continue;
        const env = effectiveEnv(ctx, command, command);
        const directory = projectDirectory(ctx, command, uv, env);
        if (directory === undefined) continue;
        const lock = lockFor(project, directory);
        if (lock === undefined || reported.has(lock) || uv.subcommand === "lock") continue;
        if (uv.flags.has("--locked") || envEnabled(ctx, command, env, "UV_LOCKED")) continue;
        const options = [...uv.flags, ...uv.values.keys()];
        if (options.some((option) => EXEMPT_OPTIONS.has(option)) || EXEMPT_ENV.some((name) => envEnabled(ctx, command, env, name))) continue;
        const target = uv.target;
        if (uv.subcommand === "run" && (target === undefined || /\.pyw?$/i.test(target) || /^https?:/i.test(target) || target === "-")) {
          continue;
        }
        reported.add(lock);
        const raw = command.command.trim();
        const suggested = withInserted(raw, list, uv.prefix, " --locked");
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
          message: `${what} may rewrite the inspected \`${lock}\` when freshness checks require changes instead of rejecting the update. A compatible lock can remain unchanged; this does not establish an actual dependency change.`,
          suggestion: `If CI should reject lockfile changes, pass \`--locked\` right after each dependency-resolving subcommand:\n\n${suggested}\n\nAn earlier check does not constrain later commands. On uv >= 0.4.25, \`UV_LOCKED: 1\` can set this policy for every command in scope. \`--frozen\` instead skips freshness checks, which is a different policy. Test the chosen policy before adopting it.`,
          related: [{ path: lock, line: 1 }],
        });
      }
    }
  },
});
