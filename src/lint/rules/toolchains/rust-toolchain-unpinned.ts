import type { Sourced, StepModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import { basename, isFalse, usesAction } from "../caching/shared.js";
import { defineRule, stepLine } from "../helpers.js";
import { commandDirectory, effectiveEnv, escapeRegExp, findUp, jobContexts, toolCommands, type JobContext } from "./shared.js";

const TOOLCHAIN_FILES = new Set(["rust-toolchain", "rust-toolchain.toml"]);
/** rustup subcommands (as word sequences) whose positional arguments are toolchain names that get installed or selected. */
const RUSTUP_INSTALLERS = [["default"], ["toolchain", "install"], ["toolchain", "add"], ["install"], ["update"], ["override", "set"]];
const RUSTUP_VALUE_OPTIONS = new Set(["--profile", "-c", "--component", "-t", "--target", "--path"]);
const EXAMPLE_VERSION = "1.89.0";

type Kind = "floating" | "pinned" | "unknown";

interface Selection {
  kind: Kind;
  channel: string;
  path: string;
  line: number;
  /** How the toolchain is selected, as written (for messages). */
  label: string;
  /** Exact replacement for the offending line or input. */
  replacement: string;
  step: StepModel;
}

/**
 * `stable`/`beta`/`nightly` (optionally with a host triple) float; `1.89`, `1.89.0` and dated channels such as
 * `nightly-2025-01-01` are pinned. Expressions, SHAs and relative forms (`stable 18 months ago`) are unknown.
 */
function classify(channel: string): Kind {
  const value = channel.trim();
  if (value === "" || /[$`{}\s]/.test(value)) return "unknown";
  if (/^1\.\d+(?:\.\d+)?(?:-[A-Za-z0-9_-]+)?$/.test(value)) return "pinned";
  if (/^(?:stable|beta|nightly)-\d{4}-\d{2}-\d{2}(?:-[A-Za-z0-9_-]+)?$/.test(value)) return "pinned";
  if (/^(?:stable|beta|nightly)(?:-[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)?$/.test(value)) return "floating";
  return "unknown";
}

function literal(input: Sourced<unknown> | undefined): string | undefined {
  if (input === undefined) return undefined;
  if (input.kind !== "literal") return "${{ }}";
  return typeof input.value === "string" || typeof input.value === "number" ? String(input.value).trim() : "${{ }}";
}

/** Toolchains a step selects through a toolchain-installer action (empty when it is not one). */
function actionSelections(step: StepModel, path: string): Selection[] {
  const uses = step.uses?.value ?? "";
  const input = step.with.get("toolchain");
  const value = literal(input);
  const at = (line: number | undefined, label: string, channel: string, replacement: string): Selection => ({
    kind: classify(channel),
    channel,
    path,
    line: line ?? stepLine(step),
    label,
    replacement,
    step,
  });
  if (usesAction(step, "dtolnay/rust-toolchain")) {
    if (value !== undefined) {
      return [at(input?.line, `\`toolchain: ${value}\` on \`${uses}\``, value, `toolchain: ${EXAMPLE_VERSION}`)];
    }
    const ref = step.uses?.action.ref ?? "";
    if (ref === "master" || /^[0-9a-f]{40}$/i.test(ref)) return [];
    return [at(step.uses?.line, `\`uses: ${uses}\``, ref, `uses: dtolnay/rust-toolchain@${EXAMPLE_VERSION}`)];
  }
  if (usesAction(step, "actions-rs/toolchain")) {
    if (value === undefined) return [];
    return [at(input?.line, `\`toolchain: ${value}\` on \`${uses}\``, value, `toolchain: ${EXAMPLE_VERSION}`)];
  }
  if (usesAction(step, "actions-rust-lang/setup-rust-toolchain")) {
    if (value === undefined) {
      return [at(step.uses?.line, `\`uses: ${uses}\` without a \`toolchain\` input`, "stable", `toolchain: ${EXAMPLE_VERSION}`)];
    }
    // A comma-separated list: everything is installed and the last entry becomes the override.
    const last = value.split(",").map((entry) => entry.trim()).filter(Boolean).at(-1) ?? "";
    return [at(input?.line, `\`toolchain: ${value}\` on \`${uses}\``, last, `toolchain: ${EXAMPLE_VERSION}`)];
  }
  return [];
}

