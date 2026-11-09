import { createHash } from "node:crypto";
import { matchesGlob } from "../utils.js";
import { resolveRules, type LintConfig } from "./config.js";
import { isActionPath, isWorkflowPath } from "./parsers/workflow.js";
import { parseYaml } from "./parsers/yaml.js";
import { buildProject } from "./project.js";
import type {
  ActiveSeverity,
  AnalysisInput,
  AnyRule,
  Capability,
  Diagnostic,
  LintResult,
  Preset,
  ReportDescriptor,
  ResolvedRule,
  SkippedRule,
  SourceFile,
  UnusedDirective,
} from "./types.js";

export const DOCS_BASE = "https://github.com/MSFT-TKENDRICK/ci-cd-optimizer/blob/main/docs/rules.md";
const SEVERITY_RANK: Record<ActiveSeverity, number> = { info: 1, warn: 2, error: 3 };
const DIRECTIVE = /#\s*cicd-optimizer-disable-(next-line|file)\b([^\n]*)/;

/** Explicit anchor for a rule in docs/rules.md; GitHub's heading slugs drop the "/" in rule ids. */
export const ruleAnchor = (ruleId: string) => ruleId.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

export function docsUrl(ruleId: string): string {
  return `${DOCS_BASE}#${ruleAnchor(ruleId)}`;
}

export interface LintOptions {
  config: LintConfig;
  rules: AnyRule[];
  /** Replaces `config.extends` (CLI `--preset`). */
  presets?: Preset[];
  /** Fingerprints present on the base revision; enables `introduced` scoping. */
  baseFingerprints?: ReadonlySet<string>;
  /** Populate `LintResult.unusedDirectives` with suppression directives that suppressed nothing. */
  reportUnusedDirectives?: boolean;
}

/** One `cicd-optimizer-disable-*` comment; `used`/`usedAll` record what it actually suppressed. */
export interface SuppressionDirective {
  line: number;
  kind: "file" | "next-line";
  /** Line a `next-line` directive applies to. */
  target?: number;
  ids: string[] | "all";
  used: Set<string>;
  usedAll: boolean;
}

export interface Suppressions {
  file: Set<string> | "all" | undefined;
  lines: Map<number, Set<string> | "all">;
  directives: SuppressionDirective[];
}

function parseIds(text: string): Set<string> | "all" {
  const body = text.split(/\s--\s/)[0]?.trim() ?? "";
  if (!body) return "all";
  return new Set(body.split(/[\s,]+/).filter(Boolean));
}

function merge(existing: Set<string> | "all" | undefined, next: Set<string> | "all"): Set<string> | "all" {
  if (existing === "all" || next === "all") return "all";
  return new Set([...(existing ?? []), ...next]);
}

export function collectSuppressions(file: SourceFile): Suppressions {
  const result: Suppressions = { file: undefined, lines: new Map(), directives: [] };
  if (!file.content.includes("cicd-optimizer-disable")) return result;
  const isYaml = /\.ya?ml$/i.test(file.path);
  const blocks = isYaml ? parseYaml(file.path, file.content).blockScalarLines : [];
  const inBlock = (line: number) => blocks.some(([start, end]) => line >= start && line <= end);
  const lines = file.content.split(/\r?\n/);
  lines.forEach((text, index) => {
    const lineNumber = index + 1;
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("#") || inBlock(lineNumber)) return;
    const match = DIRECTIVE.exec(trimmed);
    if (!match) return;
    const ids = parseIds(match[2] ?? "");
    const directive: SuppressionDirective = {
      line: lineNumber,
      kind: match[1] === "file" ? "file" : "next-line",
      ids: ids === "all" ? "all" : [...ids],
      used: new Set(),
      usedAll: false,
    };
    result.directives.push(directive);
    if (match[1] === "file") {
      result.file = merge(result.file, ids);
      return;
    }
    let target = lineNumber + 1;
    while (target <= lines.length) {
      const candidate = (lines[target - 1] ?? "").trim();
      if (candidate !== "" && !candidate.startsWith("#")) break;
      target += 1;
    }
    directive.target = target;
    result.lines.set(target, merge(result.lines.get(target), ids));
  });
  return result;
}

