import { posix } from "node:path";
import type { NixFile } from "../../parsers/nix.js";
import { exprEnd, matchingClose, nixBindings } from "../../parsers/nix.js";
import type { NixFlake } from "../../project.js";
import { usesAction } from "../caching/shared.js";
import { actionVersion, defineRule } from "../helpers.js";
import type { NixInvocation, NixJob } from "./shared.js";
import { hasFlag, nestedInvocations, nixJobs, positionalArgs } from "./shared.js";

/** Outputs that `nix flake check` evaluates for the current system (and, for `checks`, builds). */
const OUTPUT_HEADS = ["checks", "packages", "devShells", "apps", "nixosConfigurations", "hydraJobs"];
const HEAD = new RegExp(`(?<![\\w'.-])(${OUTPUT_HEADS.join("|")})(?![\\w'-])`, "g");
const SYSTEM = /^(?:\$\{\}|(?:x86_64|aarch64|i686|armv[5-7]l|riscv64|powerpc64le)-(?:linux|darwin|freebsd))$/;
const IDENT = /[A-Za-z_][A-Za-z0-9_'-]*/y;
/** Tools that already evaluate (and build) flake outputs concurrently or split them into a job matrix. */
const PARALLEL_TOOLS = /\b(?:nix-fast-build|nix-eval-jobs|nix-github-actions|githubActions|devour-flake|omnix|om\s+ci)\b/;

function skipSpace(masked: string, index: number): number {
  let cursor = index;
  while (cursor < masked.length && /\s/.test(masked[cursor] ?? "")) cursor += 1;
  return cursor;
}

function matchingOpen(masked: string, close: number): number {
  let depth = 0;
  for (let index = close; index >= 0; index -= 1) {
    const char = masked[index];
    if (char === "}" || char === ")" || char === "]") depth += 1;
    else if (char === "{" || char === "(" || char === "[") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The attribute path following an output head (`packages.${system}.default`), and the offset after it. */
function pathAfter(file: NixFile, start: number): { segments: string[]; end: number } | undefined {
  const { masked } = file;
  const segments: string[] = [];
  let index = skipSpace(masked, start);
  while (masked[index] === ".") {
    index = skipSpace(masked, index + 1);
    const char = masked[index];
    if (char === "$" && masked[index + 1] === "{") {
      const close = matchingClose(masked, index + 1);
      if (close < 0) return undefined;
      segments.push("${}");
      index = close + 1;
    } else if (char === '"') {
      const string = file.strings.find((entry) => entry.start === index);
      if (!string) return undefined;
      segments.push(string.interpolated ? "${}" : string.value);
      index = string.end;
    } else {
      IDENT.lastIndex = index;
      const word = IDENT.exec(masked)?.[0];
      if (!word) return undefined;
      segments.push(word);
      index += word.length;
    }
    index = skipSpace(masked, index);
  }
  return { segments, end: index };
}

/** True when the word at `index` starts a binding: preceded by `{`, `;` or `let` (comments and strings are masked). */
function atBindingStart(masked: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(masked[cursor] ?? "")) cursor -= 1;
  if (cursor < 0) return true;
  const char = masked[cursor];
  if (char === "{" || char === ";") return true;
  return masked.slice(Math.max(0, cursor - 2), cursor + 1) === "let" && !/[\w'-]/.test(masked[cursor - 3] ?? "");
}

/** Names inherited at the top level of the attribute set `{` at `open`: `inherit a b;` / `inherit (x) a b;`. */
function inheritedNames(masked: string, open: number, close: number): string[] {
  const names: string[] = [];
  let depth = 0;
  for (let index = open + 1; index < close; index += 1) {
    const char = masked[index] ?? "";
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (depth === 0 && masked.startsWith("inherit", index) && !/[\w'-]/.test(masked[index - 1] ?? "") && !/[\w'-]/.test(masked[index + 7] ?? "")) {
      let cursor = skipSpace(masked, index + 7);
      if (masked[cursor] === "(") cursor = matchingClose(masked, cursor) + 1;
      if (cursor <= 0) return names;
      const end = masked.indexOf(";", cursor);
      if (end < 0 || end > close) return names;
      names.push(...(masked.slice(cursor, end).match(/[A-Za-z_][A-Za-z0-9_'-]*/g) ?? []));
      index = end;
    }
  }
  return names;
}

/**
 * Attribute names defined by an output value: the value itself when it is an attribute set, else the attribute set
 * a function call ends with (`forAllSystems (system: { ... })`). System-named levels are skipped.
 */
function valueNames(file: NixFile, valueStart: number, valueEnd: number): string[] {
  const { masked } = file;
  let open = -1;
  const literal = /^(?:rec\s+)?\{/.exec(masked.slice(valueStart, valueStart + 8));
  if (literal) open = valueStart + literal[0].length - 1;
  else {
    let cursor = valueEnd - 1;
    while (cursor > valueStart && /[\s)]/.test(masked[cursor] ?? "")) cursor -= 1;
    if (masked[cursor] === "}") open = matchingOpen(masked, cursor);
    // Only a lambda or `let ... in` body (`system: { ... }`), not a function argument (`mkShell { ... }`).
    let before = open - 1;
    while (before > valueStart && /\s/.test(masked[before] ?? "")) before -= 1;
    const lambdaBody = masked[before] === ":" || (masked.slice(before - 1, before + 1) === "in" && !/[\w'-]/.test(masked[before - 2] ?? ""));
    if (!lambdaBody) return [];
  }
  if (open < valueStart || masked[open - 1] === "$") return [];
  const close = matchingClose(masked, open);
  const names = inheritedNames(masked, open, close);
  for (const binding of nixBindings(file, open)) {
    const name = binding.path.find((segment) => !SYSTEM.test(segment));
    if (name) names.push(name);
  }
  return names;
}

/**
 * A lower bound on the distinct outputs `nix flake check` evaluates (`checks`, `packages`, `devShells`, `apps`,
 * `nixosConfigurations`, `hydraJobs`), keyed `head.name` and merged across systems. Outputs produced by library
 * helpers that are not visible as attribute names (e.g. `self.packages` re-exported as checks) are not counted.
 */
export function countFlakeOutputs(file: NixFile): { count: number; heads: string[] } {
  const { masked } = file;
  const found = new Set<string>();
  for (const match of masked.matchAll(HEAD)) {
    const head = match[1] ?? "";
    if (!atBindingStart(masked, match.index)) continue;
    const path = pathAfter(file, match.index + head.length);
    if (!path || masked[path.end] !== "=" || masked[path.end + 1] === "=") continue;
    const named = path.segments.find((segment) => !SYSTEM.test(segment));
    if (named) {
      found.add(`${head}.${named}`);
      continue;
    }
    const valueStart = skipSpace(masked, path.end + 1);
    for (const name of valueNames(file, valueStart, exprEnd(masked, valueStart))) found.add(`${head}.${name}`);
  }
  const heads = OUTPUT_HEADS.filter((head) => [...found].some((key) => key.startsWith(`${head}.`)));
  return { count: found.size, heads };
}

/**
 * Determinate Nix evaluates `nix flake check` in parallel. nix-installer-action installs it when `determinate: true`,
 * and by default from v23 on (unknown versions are assumed to be recent).
 */
function usesDeterminateNix(job: NixJob): boolean {
  if (job.conf.some((setting) => setting.key === "eval-cores")) return true;
  return job.installers.some((step) => {
    if (usesAction(step, "determinatesystems/determinate-nix-action")) return true;
    if (!usesAction(step, "determinatesystems/nix-installer-action")) return false;
    const determinate = String(step.with.get("determinate")?.value ?? "").trim();
    if (determinate === "false") return false;
    if (determinate !== "") return true;
    const major = actionVersion(step, job.file)?.major;
    return major === undefined || major >= 23;
  });
}

/** Directory of the local flake a `nix flake check` targets, relative to the repository root; undefined for remote refs. */
function flakeDir(nix: NixInvocation, directory: string): string | undefined {
  const ref = positionalArgs(nix)[0] ?? ".";
  if (ref.includes("${{") || ref.includes("$")) return undefined;
  const local = ref.replace(/^path:/, "").replace(/[#?].*$/, "");
  if (local.includes(":") || local.startsWith("/") || local.startsWith("~")) return undefined;
  if (local !== "" && !local.startsWith(".")) return undefined;
  const joined = posix.normalize(posix.join(directory.replace(/\\/g, "/"), local || "."));
  if (joined.startsWith("..") || joined.startsWith("/")) return undefined;
  return joined === "." ? "" : joined.replace(/\/$/, "");
}

function hasDynamicMatrix(job: NixJob): boolean {
  const matrix = job.job.matrix;
  return matrix !== undefined && JSON.stringify(matrix).includes("${{");
}

/** `--flake` argument for nix-fast-build run in `directory` (repository-relative) to check the flake in `dir`. */
function flakeOption(directory: string, dir: string): string {
  const cwd = posix.normalize(directory.replace(/\\/g, "/") || ".").replace(/\/$/, "");
  const base = cwd === "." ? "" : cwd;
  if (base === dir) return "";
  if (base === "") return ` --flake ./${dir}#checks`;
  if (dir.startsWith(`${base}/`)) return ` --flake ./${dir.slice(base.length + 1)}#checks`;
  return ` --flake ${posix.join(...base.split("/").map(() => ".."), dir || ".")}#checks`;
}

export default defineRule({
  meta: {
    id: "nix/flake-check-missing-parallel-evaluator",
    ruleset: "nix",
    description: "`nix flake check` runs on a flake with many outputs without a parallel evaluator or a per-output job matrix.",
    rationale:
      "`nix flake check` walks the flake's outputs one at a time in a single-threaded evaluator (upstream Nix): it evaluates every package, dev shell, app, NixOS configuration and check for the current system, collects the check derivations, and only after the whole walk has finished hands them to one build call. On a flake with many outputs the runner's cores idle during evaluation and no build starts until the last output is evaluated. `nix-fast-build` evaluates `checks` with `nix-eval-jobs` worker processes and starts building each derivation as soon as it is evaluated, and `--skip-cached` skips outputs already in a binary cache; alternatively, nix-github-actions turns the checks into a job matrix, and Determinate Nix parallelises the evaluator itself. The output count is a lower bound read from attribute names in `flake.nix`.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["insights"],
    requires: [],
    defaultOptions: { threshold: 10 },
    validateOptions: (options) =>
      Object.entries(options)
        .filter(([key, value]) => key === "threshold" && (typeof value !== "number" || !Number.isInteger(value) || value < 2))
        .map(([key]) => `${key} must be an integer of at least 2`),
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake-check",
      "https://github.com/Mic92/nix-fast-build",
      "https://github.com/nix-community/nix-github-actions",
      "https://docs.determinate.systems/determinate-nix/parallel-eval/",
    ],
    impact: "medium",
    example: {
      bad: "- uses: cachix/install-nix-action@v31\n- run: nix flake check   # flake.nix defines 40 packages and checks",
      good: "- uses: cachix/install-nix-action@v31\n- run: nix run github:Mic92/nix-fast-build -- --skip-cached --no-nom",
    },
  },
  check({ project, options, report }) {
    const threshold = options.threshold;
    const flakes = new Map<string, NixFlake>(project.nix.flakes.map((flake) => [flake.dir, flake]));
    const counts = new Map<string, { count: number; heads: string[] }>();
    for (const model of nixJobs(project)) {
      const workflowText = project.files.get(model.workflow.path)?.content ?? "";
      if (PARALLEL_TOOLS.test(workflowText) || hasDynamicMatrix(model) || usesDeterminateNix(model)) continue;
      for (const entry of model.commands) {
        if (!entry.nix || entry.command.includes("${{") || PARALLEL_TOOLS.test(entry.command)) continue;
        const nix = nestedInvocations(entry.nix).find((invocation) => invocation.binary === "nix" && invocation.subcommand === "flake check");
        if (!nix || hasFlag(nix, "--no-build")) continue;
        const directory = entry.step.workingDirectory ?? model.job.workingDirectory ?? model.workflow.workingDirectory ?? "";
        const dir = flakeDir(nix, directory);
        const flake = dir === undefined ? undefined : flakes.get(dir);
        if (!flake?.nix || !flake.info?.outputs || PARALLEL_TOOLS.test(flake.nix.masked)) continue;
        const counted = counts.get(flake.dir) ?? countFlakeOutputs(flake.nix);
        counts.set(flake.dir, counted);
        if (counted.count < threshold) continue;
        const flakeArg = flakeOption(directory, flake.dir);
        report({
          path: entry.path,
          line: entry.line,
          key: `${model.job.key}.flake-check.${flake.dir}`,
          message: `\`${nix.command.trim()}\` in job \`${model.job.id}\` checks \`${flake.nix.path}\`, which defines at least ${counted.count} outputs (${counted.heads.join(", ")}); \`nix flake check\` evaluates them one after another and builds the checks only after the whole evaluation finishes. Consider a parallel evaluator.`,
          suggestion: `Consider evaluating and building the checks concurrently, skipping those already cached:\n- run: nix run github:Mic92/nix-fast-build -- --skip-cached --no-nom${flakeArg}\nnix-fast-build builds \`checks.<system>\` only, so expose packages and dev shells you want built as checks (e.g. \`checks = self.packages.\${system} // { shell = self.devShells.\${system}.default; }\`). Alternatives: a job matrix generated by nix-community/nix-github-actions, or Determinate Nix (DeterminateSystems/determinate-nix-action), whose evaluator runs \`nix flake check\` in parallel.`,
          confidence: "low",
        });
      }
    }
  },
});
