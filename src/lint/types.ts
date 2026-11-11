import type { ProjectModel } from "./project.js";

export type Severity = "off" | "info" | "warn" | "error";
export type ActiveSeverity = Exclude<Severity, "off">;
export type Confidence = "high" | "medium" | "low";
export type Impact = "high" | "medium" | "low";

/**
 * practice: broadly applicable optimization with low false-positive risk.
 * policy: organization choice (for example GitHub-native registries); opt-in.
 * insight: architectural suggestion that needs human judgement or telemetry.
 */
export type RuleKind = "practice" | "policy" | "insight";

export type Preset = "recommended" | "strict" | "agentic" | "github" | "insights" | "ssdf" | "all";

/**
 * repository: the whole repository tree was supplied (not individual files).
 * complete-inventory: every relevant file was loaded, so absence is meaningful.
 * change-set: the files changed by the current pull request or push are known.
 */
export type Capability = "repository" | "complete-inventory" | "change-set";

export interface SourceFile {
  path: string;
  content: string;
}

export interface ChangeContext {
  event: "pull_request" | "push" | "merge_group" | "unknown";
  baseSha?: string;
  headSha?: string;
  changedPaths: string[];
}

export interface AnalysisInput {
  files: SourceFile[];
  mode: "repository" | "files";
  inventoryComplete: boolean;
  change?: ChangeContext;
}

export interface Location {
  path: string;
  line: number;
  column?: number;
}

export type DiagnosticScope = "introduced" | "changed-file" | "existing";

/** A replacement of `content.slice(start, end)` (character offsets) with `text`. */
export interface TextEdit {
  path: string;
  start: number;
  end: number;
  text: string;
}

export interface Fix {
  description: string;
  edits: TextEdit[];
}

export interface Diagnostic {
  ruleId: string;
  ruleset: string;
  severity: ActiveSeverity;
  message: string;
  path: string;
  line: number;
  column: number;
  suggestion?: string;
  impact: Impact;
  confidence: Confidence;
  fingerprint: string;
  docsUrl: string;
  related?: Location[];
  scope?: DiagnosticScope;
  fix?: Fix;
  kind: RuleKind;
}

export interface ReportDescriptor {
  path: string;
  line: number;
  column?: number;
  message: string;
  suggestion?: string;
  impact?: Impact;
  confidence?: Confidence;
  /** Stable discriminator (for example a YAML path) used for fingerprints instead of line numbers. */
  key?: string;
  related?: Location[];
  /** Deterministic, behavior-preserving autofix. Only provide when the edit is safe to apply unattended. */
  fix?: Fix | undefined;
}

export interface RuleMeta<O> {
  id: string;
  ruleset: string;
  description: string;
  rationale: string;
  kind: RuleKind;
  defaultSeverity: ActiveSeverity;
  presets: Preset[];
  requires: Capability[];
  defaultOptions: O;
  validateOptions?: (value: Record<string, unknown>) => string[];
  references: string[];
  impact: Impact;
  fixable?: boolean;
  example?: { bad: string; good: string };
  /** Documentation link for findings; defaults to the rule's section in docs/rules.md. */
  docsUrl?: string;
}

export interface RuleContext<O> {
  options: O;
  project: ProjectModel;
  input: AnalysisInput;
  /** An excluded expected path cannot support an absence finding, even when it was not listed. */
  isPathIgnored?(path: string): boolean;
  report(descriptor: ReportDescriptor): void;
}

export interface RuleModule<O = Record<string, unknown>> {
  meta: RuleMeta<O>;
  check(context: RuleContext<O>): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRule = RuleModule<any>;

export interface ResolvedRule {
  rule: AnyRule;
  severity: ActiveSeverity;
  options: Record<string, unknown>;
}

export interface SkippedRule {
  ruleId: string;
  reason: string;
}

export interface ParseProblem {
  path: string;
  line: number;
  message: string;
}

/** A suppression directive, or ids within it, that suppressed nothing. Empty `ids` means a blanket directive. */
export interface UnusedDirective {
  path: string;
  line: number;
  kind: "file" | "next-line";
  ids: string[];
}

export interface LintResult {
  diagnostics: Diagnostic[];
  skipped: SkippedRule[];
  parseProblems: ParseProblem[];
  filesAnalyzed: number;
  rulesRun: number;
  suppressed: number;
  durationMs: number;
  /** Present when unused-directive reporting was requested. */
  unusedDirectives?: UnusedDirective[];
}