/** Applies every directive covering the diagnostic and records which directive (and id) suppressed it. */
function suppress(entry: Suppressions, diagnostic: Diagnostic): boolean {
  let hit = false;
  for (const directive of entry.directives) {
    if (directive.kind === "next-line" && directive.target !== diagnostic.line) continue;
    if (directive.ids === "all") {
      directive.usedAll = true;
      hit = true;
      continue;
    }
    for (const id of directive.ids) {
      if (id === diagnostic.ruleId || id === diagnostic.ruleset) {
        directive.used.add(id);
        hit = true;
      }
    }
  }
  return hit;
}

/**
 * Directives (or ids within them) that suppressed nothing. Conservative: nothing is reported for a partial inventory or a
 * disabled configuration, ids naming a skipped or crashed rule (or its ruleset) are kept, and blanket directives are
 * kept whenever any rule was skipped.
 */
function unusedDirectives(
  suppressionsFor: (path: string) => Suppressions | undefined,
  paths: string[],
  skipped: SkippedRule[],
  rules: AnyRule[],
): UnusedDirective[] {
  const skippedIds = new Set(skipped.map((skip) => skip.ruleId));
  const skippedRulesets = new Set(rules.filter((rule) => skippedIds.has(rule.meta.id)).map((rule) => rule.meta.ruleset));
  const result: UnusedDirective[] = [];
  for (const path of paths) {
    for (const directive of suppressionsFor(path)?.directives ?? []) {
      if (directive.ids === "all") {
        if (!directive.usedAll && skipped.length === 0) result.push({ path, line: directive.line, kind: directive.kind, ids: [] });
        continue;
      }
      const ids = [...new Set(directive.ids)].filter((id) => !directive.used.has(id) && !skippedIds.has(id) && !skippedRulesets.has(id));
      if (ids.length > 0) result.push({ path, line: directive.line, kind: directive.kind, ids });
    }
  }
  return result;
}

function unmet(requires: Capability[], input: AnalysisInput): Capability | undefined {
  return requires.find((capability) => {
    if (capability === "repository") return input.mode !== "repository";
    if (capability === "complete-inventory") return input.mode !== "repository" || !input.inventoryComplete;
    return input.change === undefined;
  });
}

const UNMET_REASON: Record<Capability, string> = {
  repository: "needs the whole repository (run in repository mode)",
  "complete-inventory": "needs a complete file inventory; absence checks are unsafe on a partial view",
  "change-set": "needs the set of changed files (--base/--head or a pull request)",
};

export function fingerprint(ruleId: string, path: string, discriminator: string): string {
  return createHash("sha256").update(`${ruleId}\u0000${path}\u0000${discriminator}`).digest("hex").slice(0, 32);
}

function isRelevant(path: string): boolean {
  return (
    isWorkflowPath(path) ||
    isActionPath(path) ||
    /(^|\/)(Dockerfile|Containerfile)(\.[^/]+)?$/i.test(path) ||
    /\.(dockerfile|containerfile)$/i.test(path) ||
    /(^|\/)package\.json$/.test(path)
  );
}

export function filterInput(input: AnalysisInput, ignorePaths: string[]): AnalysisInput {
  return {
    ...input,
    files: input.files.filter(
      (file) => !ignorePaths.some((glob) => matchesGlob(file.path, glob) || matchesGlob(file.path, `${glob}/**`)),
    ),
  };
}

