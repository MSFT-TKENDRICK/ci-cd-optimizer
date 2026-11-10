import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import { CONFIG_PATHS, DEFAULT_CONFIG, didYouMean, parseConfigText, PRESETS, type LintConfig } from "../lint/config.js";
import { docsUrl, filterInput, lint as runLint } from "../lint/engine.js";
import { applyFixes } from "../lint/fix.js";
import type { LoadedInput } from "../lint/inventory.js";
import { allRules, RULESETS } from "../lint/rules/index.js";
import type { ActiveSeverity, AnyRule, Diagnostic, LintResult, ParseProblem, Preset, RuleKind, Severity, SkippedRule } from "../lint/types.js";
import { effectiveSeverities, explainRuleText, LintInputError, selects, SEVERITIES, toSelector, unknownRuleMessage, withFile } from "../lint/workspace.js";
import { parseProjectText, PROJECT_FILE, PROJECT_MAX_BYTES, type Project } from "../review/project.js";
import { loadAgentDirectory, readBoundedFile, within } from "./inventory.js";
import { AgentError, LIMITS, sanitizeMarkdown } from "./safety.js";

export { AgentError } from "./safety.js";
export { within } from "./inventory.js";

/**
 * The read-only core behind the agent integrations (the `cicd-mcp` MCP server and the `cicd-acp` ACP agent). Every
 * function reads the workspace and returns plain data; none writes files, runs repository code (configured
 * `localRules` are never loaded), or contacts the network. Paths are confined to the workspace root.
 */
export const RANK: Record<ActiveSeverity, number> = { info: 1, warn: 2, error: 3 };
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
export const MAX_CONTENT_FILES = 20;
const MAX_PREVIEW_BYTES = 64 * 1024;
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;
const DRIVE = /^[a-z]:[\\/]/i;

function input<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof LintInputError) throw new AgentError(error.message);
    throw error;
  }
}

function notUrl(value: string, label: string): void {
  // eslint-disable-next-line no-control-regex -- reject control characters in path input
  if (!value || value.length > 4096 || /[\u0000-\u001f]/.test(value)) throw new AgentError(`${label} must name a file with a valid path.`);
  if (SCHEME.test(value) && !DRIVE.test(value)) throw new AgentError(`${label} "${value}" must be a path, not a URL.`);
  if (value.replace(DRIVE, "").includes(":")) throw new AgentError(`${label} must not name an alternate data stream.`);
}

/** Resolves the workspace root through symlinks; it must be an existing directory. */
export async function resolveRoot(path: string): Promise<string> {
  const real = await realpath(resolve(path)).catch(() => undefined);
  if (!real || !(await stat(real).then((info) => info.isDirectory(), () => false))) throw new AgentError(`Workspace root ${path} is not a directory.`);
  return real;
}

export interface ConfinedPath {
  /** Root-relative POSIX path. */
  path: string;
  absolute: string;
}

/**
 * Resolves a root-relative (or absolute, inside the root) path for reading. Rejects URLs, `..` escapes, and paths
 * whose real location (after symlinks) is outside the root. The file need not exist.
 */
