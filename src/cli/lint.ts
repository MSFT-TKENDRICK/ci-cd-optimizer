import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { CONFIG_PATHS, DEFAULT_CONFIG, didYouMean, parseConfigText, PRESETS, type ConfigProblem, type LintConfig } from "../lint/config.js";
import { docsUrl, exceedsThreshold, filterInput, fingerprint, lint as runLint, type LintOptions } from "../lint/engine.js";
import { applyFixes } from "../lint/fix.js";
import { format, FORMATS, sarif, type FormatName } from "../lint/formatters/index.js";
import { changedSince, isInventoryPath, loadDirectory, loadGitRevision } from "../lint/inventory.js";
import { allRules } from "../lint/rules/index.js";
import type { ActiveSeverity, AnyRule, ChangeContext, Diagnostic, LintResult, Preset, Severity, SourceFile, UnusedDirective } from "../lint/types.js";
import { effectiveSeverities, explainRuleText, isGlob, LintInputError, selects, toSelector, unknownRuleMessage, withFile } from "../lint/workspace.js";
import { matchesGlob } from "../utils.js";
import { VERSION } from "../version.js";
import { resolvePath, UsageError, writeText, type CliIO } from "./io.js";
import { loadLocalRules } from "./local-rules.js";

export const LINT_HELP = `Usage: ci-cd-optimizer lint [paths...] [options]
       cicd-lint [paths...] [options]

Lints GitHub Actions workflows, Dockerfiles, Nix expressions/flakes, and package/toolchain configuration.
Findings are static recommendations, not proofs of runtime behavior or performance.

With no paths the current directory is the lint root, and a single directory argument becomes the root. Any other
paths are files, directories, or globs relative to the root (--root, default: the current directory). They filter
the report only: the whole root is still analyzed, because many rules compare files with each other.

Options:
  -c, --config <file>       Configuration file (default: .github/ci-cd-optimizer.yml under the root)
      --root <dir>          Lint root when paths are given (default: the current directory)
  -f, --format <name>       ${FORMATS.join(" | ")} (default: stylish)
  -o, --output <file>       Write the report to a file instead of stdout
      --sarif <file>        Also write a SARIF 2.1.0 report (for code scanning)
      --preset <name>       Replace the configured presets (repeatable): ${PRESETS.join(", ")}
      --rule <id>=<sev>     Override a rule severity (repeatable): off | info | warn | error
      --ruleset <id>=<sev>  Override every rule in a ruleset (repeatable)
      --fail-on <sev>       Exit 1 at this severity or above: info | warn | error | never
      --max-warnings <n>    Exit 1 when more than n warnings are reported
      --base <ref>          Compare with a git ref; only findings this change introduces are reported
      --scope <scope>       all | changed | introduced (default: introduced with --base, else all)
      --fix                 Apply available autofixes in place; review and test the resulting diff
  -q, --quiet               Report errors only
      --stdin               Lint standard input in place of the file named by --stdin-filename
      --stdin-filename <p>  Root-relative path of the --stdin content (decides which rules apply)
      --report-unused-disable-directives [warn|error|off]
                            Report cicd-optimizer-disable comments that suppressed nothing (off unless given;
                            the flag alone means warn)
      --allow-local-rules   Load the configuration's localRules modules (runs repository code: trusted repos only)
      --list-rules          List rules (id, default severity, fixable, description) and exit
      --explain <rule-id>   Explain a rule (rationale, example, effective severity, docs) and exit
      --print-config        Print the effective configuration and rule severities as JSON and exit
      --init                Create a starter configuration file (at -c <file> if given) and exit
  -h, --help                Show this help

Exit codes: 0 nothing at or above --fail-on, 1 findings at or above --fail-on (default: error) or more than
--max-warnings warnings, 2 usage or configuration error.
`;

const SEVERITIES: Severity[] = ["off", "info", "warn", "error"];
const RANK: Record<ActiveSeverity, number> = { info: 1, warn: 2, error: 3 };
const UNUSED_FLAG = "--report-unused-disable-directives";

export const UNUSED_DIRECTIVE_RULE_ID = "cicd-optimizer/unused-disable-directive";