export function lint(rawInput: AnalysisInput, options: LintOptions): LintResult {
  const started = performance.now();
  const input = filterInput(rawInput, options.config.ignorePaths);
  const project = buildProject(input);
  const resolved: ResolvedRule[] = options.config.enabled
    ? resolveRules(options.config, options.rules, options.presets)
    : [];
  const skipped: SkippedRule[] = [];
  const raw: Array<Diagnostic & { discriminator: string }> = [];
  let rulesRun = 0;

  for (const { rule, severity, options: ruleOptions } of resolved) {
    const missing = unmet(rule.meta.requires, input);
    if (missing) {
      skipped.push({ ruleId: rule.meta.id, reason: UNMET_REASON[missing] });
      continue;
    }
    rulesRun += 1;
    const report = (descriptor: ReportDescriptor): void => {
      raw.push({
        ruleId: rule.meta.id,
        ruleset: rule.meta.ruleset,
        kind: rule.meta.kind,
        severity,
        message: descriptor.message,
        path: descriptor.path,
        line: Math.max(1, descriptor.line),
        column: Math.max(1, descriptor.column ?? 1),
        impact: descriptor.impact ?? rule.meta.impact,
        confidence: descriptor.confidence ?? "high",
        fingerprint: "",
        docsUrl: rule.meta.docsUrl ?? docsUrl(rule.meta.id),
        discriminator: descriptor.key ?? descriptor.message,
        ...(descriptor.suggestion !== undefined ? { suggestion: descriptor.suggestion } : {}),
        ...(descriptor.related ? { related: descriptor.related } : {}),
        ...(descriptor.fix ? { fix: descriptor.fix } : {}),
      });
    };
    try {
      rule.check({ options: ruleOptions, project, input, report });
    } catch (error) {
      skipped.push({
        ruleId: rule.meta.id,
        reason: `rule crashed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const suppressionCache = new Map<string, Suppressions>();
  const suppressionsFor = (path: string): Suppressions | undefined => {
    const file = project.files.get(path);
    if (!file) return undefined;
    let entry = suppressionCache.get(path);
    if (!entry) {
      entry = collectSuppressions(file);
      suppressionCache.set(path, entry);
    }
    return entry;
  };

  const seen = new Set<string>();
  const occurrences = new Map<string, number>();
  const diagnostics: Diagnostic[] = [];
  let suppressedCount = 0;
  for (const item of raw) {
    const dedupeKey = `${item.ruleId}\u0000${item.path}\u0000${item.line}\u0000${item.message}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const { discriminator, ...diagnostic } = item;
    const directives = suppressionsFor(diagnostic.path);
    if (directives && suppress(directives, diagnostic)) {
      suppressedCount += 1;
      continue;
    }
    const base = `${diagnostic.ruleId}\u0000${diagnostic.path}\u0000${discriminator}`;
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    diagnostic.fingerprint = fingerprint(diagnostic.ruleId, diagnostic.path, count === 0 ? discriminator : `${discriminator}#${count}`);
    diagnostics.push(diagnostic);
  }

  const change = input.change;
  if (change) {
    const changed = new Set(change.changedPaths);
    for (const diagnostic of diagnostics) {
      if (options.baseFingerprints && !options.baseFingerprints.has(diagnostic.fingerprint)) {
        diagnostic.scope = "introduced";
      } else {
        diagnostic.scope = changed.has(diagnostic.path) ? "changed-file" : "existing";
      }
    }
  }

  diagnostics.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId),
  );

  const reportUnused = options.reportUnusedDirectives === true && options.config.enabled && input.inventoryComplete;
  // Rules cannot see into a file that failed to parse, so its directives are never reported as unused.
  const unparsed = new Set(project.parseProblems.map((problem) => problem.path));
  return {
    diagnostics,
    skipped,
    parseProblems: project.parseProblems,
    filesAnalyzed: input.files.filter((file) => isRelevant(file.path)).length,
    rulesRun,
    suppressed: suppressedCount,
    durationMs: Math.round(performance.now() - started),
    ...(options.reportUnusedDirectives
      ? {
          unusedDirectives: reportUnused
            ? unusedDirectives(
                suppressionsFor,
                input.files.map((file) => file.path).filter((path) => !unparsed.has(path)),
                skipped,
                options.rules,
              )
            : [],
        }
      : {}),
  };
}

export function exceedsThreshold(diagnostics: Diagnostic[], failOn: ActiveSeverity | "never"): boolean {
  if (failOn === "never") return false;
  return diagnostics.some((diagnostic) => SEVERITY_RANK[diagnostic.severity] >= SEVERITY_RANK[failOn]);
}

export function atLeast(severity: ActiveSeverity, minimum: ActiveSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum];
}