export async function confine(root: string, value: string, label: string): Promise<ConfinedPath> {
  notUrl(value, label);
  const path = input(() => toSelector(root, value, label, ""));
  if (path === "") throw new AgentError(`${label} "${value}" must name a file inside the workspace.`);
  const absolute = join(root, ...path.split("/"));
  let existing = absolute;
  for (;;) {
    const real = await realpath(existing).catch(() => undefined);
    if (real !== undefined) {
      if (!within(root, real)) throw new AgentError(`${label} "${value}" resolves outside the workspace.`);
      break;
    }
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return { path, absolute };
}

export interface LoadedConfig {
  config: LintConfig;
  /** Root-relative path of the configuration file, or null when the defaults apply. */
  configPath: string | null;
  /** The configuration lists localRules; agents never load them, so those rules do not run. */
  localRulesIgnored: boolean;
}

/** Loads `.github/ci-cd-optimizer.yml` (or an explicit path inside the root) with the built-in rules only. */
export async function loadConfig(root: string, explicit?: string, signal?: AbortSignal): Promise<LoadedConfig> {
  const candidates = await Promise.all((explicit ? [explicit] : CONFIG_PATHS).map((path) => confine(root, path, "Configuration path")));
  for (const candidate of candidates) {
    const info = await lstat(candidate.absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw new AgentError(`Configuration ${candidate.path} could not be inspected.`);
    });
    if (!info) {
      if (explicit) throw new AgentError(`Configuration ${candidate.path} does not exist.`);
      continue;
    }
    if (!info.isFile()) throw new AgentError(`Configuration ${candidate.path} is not a regular file.`);
    const read = await readBoundedFile(root, candidate.absolute, LIMITS.configBytes, signal);
    if (read.truncated) throw new AgentError(`Configuration exceeds ${LIMITS.configBytes} bytes.`);
    const text = read.text;
    const parsed = parseConfigText(text, allRules, candidate.path);
    if (parsed.problems.length > 0) {
      throw new AgentError(`Invalid configuration ${candidate.path}: ${parsed.problems.map((problem) => `${problem.path || "(root)"}: ${problem.message}`).join("; ")}`);
    }
    return { config: parsed.config, configPath: candidate.path, localRulesIgnored: parsed.config.localRules.length > 0 };
  }
  return { config: structuredClone(DEFAULT_CONFIG), configPath: null, localRulesIgnored: false };
}

export interface Overrides {
  /** Replace the configured presets. */
  presets?: string[];
  /** Per-rule severity overrides. */
  rules?: Record<string, string>;
  /** Per-ruleset severity overrides. */
  rulesets?: Record<string, string>;
}

function severity(label: string, value: string): Severity {
  if (!SEVERITIES.includes(value as Severity)) throw new AgentError(`${label}: severity must be one of ${SEVERITIES.join(", ")}.`);
  return value as Severity;
}

function applyOverrides(config: LintConfig, overrides: Overrides): Preset[] | undefined {
  for (const [id, value] of Object.entries(overrides.rulesets ?? {})) {
    if (!(RULESETS as readonly string[]).includes(id)) throw new AgentError(`Unknown ruleset "${id}".${didYouMean(id, [...RULESETS])}`);
    config.rulesets = { ...config.rulesets, [id]: severity(`ruleset ${id}`, value) };
  }
  for (const [id, value] of Object.entries(overrides.rules ?? {})) {
    if (!allRules.some((rule) => rule.meta.id === id)) throw new AgentError(unknownRuleMessage("rules", id, allRules));
    config.rules = { ...config.rules, [id]: severity(`rule ${id}`, value) };
  }
  return overrides.presets?.map((preset) => {
    if (!PRESETS.includes(preset as Preset)) throw new AgentError(`Unknown preset "${preset}".${didYouMean(preset, PRESETS)}`);
    return preset as Preset;
  });
}

export interface ContentOverride {
  /** Root-relative path the content stands in for (decides which rules apply). */
  path: string;
  /** Unsaved editor content. */
  text: string;
}

export interface LintRequest extends Overrides {
  root: string;
  signal?: AbortSignal;
  /** Configuration path inside the root (default: .github/ci-cd-optimizer.yml). */
  config?: string;
  /** Files, directories, or globs to report on. The whole root is still analyzed. */
  paths?: string[];
  /** Unsaved content that replaces (or adds) files in the analysis; reports are limited to these paths. */
  content?: ContentOverride[];
  /** Lowest severity to report (default info). */
  minSeverity?: ActiveSeverity;
  /** Maximum diagnostics returned (default 100, at most 500); counts always cover everything. */
  limit?: number;
}

interface Analysis extends LoadedConfig {
  root: string;
  input: LoadedInput;
  result: LintResult;
  selected: (path: string) => boolean;
  unmatched: string[];
}