/** Toolchain names a `rustup` command installs or selects. */
function rustupSelections(list: string[]): string[] | undefined {
  const args = list.slice(1).filter((word) => !word.startsWith("+"));
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? "";
    if (word === "--") break;
    if (word.startsWith("-")) {
      if (RUSTUP_VALUE_OPTIONS.has(word)) index += 1;
      continue;
    }
    positionals.push(word);
  }
  for (const prefix of RUSTUP_INSTALLERS) {
    if (prefix.every((word, index) => positionals[index] === word)) return positionals.slice(prefix.length);
  }
  return undefined;
}

function selections(ctx: JobContext): Selection[] {
  const result = ctx.entries.flatMap(({ step, path }) => actionSelections(step, path));
  for (const { command, words: list } of toolCommands(ctx, "rustup")) {
    const names = rustupSelections(list);
    if (names === undefined) continue;
    for (const name of names) {
      result.push({
        kind: classify(name),
        channel: name,
        path: command.path,
        line: command.line,
        label: `\`${command.command.trim()}\``,
        replacement: command.command.trim().replace(new RegExp(`(?<![\\w.-])${escapeRegExp(name)}(?![\\w.-])`), EXAMPLE_VERSION),
        step: command.step,
      });
    }
  }
  return result;
}

/** True when the job picks its toolchain some other way (`cargo +x`, or `RUSTUP_TOOLCHAIN`, which outranks the default). */
function selectsOwnToolchain(ctx: JobContext): boolean {
  if (toolCommands(ctx, "cargo", "cross").some(({ words: list }) => list[1]?.startsWith("+"))) return true;
  if (ctx.entries.some((entry) => effectiveEnv(ctx, entry).has("RUSTUP_TOOLCHAIN"))) return true;
  return ctx.commands.some((command) => effectiveEnv(ctx, command, command).has("RUSTUP_TOOLCHAIN"));
}

/** The job's Rust build cache whose key includes the rustc version, if any. */
function rustCache(ctx: JobContext): string | undefined {
  for (const { step } of ctx.entries) {
    if (usesAction(step, "swatinem/rust-cache")) return "Swatinem/rust-cache";
    if (usesAction(step, "actions-rust-lang/setup-rust-toolchain")) {
      const cache = step.with.get("cache");
      if (cache === undefined || (cache.kind === "literal" && !isFalse(cache.value))) {
        return "actions-rust-lang/setup-rust-toolchain (which runs Swatinem/rust-cache)";
      }
    }
  }
  return undefined;
}

function hasToolchainFile(project: ProjectModel, ctx: JobContext): boolean {
  const commands = toolCommands(ctx, "cargo", "cross");
  if (commands.length === 0) return [...TOOLCHAIN_FILES].some((name) => project.files.has(name));
  return commands.every(({ command }) => {
    const dir = commandDirectory(ctx, command);
    return dir === undefined || [...TOOLCHAIN_FILES].some((name) => findUp(project, dir, name) !== undefined);
  });
}

function hasCargoManifest(project: ProjectModel): boolean {
  for (const path of project.files.keys()) if (basename(path) === "Cargo.toml") return true;
  return false;
}

function suggestion(selection: Selection): string {
  const setup = usesAction(selection.step, "actions-rust-lang/setup-rust-toolchain");
  const file = `[toolchain]\nchannel = "${EXAMPLE_VERSION}"`;
  const pin = `Pin the release CI should use (\`rustc --version\` prints the one it gets today), for example:\n\n${selection.replacement}`;
  if (setup) {
    return `${pin}\n\nor commit \`rust-toolchain.toml\` and drop the \`toolchain\` input (setup-rust-toolchain then installs the file's toolchain, and local builds use it too):\n\n${file}\n\nUpgrade by changing the version in a pull request.`;
  }
  return `${pin}\n\nor commit \`rust-toolchain.toml\` so rustup selects the same release for CI and local builds (it takes precedence over the default toolchain the installer sets):\n\n${file}\n\nUpgrade by changing the version in a pull request.`;
}