/** Synthetic rule describing unused-directive reports to formatters (SARIF `driver.rules`). Not part of `allRules`. */
export const UNUSED_DIRECTIVE_RULE: AnyRule = {
  meta: {
    id: UNUSED_DIRECTIVE_RULE_ID,
    ruleset: "meta",
    description: "Suppression comments should still suppress something.",
    rationale:
      "A cicd-optimizer-disable comment that no longer matches any finding is stale: the problem it excused is gone, and the comment will silently hide the next regression on that line or in that file.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: [],
    requires: [],
    defaultOptions: {},
    references: ["https://eslint.org/docs/latest/use/command-line-interface#--report-unused-disable-directives"],
    impact: "low",
    docsUrl: "https://github.com/MSFT-TKENDRICK/ci-cd-optimizer/blob/main/docs/linter.md#suppressions",
  },
  check() {},
};

/** Written by `lint --init`; must stay valid for `parseConfigText`. */
export const STARTER_CONFIG = `# ci-cd-optimizer configuration.
# Reference: https://github.com/MSFT-TKENDRICK/ci-cd-optimizer/blob/main/docs/configuration.md
# \`cicd-lint --print-config\` shows the effective rules, \`cicd-lint --list-rules\` lists every rule id,
# and \`cicd-lint --explain <rule-id>\` explains one.
schemaVersion: 1

# Presets: ${PRESETS.join(", ")}.
extends:
  - recommended

# Exit 1 when a finding is at or above this severity: info | warn | error | never.
failOn: error

# Per-rule severity (off | info | warn | error), or [severity, { options }].
# rules:
#   workflow/job-timeout: error
#   caching/setup-cache: "off"

# Per-ruleset severity.
# rulesets:
#   hermeticity: warn

# Globs to skip. Setting this replaces the defaults (vendor, node_modules, dist, build, gh-aw .lock.yml files).
# ignorePaths:
#   - vendor/**
#   - examples/**

# Repository-local rules: JavaScript modules exporting \`local/*\` rules. They run repository code, so they load
# only with --allow-local-rules. See docs/linter.md#custom-local-rules.
# localRules:
#   - .github/cicd-rules/no-latest-tag.mjs

# Suppress findings in workflows and Dockerfiles with comments:
#   # cicd-optimizer-disable-next-line workflow/job-timeout -- release job is bounded by its environment
#   # cicd-optimizer-disable-file hermeticity
`;

function parseOverride(flag: string, value: string, known: string[]): [string, Severity] {
  const index = Math.max(value.lastIndexOf("="), value.lastIndexOf(":"));
  const id = index === -1 ? value : value.slice(0, index);
  const severity = (index === -1 ? "error" : value.slice(index + 1)) as Severity;
  if (!SEVERITIES.includes(severity)) throw new UsageError(`--${flag} ${value}: severity must be one of ${SEVERITIES.join(", ")}`);
  if (!known.includes(id)) throw new UsageError(`--${flag} ${value}: unknown ${flag}.${didYouMean(id, known)}`);
  return [id, severity];
}

/** `--report-unused-disable-directives` takes an optional value, which `parseArgs` cannot express. */
function extractUnusedFlag(args: string[]): { args: string[]; severity: ActiveSeverity | undefined } {
  const rest: string[] = [];
  let severity: ActiveSeverity | "off" | undefined;
  const valid = (value: string | undefined): value is "warn" | "error" | "off" => value === "warn" || value === "error" || value === "off";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--") {
      rest.push(...args.slice(index));
      break;
    }
    if (arg === UNUSED_FLAG) {
      const next = args[index + 1];
      if (valid(next)) {
        severity = next;
        index += 1;
      } else severity = "warn";
    } else if (arg.startsWith(`${UNUSED_FLAG}=`)) {
      const value = arg.slice(UNUSED_FLAG.length + 1);
      if (!valid(value)) throw new UsageError(`${UNUSED_FLAG} must be warn, error, or off.`);
      severity = value;
    } else rest.push(arg);
  }
  return { args: rest, severity: severity === "off" ? undefined : severity };
}

export function ruleListText(rules: readonly AnyRule[]): string {
  const width = Math.max(...rules.map((rule) => rule.meta.id.length));
  return rules
    .map((rule) => `${rule.meta.id.padEnd(width)}  ${rule.meta.defaultSeverity.padEnd(5)}  ${rule.meta.fixable ? "fix" : "   "}  ${rule.meta.description}`)
    .join("\n");
}