async function analyze(request: LintRequest): Promise<Analysis> {
  request.signal?.throwIfAborted();
  if (Buffer.byteLength(JSON.stringify(request)) > LIMITS.requestBytes) throw new AgentError("Request exceeds the agent byte limit.");
  if ((request.paths?.length ?? 0) > 200) throw new AgentError("At most 200 path selectors are accepted.");
  const root = await resolveRoot(request.root);
  const loaded = await loadConfig(root, request.config, request.signal);
  loaded.config.limits = { maxFiles: Math.min(loaded.config.limits.maxFiles, LIMITS.files), maxFileBytes: Math.min(loaded.config.limits.maxFileBytes, LIMITS.fileBytes) };
  const presets = applyOverrides(loaded.config, request);
  const content = request.content ?? [];
  if (content.length > MAX_CONTENT_FILES) throw new AgentError(`At most ${MAX_CONTENT_FILES} content overrides are accepted.`);
  const contentPaths = await Promise.all(content.map(async (file) => {
    notUrl(file.path, "Content path");
    const path = input(() => toSelector(root, file.path, "Content path", ""));
    if (path === "" || /[*?]/.test(path)) throw new AgentError(`Content path "${file.path}" must name a file.`);
    await confine(root, path, "Content path");
    return path;
  }));
  if (new Set(contentPaths).size !== contentPaths.length) throw new AgentError("Content overrides must have unique paths.");
  const selectors = [
    ...(request.paths ?? []).map((path) => {
      notUrl(path, "Path");
      return input(() => toSelector(root, path, "Path", ""));
    }),
    ...contentPaths,
  ];
  let loadedInput = await loadAgentDirectory(root, loaded.config, request.signal);
  for (const [index, file] of content.entries()) {
    const path = contentPaths[index] as string;
    loadedInput = input(() => withFile(loadedInput, { path, content: file.text }, loaded.config.limits, `Content for ${path}`));
  }
  if (loadedInput.files.length > LIMITS.files || loadedInput.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0) > LIMITS.workspaceBytes) {
    throw new AgentError("Workspace and content overrides exceed the agent inventory budget.");
  }
  request.signal?.throwIfAborted();
  const result = runLint(loadedInput, { config: loaded.config, rules: allRules, ...(presets ? { presets } : {}) });
  request.signal?.throwIfAborted();
  const selected = (path: string) => selectors.length === 0 || selectors.some((selector) => selects(selector, path));
  const analyzed = filterInput(loadedInput, loaded.config.ignorePaths).files.map((file) => file.path);
  const unmatched = selectors.filter((selector) => !analyzed.some((path) => selects(selector, path)));
  return { ...loaded, root, input: loadedInput, result, selected, unmatched };
}

export interface AgentDiagnostic {
  ruleId: string;
  ruleset: string;
  severity: ActiveSeverity;
  kind: RuleKind;
  message: string;
  path: string;
  line: number;
  column: number;
  suggestion?: string;
  impact: string;
  confidence: string;
  docsUrl: string;
  fingerprint: string;
  /** A safe autofix exists; preview it with fix_preview. */
  fixable: boolean;
  fixDescription?: string;
  omittedCharacters: number;
}

export interface SeverityCounts {
  error: number;
  warn: number;
  info: number;
}

export interface DiagnosticPage {
  /** Counts of every reported diagnostic, before the limit. */
  counts: SeverityCounts;
  total: number;
  /** More diagnostics exist than were returned. */
  truncated: boolean;
  omittedDiagnostics: number;
  diagnostics: AgentDiagnostic[];
}

export interface LintSummary extends DiagnosticPage {
  root: string;
  configPath: string | null;
  localRulesIgnored: boolean;
  filesAnalyzed: number;
  rulesRun: number;
  suppressed: number;
  inventoryComplete: boolean;
  parseProblems: (ParseProblem & { omittedCharacters: number })[];
  skipped: SkippedRule[];
  /** Requested paths that matched no analyzed file. */
  unmatched: string[];
  omitted: { parseProblems: number; skipped: number; unmatched: number };
}