export default defineRule({
  meta: {
    id: "toolchains/rust-toolchain-unpinned",
    ruleset: "toolchains",
    description: "CI should build Rust with a pinned toolchain release rather than the floating `stable`/`nightly` channel.",
    rationale:
      "Floating stable/beta/nightly selections can pick newer compiler and bundled-tool releases without a repository change. Deliberate compatibility jobs may want this. A reviewed version/date selection constrains the toolchain but does not prove reproducibility. Rust cache keys can incorporate compiler identity, while fallback/seeded entries may still provide reuse. Scoped toolchain files and explicit command/environment overrides take precedence according to rustup and installer behavior.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://rust-lang.github.io/rustup/overrides.html#the-toolchain-file",
      "https://github.com/dtolnay/rust-toolchain#inputs",
      "https://github.com/actions-rust-lang/setup-rust-toolchain#inputs",
      "https://github.com/Swatinem/rust-cache#cache-details",
    ],
    impact: "medium",
    fixable: false,
    example: {
      bad: "# Cargo.toml present, no rust-toolchain.toml\n- uses: dtolnay/rust-toolchain@stable\n- uses: Swatinem/rust-cache@v2\n- run: cargo test --locked",
      good: "# rust-toolchain.toml\n[toolchain]\nchannel = \"1.89.0\"\n\n# workflow\n- uses: dtolnay/rust-toolchain@1.89.0\n- uses: Swatinem/rust-cache@v2\n- run: cargo test --locked",
    },
  },
  check({ project, report }) {
    if (!hasCargoManifest(project)) return;
    const contexts = jobContexts(project).map((ctx) => ({ ctx, found: selections(ctx) }));
    // A workflow that also installs a pinned or matrix-driven toolchain is deliberately testing several releases
    // (an MSRV job next to a latest-stable job), so its floating channel is intentional.
    const deliberate = new Set(
      contexts.filter(({ found }) => found.some((selection) => selection.kind !== "floating")).map(({ ctx }) => ctx.workflow.path),
    );
    const reported = new Set<string>();
    for (const { ctx, found } of contexts) {
      if (deliberate.has(ctx.workflow.path) || found.length === 0 || selectsOwnToolchain(ctx) || hasToolchainFile(project, ctx)) continue;
      const cache = rustCache(ctx);
      if (cache === undefined && toolCommands(ctx, "cargo", "cross").length === 0) continue;
      // Nightly/beta jobs are usually deliberate (nightly-only tooling, forward-compatibility checks); only their cache churn is reported.
      const selection = found.find((candidate) => candidate.channel.startsWith("stable") || cache !== undefined);
      if (selection === undefined) continue;
      const where = `${selection.path}:${selection.line}`;
      if (reported.has(where)) continue;
      reported.add(where);
      const channel = selection.channel.replace(/-.*$/, "");
      const consequence =
        cache === undefined
          ? "so the compiler and its bundled Clippy and rustfmt change whenever a new release ships, and a commit that passed can fail (for example on a new lint) without any change to the repository."
          : `so the compiler and bundled tools can change after a new release; \`${cache}\` can include compiler identity in its cache key, although fallback or seeded caches may still provide reuse.`;
      report({
        path: selection.path,
        line: selection.line,
        key: `rust-toolchain:${selection.path}:${selection.line}`,
        message: `${selection.label} selects the floating \`${channel}\` Rust toolchain without a recognized toolchain file covering these commands, ${consequence}`,
        suggestion: suggestion(selection),
        confidence: channel === "stable" ? "high" : "medium",
      });
    }
  },
});
