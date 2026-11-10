import type { StepModel, WorkflowModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import { shellTokens } from "../../parsers/shell.js";
import { CACHE_RESTORE_ACTIONS, isFalse, isTrue, listOf, usesAction } from "../caching/shared.js";
import { defineRule, type JobCommand } from "../helpers.js";
import { parseCargo, type CargoCommand } from "./rust-missing-locked-flag.js";
import {
  commandDirectory,
  dirname,
  effectiveEnv,
  entryIndex,
  envKeyLine,
  githubEnvPairs,
  inDir,
  inlineEnv,
  jobContexts,
  toolCommands,
  type EnvScope,
  type JobContext,
} from "./shared.js";

const VARIABLES = ["CARGO_INCREMENTAL", "CARGO_BUILD_INCREMENTAL"] as const;
type Variable = (typeof VARIABLES)[number];
/** Subcommands that run rustc on workspace crates (and therefore produce incremental session data when enabled). */
const COMPILING = new Set(["build", "check", "test", "clippy", "run", "bench"]);
const CACHE_ACTIONS = [
  ...CACHE_RESTORE_ACTIONS,
  "actions/cache/save",
  "buildjet/cache/save",
  "useblacksmith/cache/save",
  "runs-on/cache/save",
];
/** First Cargo release that disables incremental compilation by default when the `CI` variable is set. */
const CI_DEFAULT_OFF_MINOR = 99;

interface Setting {
  value: string;
  path: string;
  line: number | undefined;
  /** Where the value was written: a YAML `env:` key, a shell assignment, or implicitly by a caching action. */
  origin: "yaml" | "shell" | "action";
  actionName?: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value);
}

function isRustCache(step: StepModel): boolean {
  return usesAction(step, "swatinem/rust-cache");
}

function isSetupRust(step: StepModel): boolean {
  return usesAction(step, "actions-rust-lang/setup-rust-toolchain");
}

/** actions/cache (or a drop-in) whose literal `path` list includes a Cargo `target` directory. */
function cachesTarget(step: StepModel): boolean {
  if (!usesAction(step, ...CACHE_ACTIONS)) return false;
  const path = step.with.get("path");
  if (path === undefined || path.kind !== "literal" || typeof path.value !== "string") return false;
  return listOf(path.value).some(
    (entry) => !entry.startsWith("!") && /(?:^|\/)target(?:\/|$)/.test(entry.replace(/\\/g, "/")),
  );
}

function scopeSettings(
  env: Map<Variable, Setting>,
  values: Record<string, unknown>,
  model: WorkflowModel,
  scope: EnvScope,
): void {
  for (const name of VARIABLES) {
    if (!(name in values)) continue;
    env.set(name, { value: text(values[name]), path: model.path, line: envKeyLine(model, scope, name), origin: "yaml" });
  }
}

/**
 * Value and origin of `CARGO_INCREMENTAL` / `CARGO_BUILD_INCREMENTAL` for one command, following the runner's order:
 * workflow and job `env:`, then earlier steps (`$GITHUB_ENV` writes, and Swatinem/rust-cache and
 * actions-rust-lang/setup-rust-toolchain, which export `CARGO_INCREMENTAL=0`), then the calling and own step `env:`,
 * earlier `export`s in the same script and inline assignments.
 */