function slim(diagnostic: Diagnostic): AgentDiagnostic {
  const message = sanitizeMarkdown(diagnostic.message, 2048);
  const suggestion = diagnostic.suggestion ? sanitizeMarkdown(diagnostic.suggestion, 2048) : undefined;
  const description = diagnostic.fix ? sanitizeMarkdown(diagnostic.fix.description, 1024) : undefined;
  return {
    ruleId: diagnostic.ruleId,
    ruleset: diagnostic.ruleset,
    severity: diagnostic.severity,
    kind: diagnostic.kind,
    message: message.text,
    path: diagnostic.path,
    line: diagnostic.line,
    column: diagnostic.column,
    ...(suggestion ? { suggestion: suggestion.text } : {}),
    impact: diagnostic.impact,
    confidence: diagnostic.confidence,
    docsUrl: diagnostic.docsUrl,
    fingerprint: diagnostic.fingerprint,
    fixable: Boolean(diagnostic.fix?.edits.length),
    ...(description ? { fixDescription: description.text } : {}),
    omittedCharacters: message.omittedCharacters + (suggestion?.omittedCharacters ?? 0) + (description?.omittedCharacters ?? 0),
  };
}

export function countSeverities(diagnostics: readonly { severity: ActiveSeverity }[]): SeverityCounts {
  const counts: SeverityCounts = { error: 0, warn: 0, info: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;
  return counts;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new AgentError("limit must be a positive integer.");
  return Math.min(limit, MAX_LIMIT);
}

/** Summarizes diagnostics for an agent: slim, most severe first, capped, with complete counts. */
export function summarizeDiagnostics(diagnostics: readonly Diagnostic[], minSeverity?: ActiveSeverity, limit?: number): DiagnosticPage {
  if (minSeverity !== undefined && !Object.hasOwn(RANK, minSeverity)) throw new AgentError("minSeverity must be info, warn, or error.");
  const max = clampLimit(limit);
  const minimum = RANK[minSeverity ?? "info"];
  const visible = diagnostics
    .filter((diagnostic) => RANK[diagnostic.severity] >= minimum)
    .sort((left, right) => RANK[right.severity] - RANK[left.severity] || left.path.localeCompare(right.path) || left.line - right.line || left.ruleId.localeCompare(right.ruleId));
  return { counts: countSeverities(visible), total: visible.length, truncated: visible.length > max, omittedDiagnostics: Math.max(0, visible.length - max), diagnostics: visible.slice(0, max).map(slim) };
}

export async function lintWorkspace(request: LintRequest): Promise<LintSummary> {
  if (request.minSeverity !== undefined && !Object.hasOwn(RANK, request.minSeverity)) throw new AgentError("minSeverity must be info, warn, or error.");
  clampLimit(request.limit);
  const analysis = await analyze(request);
  const { result } = analysis;
  const page = summarizeDiagnostics(result.diagnostics.filter((diagnostic) => analysis.selected(diagnostic.path)), request.minSeverity, request.limit);
  return {
    root: analysis.root,
    configPath: analysis.configPath,
    localRulesIgnored: analysis.localRulesIgnored,
    filesAnalyzed: result.filesAnalyzed,
    rulesRun: result.rulesRun,
    suppressed: result.suppressed,
    inventoryComplete: analysis.input.inventoryComplete,
    ...page,
    parseProblems: result.parseProblems.filter((problem) => analysis.selected(problem.path)).slice(0, 100).map((problem) => {
      const message = sanitizeMarkdown(problem.message, 2048);
      return { ...problem, message: message.text, omittedCharacters: message.omittedCharacters };
    }),
    skipped: result.skipped.slice(0, 100),
    unmatched: analysis.unmatched.slice(0, 100),
    omitted: {
      parseProblems: Math.max(0, result.parseProblems.filter((problem) => analysis.selected(problem.path)).length - 100),
      skipped: Math.max(0, result.skipped.length - 100),
      unmatched: Math.max(0, analysis.unmatched.length - 100),
    },
  };
}

export interface FixPreviewRequest extends LintRequest {
  /** Only preview fixes for these rule ids. */
  ruleIds?: string[];
}

export interface FilePreview {
  path: string;
  /** Omitted (with `omitted: true`) once the response size budget is spent. */
  oldText?: string;
  newText?: string;
  omitted?: boolean;
  fixes: string[];
  omittedFixes: number;
  omittedCharacters: number;
}

export interface FixPreview {
  root: string;
  inventoryComplete: boolean;
  localRulesIgnored: boolean;
  parseProblemCount: number;
  applied: number;
  /** Fixes that overlap an earlier fix in the same pass; they apply on a later run. */
  conflicts: number;
  files: FilePreview[];
  omittedFiles: number;
  /** Always false: previews never write. Apply with `cicd-lint --fix` after review. */
  written: false;
}

/** Computes the safe autofixes for the selected files without writing anything. */
export async function fixPreview(request: FixPreviewRequest): Promise<FixPreview> {
  for (const id of request.ruleIds ?? []) {
    if (!allRules.some((rule) => rule.meta.id === id)) throw new AgentError(unknownRuleMessage("ruleIds", id, allRules));
  }
  const analysis = await analyze(request);
  const truncated = new Set(analysis.input.truncated);
  const wanted = request.ruleIds ? new Set(request.ruleIds) : undefined;
  const fixable = analysis.result.diagnostics.filter(
    (diagnostic) => diagnostic.fix && !truncated.has(diagnostic.path) && analysis.selected(diagnostic.path) && (!wanted || wanted.has(diagnostic.ruleId)),
  );
  const fixed = applyFixes(analysis.input.files, fixable);
  const original = new Map(analysis.input.files.map((file) => [file.path, file.content]));
  let budget = MAX_PREVIEW_BYTES;
  const files: FilePreview[] = [];
  for (const [path, newText] of [...fixed.files].sort(([left], [right]) => left.localeCompare(right))) {
    const oldText = original.get(path) ?? "";
    if (oldText === newText) continue;
    const descriptions = fixed.applied
      .filter((diagnostic) => diagnostic.fix?.edits.some((edit) => edit.path === path))
      .map((diagnostic) => `${diagnostic.ruleId}: ${diagnostic.fix?.description ?? ""}`);
    const listed = descriptions.slice(0, 50).map((description) => sanitizeMarkdown(description, 1024));
    const fixes = listed.map((description) => description.text);
    const omissions = { omittedFixes: Math.max(0, descriptions.length - 50), omittedCharacters: listed.reduce((total, description) => total + description.omittedCharacters, 0) };
    const size = Buffer.byteLength(oldText) + Buffer.byteLength(newText);
    if (size <= budget && files.length < MAX_CONTENT_FILES) {
      budget -= size;
      files.push({ path, oldText, newText, fixes, ...omissions });
    } else files.push({ path, omitted: true, fixes, ...omissions });
  }
  return {
    root: analysis.root, inventoryComplete: analysis.input.inventoryComplete, localRulesIgnored: analysis.localRulesIgnored,
    parseProblemCount: analysis.result.parseProblems.filter((problem) => analysis.selected(problem.path)).length,
    applied: fixed.applied.length, conflicts: fixed.conflicts.length, files, omittedFiles: files.filter((file) => file.omitted).length, written: false,
  };
}

export interface RuleFilter {
  ruleset?: string;
  preset?: string;
  kind?: string;
  fixable?: boolean;
  /** Case-insensitive substring of the id or description. */
  query?: string;
}

export interface RuleSummary {
  id: string;
  ruleset: string;
  kind: RuleKind;
  defaultSeverity: Severity;
  presets: Preset[];
  fixable: boolean;
  impact: string;
  description: string;
  docsUrl: string;
}

const ruleSummary = (rule: AnyRule): RuleSummary => ({
  id: rule.meta.id,
  ruleset: rule.meta.ruleset,
  kind: rule.meta.kind,
  defaultSeverity: rule.meta.defaultSeverity,
  presets: [...rule.meta.presets],
  fixable: Boolean(rule.meta.fixable),
  impact: rule.meta.impact,
  description: rule.meta.description,
  docsUrl: rule.meta.docsUrl ?? docsUrl(rule.meta.id),
});

export function listRules(filter: RuleFilter = {}): RuleSummary[] {
  if (filter.ruleset !== undefined && !(RULESETS as readonly string[]).includes(filter.ruleset)) {
    throw new AgentError(`Unknown ruleset "${filter.ruleset}".${didYouMean(filter.ruleset, [...RULESETS])}`);
  }
  if (filter.preset !== undefined && !PRESETS.includes(filter.preset as Preset)) throw new AgentError(`Unknown preset "${filter.preset}".${didYouMean(filter.preset, PRESETS)}`);
  const query = filter.query?.toLowerCase();
  return allRules
    .filter((rule) => filter.ruleset === undefined || rule.meta.ruleset === filter.ruleset)
    .filter((rule) => filter.preset === undefined || rule.meta.presets.includes(filter.preset as Preset))
    .filter((rule) => filter.kind === undefined || rule.meta.kind === filter.kind)
    .filter((rule) => filter.fixable === undefined || Boolean(rule.meta.fixable) === filter.fixable)
    .filter((rule) => !query || rule.meta.id.toLowerCase().includes(query) || rule.meta.description.toLowerCase().includes(query))
    .map(ruleSummary);
}

export interface RuleExplanation extends RuleSummary {
  rationale: string;
  references: string[];
  requires: string[];
  example?: { bad: string; good: string };
  /** Severity under the workspace configuration (or the defaults when no root is given). */
  effectiveSeverity: Severity;
  /** The same plain-text explanation as `cicd-lint --explain`. */
  text: string;
}

export async function explainRule(id: string, options: { root?: string; config?: string; signal?: AbortSignal } = {}): Promise<RuleExplanation> {
  const rule = allRules.find((candidate) => candidate.meta.id === id);
  if (!rule) throw new AgentError(unknownRuleMessage("Rule", id, allRules));
  const config = options.root ? (await loadConfig(await resolveRoot(options.root), options.config, options.signal)).config : structuredClone(DEFAULT_CONFIG);
  options.signal?.throwIfAborted();
  const severities = effectiveSeverities(config, allRules, undefined);
  return {
    ...ruleSummary(rule),
    rationale: rule.meta.rationale,
    references: [...rule.meta.references],
    requires: [...rule.meta.requires],
    ...(rule.meta.example ? { example: { ...rule.meta.example } } : {}),
    effectiveSeverity: severities.get(id) ?? "off",
    text: explainRuleText(id, allRules, severities) ?? "",
  };
}

export interface EffectiveConfig extends LoadedConfig {
  root: string;
  /** Effective severity of every built-in rule. */
  rules: Record<string, Severity>;
}

export async function effectiveConfig(request: { root: string; config?: string; signal?: AbortSignal } & Overrides): Promise<EffectiveConfig> {
  const root = await resolveRoot(request.root);
  const loaded = await loadConfig(root, request.config, request.signal);
  const presets = applyOverrides(loaded.config, request);
  const severities = effectiveSeverities(loaded.config, allRules, presets);
  return { root, ...loaded, config: presets ? { ...loaded.config, extends: presets } : loaded.config, rules: Object.fromEntries(severities) };
}

export interface ReviewProjectValidation {
  path: string;
  valid: boolean;
  problems: string[];
  project?: Project;
}

/** Validates an OSS review program `project.yaml` (see docs/oss-review-program.md) inside the workspace. */
export async function validateReviewProject(rootPath: string, path: string, signal?: AbortSignal): Promise<ReviewProjectValidation> {
  const root = await resolveRoot(rootPath);
  const target = await confine(root, path, "Project path");
  if (posix.basename(target.path) !== PROJECT_FILE) throw new AgentError(`${target.path}: project files must be named ${PROJECT_FILE}.`);
  const info = await lstat(target.absolute).catch(() => undefined);
  if (!info) throw new AgentError(`${target.path} does not exist.`);
  if (!info.isFile()) throw new AgentError(`${target.path} is not a regular file.`);
  const directory = basename(dirname(target.absolute));
  const read = await readBoundedFile(root, target.absolute, PROJECT_MAX_BYTES, signal);
  const text = read.truncated ? "x".repeat(PROJECT_MAX_BYTES + 1) : read.text;
  const parsed = parseProjectText(text, directory);
  return { path: target.path, valid: parsed.project !== undefined, problems: parsed.problems, ...(parsed.project ? { project: parsed.project } : {}) };
}
