import type { Sourced, StepModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import { basename, isFalse, isTrue, usesAction } from "../caching/shared.js";
import { defineRule, stepLine, type JobCommand } from "../helpers.js";
import { commandDirectory, effectiveEnv, entryIndex, findUp, jobContexts, joinPath, toolCommands, withReplacedToken, type JobContext } from "./shared.js";

const TOOLCHAIN_FILES = new Set(["rust-toolchain", "rust-toolchain.toml"]);
/** Installing a toolchain alone does not select it for subsequent cargo commands. */
const RUSTUP_INSTALLERS = [["default"], ["override", "set"]];
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
  owner: StepModel;
  command?: JobCommand;
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
function actionSelections(step: StepModel, path: string, owner: StepModel): Selection[] {
  const uses = step.uses?.value ?? "";
  const input = step.with.get("toolchain");
  const value = literal(input);
  const at = (line: number | undefined, label: string, channel: string, replacement: string): Selection => ({
    kind: step.if || owner.if ? "unknown" : classify(channel),
    channel,
    path,
    line: line ?? stepLine(step),
    label,
    replacement,
    step,
    owner,
  });
  if (usesAction(step, "dtolnay/rust-toolchain")) {
    if (value !== undefined) {
      return [at(input?.line, `\`toolchain: ${value}\` on \`${uses}\``, value, `toolchain: ${EXAMPLE_VERSION}`)];
    }
    const ref = step.uses?.action.ref ?? "";
    return [at(step.uses?.line, `\`uses: ${uses}\``, ref, `uses: dtolnay/rust-toolchain@${EXAMPLE_VERSION}`)];
  }
  if (usesAction(step, "actions-rs/toolchain")) {
    const unknown = ["override", "default"].some((key) => step.with.has(key) && step.with.get(key)?.kind !== "literal");
    if (value === undefined || (!unknown && !isTrue(step.with.get("override")?.value) && !isTrue(step.with.get("default")?.value))) return [];
    const selection = at(input?.line, `\`toolchain: ${value}\` on \`${uses}\``, value, `toolchain: ${EXAMPLE_VERSION}`);
    if (unknown) selection.kind = "unknown";
    return [selection];
  }
  if (usesAction(step, "actions-rust-lang/setup-rust-toolchain")) {
    if (isFalse(step.with.get("override")?.value)) return [];
    const unknown = ["override", "rust-src-dir"].some((key) => step.with.has(key) && step.with.get(key)?.kind !== "literal");
    let selection: Selection;
    if (value === undefined) {
      selection = at(step.uses?.line, `\`uses: ${uses}\` without a \`toolchain\` input`, "stable", `toolchain: ${EXAMPLE_VERSION}`);
    } else {
      // The action installs all entries, then selects the last with a directory override.
      const last = value.split(",").map((entry) => entry.trim()).filter(Boolean).at(-1) ?? "";
      selection = at(input?.line, `\`toolchain: ${value}\` on \`${uses}\``, last, `toolchain: ${EXAMPLE_VERSION}`);
    }
    if (unknown) selection.kind = "unknown";
    return [selection];
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
  const result = ctx.entries.flatMap(({ step, path, owner }) => actionSelections(step, path, owner));
  for (const { command, words: list } of toolCommands(ctx, "rustup")) {
    const names = rustupSelections(list);
    if (names?.length !== 1 || list.some((word) => ["-h", "--help", "-V", "--version"].includes(word))) continue;
    for (const name of names) {
      result.push({
        kind: command.step.if || command.owner.if ||
          /\|\||(?:^|[\n;])\s*(?:if|then|elif|else|case|for|while|until)\b/.test(command.step.run?.value ?? "") ||
          list.some((word) => word === "--path" || word.startsWith("--path="))
          ? "unknown" : classify(name),
        channel: name,
        path: command.path,
        line: command.line,
        label: `\`${command.command.trim()}\``,
        replacement: withReplacedToken(command.command.trim(), list.lastIndexOf(name), EXAMPLE_VERSION) ??
          `# Replace only the selected ${name} argument with ${EXAMPLE_VERSION}, preserving the command's other arguments.`,
        step: command.step,
        owner: command.owner,
        command,
      });
    }
  }
  return result;
}

function rank(ctx: JobContext, selection: Selection): number {
  const entry = ctx.entries.findIndex((item) => item.step === selection.step && item.owner === selection.owner);
  return entry * (ctx.commands.length + 1) + (selection.command ? ctx.commands.indexOf(selection.command) + 1 : 0);
}

/** The job's Rust build cache whose key includes the rustc version, if any. */
function rustCache(ctx: JobContext, command: JobCommand): string | undefined {
  for (const { step, owner } of ctx.entries.slice(0, entryIndex(ctx, command))) {
    if (step.if || owner.if) continue;
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

function hasToolchainFile(project: ProjectModel, ctx: JobContext, command: JobCommand): boolean {
  const dir = commandDirectory(ctx, command);
  return dir === undefined || [...TOOLCHAIN_FILES].some((name) => findUp(project, dir, name) !== undefined);
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
    const reported = new Set<string>();
    for (const { ctx, found } of contexts) {
      // Recognize an explicitly named latest/MSRV comparison, not any unrelated pinned job in the workflow.
      if (/(?:^|[-_])(?:stable|latest|nightly|beta|compatibility)(?:[-_]|$)/i.test(ctx.job.id) &&
          contexts.some((other) => other.ctx.workflow.path === ctx.workflow.path &&
            /(?:^|[-_])msrv(?:[-_]|$)/i.test(other.ctx.job.id) && other.found.some((selection) => selection.kind === "pinned"))) continue;
      const ordered = [...found].sort((a, b) => rank(ctx, a) - rank(ctx, b));
      for (const { command, words: list } of toolCommands(ctx, "cargo", "cross")) {
        if (list.length < 2 || list.some((word) => ["-h", "--help", "-V", "--version"].includes(word))) continue;
        const env = effectiveEnv(ctx, command, command);
        if (list[1]?.startsWith("+") || ["RUSTUP_TOOLCHAIN", "RUSTUP_HOME", "HOME"].some((key) => env.has(key)) ||
            hasToolchainFile(project, ctx, command)) continue;
        if (ctx.commands.slice(0, ctx.commands.indexOf(command)).some((other) =>
          /\brustup\s+override\s+(?:unset|remove)\b/.test(other.command))) continue;
        const before = entryIndex(ctx, command) * (ctx.commands.length + 1) + ctx.commands.indexOf(command) + 1;
        const override = (candidate: Selection): boolean => candidate.command
          ? /\boverride\s+set\b/.test(candidate.command.command)
          : usesAction(candidate.step, "actions-rust-lang/setup-rust-toolchain") ||
            (usesAction(candidate.step, "actions-rs/toolchain") &&
              (isTrue(candidate.step.with.get("override")?.value) ||
                (candidate.step.with.has("override") && candidate.step.with.get("override")?.kind !== "literal")));
        const directory = (candidate: Selection): string | undefined => candidate.command
          ? commandDirectory(ctx, candidate.command)
          : usesAction(candidate.step, "actions-rust-lang/setup-rust-toolchain")
            ? joinPath("", literal(candidate.step.with.get("rust-src-dir")) ?? "") : "";
        const applicable = ordered.filter((candidate) => {
          if (rank(ctx, candidate) >= before) return false;
          if (!override(candidate)) return true;
          if (candidate.kind === "unknown") return true;
          const dir = directory(candidate);
          const target = commandDirectory(ctx, command);
          return dir !== undefined && target !== undefined && (dir === "" || target === dir || target.startsWith(`${dir}/`));
        });
        if (applicable.some((candidate) => override(candidate) && candidate.kind === "unknown")) continue;
        const selection = applicable.filter(override).sort((a, b) =>
          (directory(a)?.length ?? 0) - (directory(b)?.length ?? 0) || rank(ctx, a) - rank(ctx, b),
        ).at(-1) ?? applicable.at(-1);
        if (selection?.kind !== "floating") continue;
        const cache = rustCache(ctx, command);
        if (!selection.channel.startsWith("stable") && cache === undefined) continue;
        const where = `${selection.path}:${selection.line}`;
        if (reported.has(where)) continue;
        reported.add(where);
        const channel = selection.channel.replace(/-.*$/, "");
        const consequence = cache === undefined
          ? "so the compiler and bundled tools can change after a new release, potentially changing build or lint results without a repository change."
          : `so the compiler and bundled tools can change after a new release; \`${cache}\` can include compiler identity in its cache key, although fallback or seeded caches may still provide reuse.`;
        report({
          path: selection.path,
          line: selection.line,
          key: `rust-toolchain:${selection.path}:${selection.line}`,
          message: `${selection.label} selects the floating \`${channel}\` Rust toolchain without a recognized toolchain file covering these commands, ${consequence}`,
          suggestion: suggestion(selection),
          confidence: "medium",
        });
      }
    }
  },
});