export interface LoadedLintConfig {
  config: LintConfig;
  path?: string;
  /** Built-in rules plus any loaded local rules. */
  rules: AnyRule[];
}

export interface LoadLintConfigOptions {
  /** Load the configuration's `localRules` modules (the lint command). Other callers leave them unloaded. */
  localRules?: boolean;
  /** `--allow-local-rules`; without it a configuration that lists localRules is a usage error. */
  allowLocalRules?: boolean;
}

function invalidConfig(path: string, problems: ConfigProblem[]): UsageError {
  return new UsageError(`Invalid configuration ${path}:\n${problems.map((problem) => `  ${problem.path || "(root)"}: ${problem.message}`).join("\n")}`);
}

export async function loadLintConfig(io: CliIO, root: string, explicit: string | undefined, options: LoadLintConfigOptions = {}): Promise<LoadedLintConfig> {
  const candidates = explicit ? [resolvePath(io, explicit)] : CONFIG_PATHS.map((path) => join(root, path));
  for (const path of candidates) {
    const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && !explicit) return undefined;
      throw new UsageError(`Cannot read configuration ${path}: ${error.message}`);
    });
    if (text === undefined) continue;
    const parsed = parseConfigText(text, allRules, path);
    if (parsed.problems.length > 0) throw invalidConfig(path, parsed.problems);
    if (parsed.migrated) io.stderr(`${path}: legacy configuration keys were migrated; run with --format json to inspect the effective rules.`);
    if (!options.localRules || parsed.config.localRules.length === 0) return { config: parsed.config, path, rules: allRules };
    if (!options.allowLocalRules) {
      throw new UsageError(`${path} lists localRules, which run JavaScript from the repository. Pass --allow-local-rules to load them (trusted repositories only).`);
    }
    const rules = [...allRules, ...(await loadLocalRules(root, parsed.config.localRules, allRules))];
    const strict = parseConfigText(text, rules, path);
    if (strict.problems.length > 0) throw invalidConfig(path, strict.problems);
    return { config: strict.config, path, rules };
  }
  return { config: structuredClone(DEFAULT_CONFIG), rules: allRules };
}

function inScope(diagnostic: Diagnostic, scope: string): boolean {
  if (scope === "all" || diagnostic.scope === undefined) return true;
  if (scope === "introduced") return diagnostic.scope === "introduced";
  return diagnostic.scope === "introduced" || diagnostic.scope === "changed-file";
}

const isDirectory = (path: string) => stat(path).then((info) => info.isDirectory(), () => false);

/** No paths or a single directory keep the original `lint [dir]` behavior; anything else filters a root's report. */
async function resolveTarget(io: CliIO, rootFlag: string | undefined, positionals: string[]): Promise<{ root: string; paths: string[] }> {
  if (rootFlag !== undefined) {
    const root = resolvePath(io, rootFlag);
    if (!(await isDirectory(root))) throw new UsageError(`--root ${rootFlag}: not a directory.`);
    return { root, paths: positionals };
  }
  const [only] = positionals;
  if (positionals.length === 1 && only !== undefined && (await isDirectory(resolvePath(io, only)))) return { root: resolvePath(io, only), paths: [] };
  return { root: resolvePath(io, "."), paths: positionals };
}

/** Rethrows the shared helpers' input errors as usage errors (exit code 2). */
function usage<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof LintInputError) throw new UsageError(error.message);
    throw error;
  }
}

async function missReason(root: string, selector: string, config: LintConfig, inventoryComplete: boolean): Promise<string> {
  if (isGlob(selector)) return "no lintable files match";
  const info = await stat(join(root, selector)).catch(() => undefined);
  if (!info) return "no such file or directory";
  if (info.isDirectory()) return "no lintable files in this directory";
  if (!isInventoryPath(selector)) return "not a file type ci-cd-optimizer lints";
  if (config.ignorePaths.some((glob) => matchesGlob(selector, glob) || matchesGlob(selector, `${glob}/**`))) return "excluded by ignorePaths";
  return inventoryComplete
    ? "not analyzed (inside a directory the inventory skips, such as node_modules or .git)"
    : "not analyzed: the inventory hit limits.maxFiles or limits.maxFileBytes";
}

