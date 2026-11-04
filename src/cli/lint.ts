import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { applyFixes, lint, parseConfigText } from "../lint/api.js";
import { CONFIG_PATHS, DEFAULT_CONFIG, didYouMean, PRESETS, type LintConfig } from "../lint/config.js";
import { exceedsThreshold } from "../lint/engine.js";
import { format, FORMATS, sarif, type FormatName } from "../lint/formatters/index.js";
import { changedSince, loadDirectory, loadGitRevision } from "../lint/inventory.js";
import { allRules } from "../lint/rules/index.js";
import type { ActiveSeverity, Diagnostic, LintResult, Preset, Severity } from "../lint/types.js";
import { VERSION } from "../version.js";
import { resolvePath, UsageError, writeText, type CliIO } from "./io.js";

export const LINT_HELP = `Usage: ci-cd-optimizer lint [dir] [options]

Lints GitHub Actions workflows, Dockerfiles, and package manifests for CI/CD performance and hermeticity.

Options:
  -c, --config <file>       Configuration file (default: .github/ci-cd-optimizer.yml in dir)
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
      --fix                 Apply safe autofixes in place, then report what remains
  -q, --quiet               Report errors only
`;

const SEVERITIES: Severity[] = ["off", "info", "warn", "error"];
const RANK: Record<ActiveSeverity, number> = { info: 1, warn: 2, error: 3 };

function parseOverride(flag: string, value: string, known: string[]): [string, Severity] {
  const index = Math.max(value.lastIndexOf("="), value.lastIndexOf(":"));
  const id = index === -1 ? value : value.slice(0, index);
  const severity = (index === -1 ? "error" : value.slice(index + 1)) as Severity;
  if (!SEVERITIES.includes(severity)) throw new UsageError(`--${flag} ${value}: severity must be one of ${SEVERITIES.join(", ")}`);
  if (!known.includes(id)) throw new UsageError(`--${flag} ${value}: unknown ${flag}.${didYouMean(id, known)}`);
  return [id, severity];
}

export async function loadLintConfig(io: CliIO, root: string, explicit: string | undefined): Promise<{ config: LintConfig; path?: string }> {
  const candidates = explicit ? [resolvePath(io, explicit)] : CONFIG_PATHS.map((path) => join(root, path));
  for (const path of candidates) {
    const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && !explicit) return undefined;
      throw new UsageError(`Cannot read configuration ${path}: ${error.message}`);
    });
    if (text === undefined) continue;
    const parsed = parseConfigText(text, allRules, path);
    if (parsed.problems.length > 0) {
      throw new UsageError(`Invalid configuration ${path}:\n${parsed.problems.map((problem) => `  ${problem.path || "(root)"}: ${problem.message}`).join("\n")}`);
    }
    if (parsed.migrated) io.stderr(`${path}: legacy configuration keys were migrated; run with --format json to inspect the effective rules.`);
    return { config: parsed.config, path };
  }
  return { config: structuredClone(DEFAULT_CONFIG) };
}

function inScope(diagnostic: Diagnostic, scope: string): boolean {
  if (scope === "all" || diagnostic.scope === undefined) return true;
  if (scope === "introduced") return diagnostic.scope === "introduced";
  return diagnostic.scope === "introduced" || diagnostic.scope === "changed-file";
}

export async function lintCommand(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string", short: "c" },
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
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(LINT_HELP);
    return 0;
  }
  if (positionals.length > 1) throw new UsageError("lint accepts a single directory.");
  const formatName = values.format as FormatName;
  if (!FORMATS.includes(formatName)) throw new UsageError(`--format must be one of ${FORMATS.join(", ")}.${didYouMean(values.format ?? "", FORMATS)}`);
  const scope = values.scope ?? (values.base ? "introduced" : "all");
  if (!["all", "changed", "introduced"].includes(scope)) throw new UsageError("--scope must be all, changed, or introduced.");
  if (scope !== "all" && !values.base) throw new UsageError(`--scope ${scope} needs --base to know what changed.`);
  const maxWarnings = values["max-warnings"] === undefined ? undefined : Number(values["max-warnings"]);
  if (maxWarnings !== undefined && (!Number.isInteger(maxWarnings) || maxWarnings < 0)) throw new UsageError("--max-warnings must be a non-negative integer.");

  const root = resolvePath(io, positionals[0] ?? ".");
  const { config } = await loadLintConfig(io, root, values.config);
  const presets = values.preset?.map((preset) => {
    if (!PRESETS.includes(preset as Preset)) throw new UsageError(`--preset ${preset}: unknown preset.${didYouMean(preset, PRESETS)}`);
    return preset as Preset;
  });
  const ruleIds = allRules.map((rule) => rule.meta.id);
  const rulesets = [...new Set(allRules.map((rule) => rule.meta.ruleset))];
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

  const request = { config, ...(presets ? { presets } : {}) };
  let baseFingerprints: Set<string> | undefined;
  let change;
  if (values.base) {
    try {
      change = await changedSince(root, values.base);
      const baseInput = await loadGitRevision(root, change.baseSha ?? values.base, config);
      baseFingerprints = new Set(lint({ ...request, input: baseInput }).diagnostics.map((diagnostic) => diagnostic.fingerprint));
    } catch (error) {
      throw new UsageError(`--base ${values.base}: ${(error as Error).message.split("\n")[0]}`);
    }
  }

  let input = await loadDirectory(root, config, change);
  let result: LintResult = lint({ ...request, input, ...(baseFingerprints ? { baseFingerprints } : {}) });

  if (values.fix) {
    const truncated = new Set(input.truncated);
    const fixable = result.diagnostics.filter((diagnostic) => diagnostic.fix && !truncated.has(diagnostic.path) && inScope(diagnostic, scope));
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
      input = await loadDirectory(root, config, change);
      result = lint({ ...request, input, ...(baseFingerprints ? { baseFingerprints } : {}) });
    }
  }

  const minimum: ActiveSeverity = values.quiet ? "error" : "info";
  const diagnostics = result.diagnostics.filter((diagnostic) => inScope(diagnostic, scope) && RANK[diagnostic.severity] >= RANK[minimum]);
  const shown: LintResult = { ...result, diagnostics };
  if (!input.inventoryComplete) io.stderr("Inventory was truncated by limits; rules that check for missing files were skipped.");

  await writeText(io, values.output, format(formatName, shown, allRules, VERSION));
  if (values.sarif) await writeText(io, values.sarif, sarif(shown, allRules, VERSION));

  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warn").length;
  if (exceedsThreshold(diagnostics, config.failOn)) return 1;
  if (maxWarnings !== undefined && warnings > maxWarnings) {
    io.stderr(`Too many warnings (${warnings}); maximum allowed is ${maxWarnings}.`);
    return 1;
  }
  return 0;
}