function resolve(project: ProjectModel, ctx: JobContext, command: JobCommand): Map<Variable, Setting> {
  const env = new Map<Variable, Setting>();
  scopeSettings(env, ctx.workflow.env, ctx.workflow, { kind: "workflow" });
  scopeSettings(env, ctx.job.env, ctx.workflow, { kind: "job", job: ctx.job });
  const stop = entryIndex(ctx, command);
  ctx.entries.forEach((entry, index) => {
    if (index >= stop) return;
    const { step } = entry;
    const implicit = (actionName: string): void => {
      env.set("CARGO_INCREMENTAL", { value: step.if || entry.owner.if ? "${unknown}" : "0", path: entry.path, line: step.line, origin: "action", actionName });
    };
    if (isRustCache(step)) implicit("Swatinem/rust-cache");
    // setup-rust-toolchain writes CARGO_INCREMENTAL=0 only when unset, then (cache enabled by default) runs rust-cache.
    if (isSetupRust(step) && (!isFalse(step.with.get("cache")?.value) || !env.has("CARGO_INCREMENTAL"))) {
      implicit("actions-rust-lang/setup-rust-toolchain");
    }
    for (const other of ctx.commands) {
      if (other.step !== step || other.owner !== entry.owner) continue;
      for (const [name, value] of githubEnvPairs(other.command)) {
        if ((VARIABLES as readonly string[]).includes(name)) {
          env.set(name as Variable, { value: step.if || entry.owner.if ? "${unknown}" : value, path: other.path, line: other.line, origin: "shell" });
        }
      }
    }
  });
  if (!command.direct) {
    scopeSettings(env, command.owner.env, ctx.workflow, { kind: "step", key: command.owner.key });
  }
  const model = command.direct ? ctx.workflow : project.actions.find((action) => action.path === command.path);
  if (model) scopeSettings(env, command.step.env, model, { kind: "step", key: command.step.key });
  for (const other of ctx.commands) {
    if (other === command) break;
    if (other.step !== command.step || other.owner !== command.owner) continue;
    const tokens = shellTokens(other.command);
    if (tokens[0]?.value !== "export") continue;
    for (const token of tokens.slice(1)) {
      const match = /^(CARGO_(?:BUILD_)?INCREMENTAL)=([\s\S]*)$/.exec(token.value);
      if (match) env.set(match[1] as Variable, { value: match[2] ?? "", path: other.path, line: other.line, origin: "shell" });
    }
  }
  for (const [name, value] of inlineEnv(command.command)) {
    if ((VARIABLES as readonly string[]).includes(name)) {
      env.set(name as Variable, { value, path: command.path, line: command.line, origin: "shell" });
    }
  }
  return env;
}

/** The setting that forces incremental compilation on, if any (`CARGO_INCREMENTAL` takes precedence over the config). */
function forcedOn(env: Map<Variable, Setting>): { name: Variable; setting: Setting } | undefined {
  const incremental = env.get("CARGO_INCREMENTAL");
  if (incremental !== undefined) return incremental.value === "1" ? { name: "CARGO_INCREMENTAL", setting: incremental } : undefined;
  const build = env.get("CARGO_BUILD_INCREMENTAL");
  return build !== undefined && isTrue(build.value) ? { name: "CARGO_BUILD_INCREMENTAL", setting: build } : undefined;
}

interface ConfigSetting {
  path: string;
  line: number;
  value: boolean;
}

/** `build.incremental` from one Cargo config file (`[build]` table or dotted key). */
function configIncremental(path: string, content: string): ConfigSetting | undefined {
  let table = "";
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").replace(/#.*$/, "").trim();
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      table = (header[1] ?? "").replace(/["'\s]/g, "");
      continue;
    }
    const key = table === "build" ? /^incremental\s*=\s*(true|false)$/.exec(line) : table === "" ? /^build\s*\.\s*incremental\s*=\s*(true|false)$/.exec(line) : null;
    if (key) return { path, line: index + 1, value: key[1] === "true" };
  }
  return undefined;
}

/**
 * The `build.incremental` value Cargo reads for a command run in `dir`: the deepest `.cargo/config` (preferred) or
 * `.cargo/config.toml` that sets it, walking up to the repository root.
 */
function configFor(project: ProjectModel, dir: string): ConfigSetting | undefined {
  let current: string | undefined = dir;
  while (current !== undefined) {
    for (const name of [".cargo/config", ".cargo/config.toml"]) {
      const file = project.files.get(inDir(current, name));
      if (file === undefined) continue;
      const setting = configIncremental(file.path, file.content);
      if (setting) return setting;
      break;
    }
    current = current === "" ? undefined : dirname(current);
  }
  return undefined;
}

/** `1.85`, `1.85.0` or `1.85.0-x86_64-unknown-linux-gnu` → minor version of Rust 1.x; undefined for channels. */
function rustMinor(toolchain: string | undefined): number | undefined {
  const match = /^1\.(\d+)(?:\.\d+)?(?:-[A-Za-z0-9_-]+)?$/.exec(toolchain?.trim() ?? "");
  return match ? Number(match[1]) : undefined;
}

/** Channel of a `rust-toolchain` (legacy plain or TOML) or `rust-toolchain.toml` file. */
function fileChannel(content: string): string | undefined {
  const toml = /^\s*channel\s*=\s*["']([^"']+)["']/m.exec(content);
  if (toml) return toml[1];
  if (/^\s*\[toolchain\]/m.test(content)) return undefined;
  return content.split("\n").map((line) => line.trim()).find((line) => line !== "");
}