function explainRule(id: string, rules: AnyRule[], severities: ReadonlyMap<string, Severity>): string {
  const text = explainRuleText(id, rules, severities);
  if (text === undefined) throw new UsageError(unknownRuleMessage("--explain", id, rules));
  return text;
}

async function initConfig(io: CliIO, root: string, explicit: string | undefined): Promise<number> {
  const target = explicit ? resolvePath(io, explicit) : join(root, ".github/ci-cd-optimizer.yml");
  const existing = explicit ? [target] : CONFIG_PATHS.map((path) => join(root, path));
  for (const path of existing) {
    if (await stat(path).then(() => true, () => false)) {
      throw new UsageError(`${path} already exists; not overwriting it. Run --print-config to see the effective configuration.`);
    }
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, STARTER_CONFIG, { encoding: "utf8", flag: "wx" });
  io.stdout(`Created ${target}`);
  return 0;
}

function unusedDirectiveDiagnostics(unused: UnusedDirective[], severity: ActiveSeverity, known: string[]): Diagnostic[] {
  return unused.map((directive) => {
    const name = `cicd-optimizer-disable-${directive.kind}`;
    const unknown = directive.ids
      .filter((id) => !known.includes(id))
      .map((id) => ` "${id}" is not a known rule or ruleset.${didYouMean(id, known)}`)
      .join("");
    const message =
      directive.ids.length === 0
        ? `Unused ${name} directive: it suppressed no problems.`
        : `Unused ${name} directive for ${directive.ids.map((id) => `"${id}"`).join(", ")}: no matching problems were suppressed.${unknown}`;
    return {
      ruleId: UNUSED_DIRECTIVE_RULE_ID,
      ruleset: "meta",
      severity,
      message,
      path: directive.path,
      line: directive.line,
      column: 1,
      suggestion: directive.ids.length === 0 ? "Remove the directive." : "Remove the unused ids (or the whole directive) so it cannot hide future problems.",
      impact: "low",
      confidence: "high",
      fingerprint: fingerprint(UNUSED_DIRECTIVE_RULE_ID, directive.path, `${directive.line}:${directive.kind}:${directive.ids.join(",")}`),
      docsUrl: UNUSED_DIRECTIVE_RULE.meta.docsUrl ?? docsUrl(UNUSED_DIRECTIVE_RULE_ID),
      kind: "practice",
    };
  });
}

const compareDiagnostics = (left: Diagnostic, right: Diagnostic) =>
  left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column || left.ruleId.localeCompare(right.ruleId);

