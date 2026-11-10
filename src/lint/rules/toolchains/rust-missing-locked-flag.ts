import type { ProjectModel } from "../../project.js";
import { basename } from "../caching/shared.js";
import { defineRule } from "../helpers.js";
import { commandDirectory, dirname, effectiveEnv, findUp, inDir, jobContexts, joinPath, toolCommands, withInserted, words } from "./shared.js";

/** Cargo subcommands (and aliases) that resolve the dependency graph and accept `--locked`. */
const SUBCOMMANDS = new Map([
  ["build", "build"],
  ["b", "build"],
  ["check", "check"],
  ["c", "check"],
  ["test", "test"],
  ["t", "test"],
  ["clippy", "clippy"],
  ["run", "run"],
  ["r", "run"],
  ["bench", "bench"],
  ["doc", "doc"],
  ["d", "doc"],
  ["fetch", "fetch"],
]);
const GLOBAL_VALUE_OPTIONS = new Set(["--config", "-Z", "--color"]);
const VALUE_OPTIONS = new Set([...GLOBAL_VALUE_OPTIONS, "--manifest-path", "--target", "--target-dir", "--profile", "--features", "-F", "--package", "-p", "--bin", "--example", "--test", "--bench", "--jobs", "-j", "--message-format", "--artifact-dir", "--lockfile-path"]);
const GLOBAL_FLAGS = /^(?:-v+|-q|--verbose|--quiet|--offline|--locked|--frozen)$/;
/** Jobs that deliberately change the lockfile (dependency bumps, minimal-versions checks, lockfile checks). */
function changesLock(command: string): boolean {
  const list = words(command);
  if (basename(list[0] ?? "") !== "cargo") {
    return /^(?:sed|perl|python\d*|rm|cp|mv)$/.test(basename(list[0] ?? "")) && list.slice(1).some((word) => word.includes("Cargo.lock"));
  }
  let index = list[1]?.startsWith("+") ? 2 : 1;
  for (; index < list.length && list[index]?.startsWith("-"); index += 1) {
    const word = list[index] ?? "";
    if ((word === "-Z" && /^(?:direct-)?minimal-versions$/.test(list[index + 1] ?? "")) || /^-Z(?:direct-)?minimal-versions$/.test(word)) return true;
    if (GLOBAL_VALUE_OPTIONS.has(word)) index += 1;
  }
  return ["update", "generate-lockfile", "upgrade", "add", "remove", "rm"].includes(list[index] ?? "");
}
const WORKSPACE = /^\s*\[workspace\]/m;

export interface CargoCommand {
  /** The command words up to and including the subcommand, as written. */
  prefix: string[];
  subcommand: string;
  /** Words after the subcommand, up to (not including) `--`. */
  args: string[];
  locked: boolean;
  manifestPath?: string;
}

/** Parses `cargo [+toolchain] [global options] <subcommand> [args] [-- passthrough]`; undefined when unsure. */
export function parseCargo(list: string[]): CargoCommand | undefined {
  if (list[0] === undefined || basename(list[0]) !== "cargo") return undefined;
  let index = 1;
  let locked = false;
  if (list[index]?.startsWith("+")) index += 1;
  for (; index < list.length; index += 1) {
    const word = list[index] ?? "";
    if (!word.startsWith("-")) break;
    if (word === "--locked" || word === "--frozen") locked = true;
    if (GLOBAL_VALUE_OPTIONS.has(word)) index += 1;
    else if (!GLOBAL_FLAGS.test(word) && !/^--(?:config|color)=/.test(word) && !/^-Z./.test(word)) return undefined;
  }
  const written = list[index];
  const subcommand = written === undefined ? undefined : SUBCOMMANDS.get(written);
  if (subcommand === undefined) return undefined;
  const rest = list.slice(index + 1);
  const separator = rest.indexOf("--");
  const args = separator < 0 ? rest : rest.slice(0, separator);
  let manifestPath: string | undefined;
  for (let position = 0; position < args.length; position += 1) {
    const word = args[position] ?? "";
    if (word === "-h" || word === "--help" || word === "--version") return undefined;
    if (word === "--locked" || word === "--frozen") locked = true;
    if (word === "--manifest-path") manifestPath = args[position + 1];
    else if (word.startsWith("--manifest-path=")) manifestPath = word.slice("--manifest-path=".length);
    if (VALUE_OPTIONS.has(word)) position += 1;
  }
  return { prefix: list.slice(0, index + 1), subcommand, args, locked, ...(manifestPath !== undefined ? { manifestPath } : {}) };
}