/** Toolchain a job's installer steps select (only when exactly one unambiguous choice exists). */
function installedToolchain(ctx: JobContext, command: JobCommand): string | undefined {
  const found = new Set<string>();
  for (const { step, owner } of ctx.entries.slice(0, entryIndex(ctx, command))) {
    if (step.if || owner.if) return undefined;
    const input = step.with.get("toolchain");
    const literal = input !== undefined && input.kind === "literal" ? text(input.value) : undefined;
    if (usesAction(step, "dtolnay/rust-toolchain")) {
      const ref = step.uses?.action.ref;
      found.add(literal ?? (ref !== undefined && ref !== "master" ? ref : ""));
    } else if (usesAction(step, "actions-rs/toolchain")) {
      if (isTrue(step.with.get("override")?.value) || isTrue(step.with.get("default")?.value)) found.add(literal ?? "");
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** Rust 1.x minor version a cargo command uses, when statically known. */
function toolchainMinor(project: ProjectModel, ctx: JobContext, command: JobCommand, cargo: CargoCommand, dir: string): number | undefined {
  const plus = cargo.prefix.find((word) => word.startsWith("+"));
  if (plus !== undefined) return rustMinor(plus.slice(1));
  const env = effectiveEnv(ctx, command, command);
  if (env.has("RUSTUP_TOOLCHAIN")) return rustMinor(env.get("RUSTUP_TOOLCHAIN"));
  let current: string | undefined = dir;
  while (current !== undefined) {
    for (const name of ["rust-toolchain", "rust-toolchain.toml"]) {
      const file = project.files.get(inDir(current, name));
      if (file !== undefined) return rustMinor(fileChannel(file.content));
    }
    current = current === "" ? undefined : dirname(current);
  }
  return rustMinor(installedToolchain(ctx, command));
}

function devProfile(cargo: CargoCommand): boolean {
  return (
    cargo.subcommand !== "bench" &&
    !cargo.args.some((word) => word === "--release" || word === "-r" || word === "--profile" || word.startsWith("--profile="))
  );
}

function describe(name: Variable, setting: Setting): string {
  return setting.origin === "yaml" ? `\`${name}: ${setting.value}\`` : `\`${name}=${setting.value}\``;
}

export default defineRule({
  meta: {
    id: "toolchains/rust-cargo-incremental-in-ci",
    ruleset: "toolchains",
    description: "CI jobs that cache Cargo's `target/` directory should not compile with incremental compilation enabled.",
    rationale:
      "Incremental compilation writes session data that can help subsequent builds, including multiple compilations within the same CI job. Persisting it across runs may cost more than it saves; Swatinem/rust-cache removes it before saving. CARGO_INCREMENTAL=1 forces it on regardless of profile settings. Cargo 1.99 introduced a CI default of off, while older dev/test profiles default on absent overrides. Paths and cache behavior depend on toolchain/action versions. Benchmark before disabling incremental compilation; this is a tradeoff, not proof of wasted work.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://doc.rust-lang.org/cargo/reference/config.html#buildincremental",
      "https://doc.rust-lang.org/cargo/reference/environment-variables.html#environment-variables-cargo-reads",
      "https://doc.rust-lang.org/cargo/reference/profiles.html#incremental",
      "https://doc.rust-lang.org/cargo/CHANGELOG.html#cargo-199-2026-10-01",
      "https://github.com/Swatinem/rust-cache#cache-details",
    ],
    impact: "low",
    fixable: false,
    example: {
      bad: "- uses: Swatinem/rust-cache@v2\n- run: cargo test\n  env:\n    CARGO_INCREMENTAL: 1",
      good: "- uses: Swatinem/rust-cache@v2\n- run: cargo test\n  env:\n    CARGO_INCREMENTAL: 0",
    },
  },
  check({ project, report }) {
    const seen = new Set<string>();
    for (const ctx of jobContexts(project)) {
      let absenceReported = false;
      for (const { command, words: list } of toolCommands(ctx, "cargo")) {
        const cargo = parseCargo(list);
        if (cargo === undefined || !COMPILING.has(cargo.subcommand)) continue;
        const preceding = ctx.entries.slice(0, entryIndex(ctx, command)).filter(({ step, owner }) => !step.if && !owner.if);
        const direct = preceding.some(({ step }) => isRustCache(step));
        const bundled = preceding.some(({ step }) => isSetupRust(step) && !isFalse(step.with.get("cache")?.value));
        const rustCache = direct || bundled;
        const targetCache = preceding.find(({ step }) => cachesTarget(step));
        if (!rustCache && !targetCache) continue;
        const cacheName = direct ? "Swatinem/rust-cache" : bundled ? "actions-rust-lang/setup-rust-toolchain (which runs Swatinem/rust-cache)" : (targetCache?.step.uses?.value.replace(/@.*$/, "") ?? "actions/cache");
        const raw = command.command.trim();
        const env = resolve(project, ctx, command);
        const forced = forcedOn(env);
        if (list.some((word) => word === "--config" || word.startsWith("--config=")) && forced?.name !== "CARGO_INCREMENTAL") continue;
        if (forced) {
          const { name, setting } = forced;
          const key = `incremental:${setting.path}:${setting.line ?? command.line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const consequence = rustCache
            ? `${cacheName} normally sets \`CARGO_INCREMENTAL=0\` and deletes incremental artifacts before saving; the data can still be reused by subsequent compilations within this job`
            : `rustc writes incremental session data for the workspace crates under \`target/\`, and \`${cacheName}\` saves and restores it with the rest of the target directory`;
          report({
            path: setting.path,
            line: setting.line ?? command.line,
            key,
            message: `${describe(name, setting)} forces incremental compilation on for \`${raw}\` in a job that caches \`target/\`: ${consequence}.`,
            suggestion: `Compare representative job time and cache transfer size with \`CARGO_INCREMENTAL: 0\` before changing the policy. Multiple compilations within a job may benefit from keeping it on. Cargo 1.99+ already defaults to off when CI is detected, absent overrides.`,
            ...(setting.path !== command.path || setting.line !== command.line
              ? { related: [{ path: command.path, line: command.line }] }
              : {}),
          });
          continue;
        }
        if (rustCache || env.has("CARGO_INCREMENTAL") || env.has("CARGO_BUILD_INCREMENTAL")) continue;
        const dir = commandDirectory(ctx, command);
        if (dir === undefined || list.some((word) => /[$`]/.test(word))) continue;
        const config = configFor(project, dir);
        const effective = effectiveEnv(ctx, command, command);
        if (effective.has("CARGO_HOME") || effective.has("CARGO_TARGET_DIR") || effective.has("CARGO_BUILD_BUILD_DIR") ||
            effective.get("CARGO_INCREMENTAL") === "${unknown}" || effective.get("CARGO_BUILD_INCREMENTAL") === "${unknown}") continue;
        const cacheLine = targetCache?.step.line ?? command.line;
        const cachePath = targetCache?.path ?? command.path;
        if (config?.value === true) {
          const key = `incremental-config:${config.path}:${ctx.workflow.path}:${ctx.job.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          report({
            path: command.path,
            line: command.line,
            key,
            message: `\`${config.path}\` sets \`build.incremental = true\`, which turns incremental compilation on for every profile of \`${raw}\` (overriding Cargo's CI default), and \`${cacheName}\` saves the resulting incremental session data with \`target/\`.`,
            suggestion: `Keep the setting for local development but override it in CI, where \`CARGO_INCREMENTAL\` takes precedence over the config file:\n\njobs:\n  ${ctx.job.id}:\n    env:\n      CARGO_INCREMENTAL: 0`,
            related: [{ path: config.path, line: config.line }],
          });
          continue;
        }
        if (config !== undefined || absenceReported || !devProfile(cargo)) continue;
        if ([...project.files.values()].some((file) => /(?:^|\/)Cargo\.toml$/.test(file.path) && /\bincremental\s*=/.test(file.content)) ||
            [...effectiveEnv(ctx, command, command).keys()].some((name) => /^CARGO_PROFILE_/.test(name))) continue;
        const minor = toolchainMinor(project, ctx, command, cargo, dir);
        if (minor === undefined || minor >= CI_DEFAULT_OFF_MINOR) continue;
        absenceReported = true;
        report({
          path: cachePath,
          line: cacheLine,
          key: `incremental-default:${ctx.workflow.path}:${ctx.job.id}`,
          message: `\`${cacheName}\` caches \`target/\` while \`${raw}\` builds with the dev profile on Rust 1.${minor}, where incremental compilation is on by default (Cargo turns it off in CI only from 1.99), so incremental session data for the workspace crates is written and then saved and restored with the cache.`,
          suggestion: `Disable incremental compilation for this job, or switch to Swatinem/rust-cache, which does so and also strips workspace artifacts before saving:\n\njobs:\n  ${ctx.job.id}:\n    env:\n      CARGO_INCREMENTAL: 0`,
          related: [{ path: command.path, line: command.line }],
        });
      }
    }
  },
});