export async function lintCommand(rawArgs: string[], io: CliIO): Promise<number> {
  const { args, severity: unusedSeverity } = extractUnusedFlag(rawArgs);
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string", short: "c" },
      root: { type: "string" },
      format: { type: "string", short: "f", default: "stylish" },
      output: { type: "string", short: "o" },
      sarif: { type: "string" },
      preset: { type: "string", multiple: true },
      rule: { type: "string", multiple: true },
      ruleset: { type: "string", multiple: true },
      "fail-on": { type: "string" },
      "max-warnings": { type: "string" },
      base: { type: "string" },
      scope: { type: "string" },
      fix: { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      stdin: { type: "boolean", default: false },
      "stdin-filename": { type: "string" },
      "allow-local-rules": { type: "boolean", default: false },
      "list-rules": { type: "boolean", default: false },
      explain: { type: "string" },
      "print-config": { type: "boolean", default: false },
      init: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(LINT_HELP);
    return 0;
  }
  const actions = [values.init && "--init", values["list-rules"] && "--list-rules", values.explain !== undefined && "--explain", values["print-config"] && "--print-config"].filter(Boolean);
  if (actions.length > 1) throw new UsageError(`${actions.join(" and ")} cannot be combined.`);
  const formatName = values.format as FormatName;
  if (!FORMATS.includes(formatName)) throw new UsageError(`--format must be one of ${FORMATS.join(", ")}.${didYouMean(values.format ?? "", FORMATS)}`);
  const scope = values.scope ?? (values.base ? "introduced" : "all");
  if (!["all", "changed", "introduced"].includes(scope)) throw new UsageError("--scope must be all, changed, or introduced.");
  if (scope !== "all" && !values.base) throw new UsageError(`--scope ${scope} needs --base to know what changed.`);
  const maxWarnings = values["max-warnings"] === undefined ? undefined : Number(values["max-warnings"]);
  if (maxWarnings !== undefined && (!Number.isInteger(maxWarnings) || maxWarnings < 0)) throw new UsageError("--max-warnings must be a non-negative integer.");
  const stdinFilename = values["stdin-filename"];
  if (stdinFilename !== undefined && !values.stdin) throw new UsageError("--stdin-filename only applies with --stdin.");
  if (values.stdin) {
    if (stdinFilename === undefined) throw new UsageError("--stdin needs --stdin-filename <path> to decide which rules apply.");
    if (positionals.length > 0) throw new UsageError("--stdin lints only --stdin-filename; use --root <dir> instead of a path argument.");
    if (values.fix) throw new UsageError("--fix cannot be combined with --stdin.");
  }

  const { root, paths } = await resolveTarget(io, values.root, positionals);
  if (values.init) return await initConfig(io, root, values.config);

  const loaded = await loadLintConfig(io, root, values.config, { localRules: true, allowLocalRules: values["allow-local-rules"] });
  const { config, rules } = loaded;
  const presets = values.preset?.map((preset) => {
    if (!PRESETS.includes(preset as Preset)) throw new UsageError(`--preset ${preset}: unknown preset.${didYouMean(preset, PRESETS)}`);
    return preset as Preset;
  });
  const ruleIds = rules.map((rule) => rule.meta.id);
  const rulesets = [...new Set(rules.map((rule) => rule.meta.ruleset))];
  for (const value of values.ruleset ?? []) {
    const [id, severity] = parseOverride("ruleset", value, rulesets);
    config.rulesets = { ...config.rulesets, [id]: severity };
  }
  for (const value of values.rule ?? []) {
    const [id, severity] = parseOverride("rule", value, ruleIds);
    config.rules = { ...config.rules, [id]: severity };
  }
  if (values["fail-on"] !== undefined) {
    if (!["info", "warn", "error", "never"].includes(values["fail-on"])) throw new UsageError("--fail-on must be info, warn, error, or never.");
    config.failOn = values["fail-on"] as LintConfig["failOn"];
  }

  if (values["list-rules"]) {
    await writeText(io, values.output, ruleListText(rules));
    return 0;
  }
  const severities = effectiveSeverities(config, rules, presets);
  if (values.explain !== undefined) {
    const withMeta = new Map(severities).set(UNUSED_DIRECTIVE_RULE_ID, unusedSeverity ?? "off");
    await writeText(io, values.output, explainRule(values.explain, [...rules, UNUSED_DIRECTIVE_RULE], withMeta));
    return 0;
  }
  if (values["print-config"]) {
    const effective = presets ? { ...config, extends: presets } : config;
    await writeText(io, values.output, JSON.stringify({ configPath: loaded.path ?? null, config: effective, rules: Object.fromEntries(severities) }, null, 2));
    return 0;
  }

  let selectors = paths.map((path) => usage(() => toSelector(root, path, "Path")));
  let stdinFile: SourceFile | undefined;
  if (values.stdin && stdinFilename !== undefined) {
    if (!io.stdin) throw new UsageError("--stdin is not available in this environment.");
    const path = usage(() => toSelector(root, stdinFilename, "--stdin-filename"));
    if (path === "" || isGlob(path)) throw new UsageError("--stdin-filename must name a file, not a directory or glob.");
    stdinFile = { path, content: await io.stdin() };
    selectors = [path];
  }
  const selected = (path: string) => selectors.length === 0 || selectors.some((selector) => selects(selector, path));

  let baseFingerprints: Set<string> | undefined;
  let change: ChangeContext | undefined;
  if (values.base) {
    try {
      change = await changedSince(root, values.base);
      const baseInput = await loadGitRevision(root, change.baseSha ?? values.base, config);
      baseFingerprints = new Set(runLint(baseInput, { config, rules, ...(presets ? { presets } : {}) }).diagnostics.map((diagnostic) => diagnostic.fingerprint));
    } catch (error) {
      throw new UsageError(`--base ${values.base}: ${(error as Error).message.split("\n")[0]}`);
    }
  }

  const options: LintOptions = {
    config,
    rules,
    ...(presets ? { presets } : {}),
    ...(baseFingerprints ? { baseFingerprints } : {}),
    reportUnusedDirectives: unusedSeverity !== undefined,
  };
  const load = async () => {
    const onDisk = await loadDirectory(root, config, change);
    return stdinFile ? usage(() => withFile(onDisk, stdinFile, config.limits)) : onDisk;
  };
  let input = await load();
  let result: LintResult = runLint(input, options);

  if (values.fix) {
    const truncated = new Set(input.truncated);
    const fixable = result.diagnostics.filter((diagnostic) => diagnostic.fix && !truncated.has(diagnostic.path) && inScope(diagnostic, scope) && selected(diagnostic.path));
    if (fixable.length > 0) {
      const fixed = applyFixes(input.files, fixable);
      const original = new Map(input.files.map((file) => [file.path, file.content]));
      let written = 0;
      for (const [path, content] of fixed.files) {
        if (original.get(path) === content || truncated.has(path)) continue;
        await writeFile(join(root, path), content, "utf8");
        written += 1;
      }
      io.stderr(`Applied ${fixed.applied.length} fix(es) to ${written} file(s)${fixed.conflicts.length ? `; ${fixed.conflicts.length} overlapping fix(es) skipped, run --fix again` : ""}.`);
      input = await load();
      result = runLint(input, options);
    }
  }

  if (stdinFile && stdinFilename !== undefined) {
    if (!isInventoryPath(stdinFile.path)) io.stderr(`${stdinFilename}: not a file type ci-cd-optimizer lints; nothing to report.`);
    else if (!filterInput(input, config.ignorePaths).files.some((file) => file.path === stdinFile.path)) io.stderr(`${stdinFilename}: excluded by ignorePaths; nothing to report.`);
  } else if (selectors.length > 0) {
    const analyzed = filterInput(input, config.ignorePaths).files.map((file) => file.path);
    let matchedAny = false;
    for (const [index, selector] of selectors.entries()) {
      if (analyzed.some((path) => selects(selector, path))) matchedAny = true;
      else io.stderr(`${paths[index] ?? selector}: ${await missReason(root, selector, config, input.inventoryComplete)}.`);
    }
    if (!matchedAny) io.stderr("No lintable files matched the given paths; nothing to report.");
  }

  const minimum: ActiveSeverity = values.quiet ? "error" : "info";
  const visible = (diagnostic: Diagnostic) => RANK[diagnostic.severity] >= RANK[minimum] && selected(diagnostic.path);
  const diagnostics = result.diagnostics.filter((diagnostic) => inScope(diagnostic, scope) && visible(diagnostic));
  let unusedDirectives = result.unusedDirectives?.filter((directive) => selected(directive.path));
  if (unusedSeverity !== undefined && unusedDirectives) {
    // Directives carry no base fingerprint, so narrowed scopes keep only those in files this change touched.
    const changed = scope !== "all" && change ? new Set(change.changedPaths) : undefined;
    if (changed) unusedDirectives = unusedDirectives.filter((directive) => changed.has(directive.path));
    const known = [...ruleIds, ...rulesets];
    diagnostics.push(...unusedDirectiveDiagnostics(unusedDirectives, unusedSeverity, known).filter(visible));
    diagnostics.sort(compareDiagnostics);
  }
  const shown: LintResult = {
    ...result,
    diagnostics,
    parseProblems: result.parseProblems.filter((problem) => selected(problem.path)),
    ...(unusedDirectives ? { unusedDirectives } : {}),
  };
  if (!input.inventoryComplete) io.stderr("Inventory is incomplete; rules requiring complete inventory were skipped.");

  const reportRules = [...rules, UNUSED_DIRECTIVE_RULE];
  await writeText(io, values.output, format(formatName, shown, reportRules, VERSION));
  if (values.sarif) await writeText(io, values.sarif, sarif(shown, reportRules, VERSION));

  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warn").length;
  if (exceedsThreshold(diagnostics, config.failOn)) return 1;
  if (maxWarnings !== undefined && warnings > maxWarnings) {
    io.stderr(`Too many warnings (${warnings}); maximum allowed is ${maxWarnings}.`);
    return 1;
  }
  return 0;
}
