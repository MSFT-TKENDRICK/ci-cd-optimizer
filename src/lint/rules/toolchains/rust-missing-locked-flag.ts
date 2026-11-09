import { fix } from "../../fix.js";
import type { ProjectModel } from "../../project.js";
import { basename } from "../caching/shared.js";
import { defineRule } from "../helpers.js";
import { commandDirectory, dirname, effectiveEnv, findUp, inDir, insertAfterWords, jobContexts, joinPath, toolCommands, withInserted } from "./shared.js";

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
const GLOBAL_FLAGS = /^(?:-v+|-q|--verbose|--quiet|--offline|--locked|--frozen)$/;
/** Jobs that deliberately change the lockfile (dependency bumps, minimal-versions checks, lockfile checks). */
const LOCK_CHANGES =
  /\bcargo\s+(?:\+\S+\s+)?(?:update|generate-lockfile|upgrade|add|remove|rm)\b|minimal-versions|--remove-dev-deps|Cargo\.lock|lockfile-path|LOCKFILE_PATH/;
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
  args.forEach((word, position) => {
    if (word === "--locked" || word === "--frozen") locked = true;
    if (word === "--manifest-path" || word === "-m") manifestPath = args[position + 1];
    else if (word.startsWith("--manifest-path=")) manifestPath = word.slice("--manifest-path=".length);
  });
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
  return locks.length > 0 && locks.every((lock) => lock !== undefined) ? locks[0] : undefined;
}

export default defineRule({
  meta: {
    id: "toolchains/rust-missing-locked-flag",
    ruleset: "toolchains",
    description: "Cargo commands in CI should pass `--locked` so the committed `Cargo.lock` is enforced instead of silently rewritten.",
    rationale:
      "Without `--locked`, Cargo treats `Cargo.lock` as a cache: when it no longer matches `Cargo.toml` (a dependency added, bumped or re-featured without committing the regenerated lockfile), Cargo re-resolves on the runner, rewrites the lockfile and builds whatever versions the registry offers at that moment. CI then tests a dependency graph nobody reviewed and that differs from what developers and release builds use. `--locked` makes Cargo exit with an error when the lockfile is missing or would change, which the Cargo docs recommend for CI pipelines where deterministic builds are desired.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://doc.rust-lang.org/cargo/commands/cargo-build.html#manifest-options",
      "https://doc.rust-lang.org/cargo/commands/cargo-test.html#manifest-options",
      "https://doc.rust-lang.org/cargo/guide/cargo-toml-vs-cargo-lock.html",
    ],
    impact: "medium",
    fixable: true,
    example: {
      bad: "# Cargo.lock is committed\n- run: cargo test --all-features",
      good: "# Cargo.lock is committed\n- run: cargo test --locked --all-features",
    },
  },
  check({ project, report }) {
    for (const ctx of jobContexts(project)) {
      const cargo = toolCommands(ctx, "cargo");
      if (cargo.length === 0 || ctx.commands.some(({ command }) => LOCK_CHANGES.test(command))) continue;
      const verified = new Set<string>();
      for (const { command, words: list } of cargo) {
        const parsed = parseCargo(list);
        if (!parsed) continue;
        if (effectiveEnv(ctx, command, command).has("CARGO_RESOLVER_LOCKFILE_PATH")) continue;
        const lock = lockFor(project, commandDirectory(ctx, command), parsed.manifestPath);
        // The first command per lockfile decides: once it ran with `--locked`, later commands reuse the verified lock.
        if (lock === undefined || verified.has(lock)) continue;
        verified.add(lock);
        if (parsed.locked || list.some((word) => /[$`]/.test(word))) continue;
        const raw = command.command.trim();
        const suggested = withInserted(raw, list, parsed.prefix, " --locked");
        const file = project.files.get(command.path);
        const edit = file ? insertAfterWords(file, command.line, parsed.prefix, " --locked") : undefined;
        const repair = fix(`Add --locked to cargo ${parsed.subcommand}`, edit);
        report({
          path: command.path,
          line: command.line,
          key: `cargo-lock:${ctx.workflow.path}:${ctx.job.id}:${lock}`,
          message: `\`${raw}\` runs without \`--locked\` although \`${lock}\` is committed, so if \`Cargo.toml\` and the lockfile disagree Cargo silently re-resolves dependencies and rewrites \`${lock}\` on the runner instead of failing, and CI builds versions nobody reviewed.`,
          suggestion: `Pass \`--locked\` (or \`--frozen\`, which also forbids network access) so Cargo fails when the lockfile is missing or out of date:\n\n${suggested}\n\nLater cargo commands in the same job then reuse the verified lockfile. Jobs that update dependencies on purpose (\`cargo update\`, minimal-versions checks) are not affected by this rule.`,
          related: [{ path: lock, line: 1 }],
          ...(repair ? { fix: repair } : {}),
        });
      }
    }
  },
});