/** The `Cargo.lock` Cargo uses for the package whose `Cargo.toml` lives in `manifestDir` (workspace-aware). */
function lockOfManifest(project: ProjectModel, manifestDir: string): string | undefined {
  const own = inDir(manifestDir, "Cargo.lock");
  if (project.files.has(own)) return own;
  const manifest = project.files.get(inDir(manifestDir, "Cargo.toml"))?.content ?? "";
  // A workspace root without a lockfile, or a package pointing at an explicit workspace: no committed lock to enforce.
  if (WORKSPACE.test(manifest) || /^\s*workspace\s*=/m.test(manifest)) return undefined;
  let parent = manifestDir;
  while (parent !== "") {
    parent = dirname(parent);
    const content = project.files.get(inDir(parent, "Cargo.toml"))?.content;
    if (content === undefined || !WORKSPACE.test(content)) continue;
    // An `exclude` list may leave this package outside the workspace, with a lockfile of its own.
    if (/^\s*exclude\s*=/m.test(content)) return undefined;
    const lock = inDir(parent, "Cargo.lock");
    return project.files.has(lock) ? lock : undefined;
  }
  return undefined;
}

/** The committed lockfile a cargo command uses; undefined when unknown or absent. */
function lockFor(project: ProjectModel, dir: string | undefined, manifestPath: string | undefined): string | undefined {
  if (manifestPath !== undefined) {
    if (dir === undefined || /[$`~*]/.test(manifestPath) || basename(manifestPath) !== "Cargo.toml") return undefined;
    const path = joinPath(dir, manifestPath);
    return path !== undefined && project.files.has(path) ? lockOfManifest(project, dirname(path)) : undefined;
  }
  if (dir !== undefined) {
    const manifest = findUp(project, dir, "Cargo.toml");
    return manifest === undefined ? undefined : lockOfManifest(project, dirname(manifest));
  }
  const manifests = [...project.files.keys()].filter((path) => basename(path) === "Cargo.toml");
  const locks = manifests.map((path) => lockOfManifest(project, dirname(path)));
  return locks[0] !== undefined && locks.every((lock) => lock === locks[0]) ? locks[0] : undefined;
}

export default defineRule({
  meta: {
    id: "toolchains/rust-missing-locked-flag",
    ruleset: "toolchains",
    description: "Cargo commands in CI should pass `--locked` so the committed `Cargo.lock` is enforced instead of silently rewritten.",
    rationale:
      "Cargo normally reuses a compatible lockfile, but may resolve dependencies and rewrite it when manifests or configuration require a change. Absence of --locked is permission to change the lock, not evidence that it changes or that dependencies were unreviewed. --locked rejects a missing/changed lockfile; it does not prove a reproducible build or forbid network access. Apply this policy only where CI is intended to enforce a frozen dependency graph.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://doc.rust-lang.org/cargo/commands/cargo-build.html#manifest-options",
      "https://doc.rust-lang.org/cargo/commands/cargo-test.html#manifest-options",
      "https://doc.rust-lang.org/cargo/guide/cargo-toml-vs-cargo-lock.html",
    ],
    impact: "medium",
    fixable: false,
    example: {
      bad: "# Cargo.lock is committed\n- run: cargo test --all-features",
      good: "# Cargo.lock is committed\n- run: cargo test --locked --all-features",
    },
  },
  check({ project, report }) {
    for (const ctx of jobContexts(project)) {
      const cargo = toolCommands(ctx, "cargo");
      if (cargo.length === 0 || ctx.commands.some(({ command }) => changesLock(command))) continue;
      const reported = new Set<string>();
      for (const { command, words: list } of cargo) {
        const parsed = parseCargo(list);
        if (!parsed) continue;
        if (effectiveEnv(ctx, command, command).has("CARGO_RESOLVER_LOCKFILE_PATH")) continue;
        const directory = commandDirectory(ctx, command);
        if (directory === undefined || parsed.args.some((word) => word === "--lockfile-path" || word.startsWith("--lockfile-path="))) continue;
        const lock = lockFor(project, directory, parsed.manifestPath);
        if (lock === undefined || reported.has(lock)) continue;
        if (parsed.locked || list.some((word) => /[$`]/.test(word))) continue;
        reported.add(lock);
        const raw = command.command.trim();
        const suggested = withInserted(raw, list, parsed.prefix, " --locked");
        report({
          path: command.path,
          line: command.line,
          key: `cargo-lock:${ctx.workflow.path}:${ctx.job.id}:${lock}`,
          message: `\`${raw}\` runs without \`--locked\` although \`${lock}\` is present in the inspected repository. Cargo may resolve dependencies and rewrite the lock when necessary instead of rejecting the change; a compatible lock may remain unchanged.`,
          suggestion: `If CI should reject lockfile changes, pass \`--locked\` (or \`--frozen\`, which also forbids network access) on each dependency-resolving invocation:\n\n${suggested}\n\nAn earlier locked command does not protect later commands if manifests or configuration change. Dependency-update jobs are intentionally excluded.`,
          related: [{ path: lock, line: 1 }],
        });
      }
    }
  },
});
