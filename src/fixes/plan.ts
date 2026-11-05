import type { FixesConfig } from "../lint/config.js";
import { applyFixes } from "../lint/fix.js";
import type { AnalysisInput, Diagnostic, LintResult, SourceFile } from "../lint/types.js";
import { signatureOf } from "../issues/markers.js";
import { matchesGlob } from "../utils.js";

export interface Dismissals {
  rules: ReadonlySet<string>;
  groups: ReadonlySet<string>;
}

export const NO_DISMISSALS: Dismissals = { rules: new Set(), groups: new Set() };

/** Named groups win (first match in declaration order); otherwise one pull request per ruleset. */
export function groupName(diagnostic: Pick<Diagnostic, "ruleId" | "ruleset">, config: FixesConfig): string {
  for (const [name, group] of Object.entries(config.groups)) {
    if (group.rules?.includes(diagnostic.ruleId) || group.rulesets?.includes(diagnostic.ruleset)) return name;
  }
  return diagnostic.ruleset;
}

function ruleMatches(pattern: string, ruleId: string): boolean {
  return pattern === ruleId || (pattern.endsWith("/*") && ruleId.startsWith(pattern.slice(0, -1)));
}

export function isIgnored(diagnostic: Pick<Diagnostic, "ruleId" | "path">, config: FixesConfig, dismissed: Dismissals = NO_DISMISSALS): boolean {
  if (dismissed.rules.has(diagnostic.ruleId)) return true;
  return config.ignore.some(
    (entry) => ruleMatches(entry.rule, diagnostic.ruleId) && (!entry.paths || entry.paths.some((glob) => matchesGlob(diagnostic.path, glob))),
  );
}

export function branchFor(group: string, config: Pick<FixesConfig, "branchPrefix">): string {
  return `${config.branchPrefix}${group.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

export interface FixChange {
  group: string;
  branch: string;
  /** New contents of the files that change. */
  files: SourceFile[];
  /** Diagnostics fixed, across all passes. */
  applied: Diagnostic[];
  rules: string[];
  /** Hash of the resulting file contents: identical fixes on an unchanged base produce the same signature. */
  signature: string;
}

export interface ComputeFixOptions {
  input: AnalysisInput;
  lint: (input: AnalysisInput) => LintResult;
  config: FixesConfig;
  dismissed?: Dismissals;
  /** Re-lint and re-apply while fixes conflict or reveal further fixes (ESLint applies up to 10 passes). */
  maxPasses?: number;
}

/**
 * Computes one independent change set per fix group, each applied to the unmodified base so every pull request
 * can be reviewed and merged on its own (like Dependabot's per-group PRs).
 */
export function computeFixChanges(options: ComputeFixOptions): FixChange[] {
  const dismissed = options.dismissed ?? NO_DISMISSALS;
  const maxPasses = options.maxPasses ?? 5;
  const original = new Map(options.input.files.map((file) => [file.path, file.content]));
  const eligible = (diagnostic: Diagnostic, group?: string) =>
    diagnostic.fix !== undefined &&
    !isIgnored(diagnostic, options.config, dismissed) &&
    !dismissed.groups.has(groupName(diagnostic, options.config)) &&
    (group === undefined || groupName(diagnostic, options.config) === group);

  const first = options.lint(options.input);
  const groups = [...new Set(first.diagnostics.filter((d) => eligible(d)).map((d) => groupName(d, options.config)))].sort();
  const changes: FixChange[] = [];

  for (const group of groups) {
    let files = options.input.files;
    let result = first;
    const applied: Diagnostic[] = [];
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const selected = result.diagnostics.filter((d) => eligible(d, group));
      if (selected.length === 0) break;
      const output = applyFixes(files, selected);
      if (output.applied.length === 0) break;
      applied.push(...output.applied);
      files = files.map((file) => (output.files.has(file.path) ? { path: file.path, content: output.files.get(file.path) as string } : file));
      // Re-lint: deferred (conflicting) fixes get another chance, and a fix may reveal further fixable findings.
      if (pass < maxPasses - 1) result = options.lint({ ...options.input, files });
    }
    const changed = files.filter((file) => original.get(file.path) !== file.content).sort((a, b) => a.path.localeCompare(b.path));
    if (changed.length === 0) continue;
    changes.push({
      group,
      branch: branchFor(group, options.config),
      files: changed,
      applied,
      rules: [...new Set(applied.map((d) => d.ruleId))].sort(),
      signature: signatureOf(changed.flatMap((file) => [file.path, file.content])),
    });
  }
  return changes;
}

export interface PendingFixUpdate {
  fromSha: string;
  commitSha: string;
  signature: string;
  baseSha: string;
  rules: string[];
}

export type CleanupStatus = "pending" | "deleted" | "missing" | "changed" | "in-use" | "reopened";

export interface BranchCleanup {
  branch: string;
  headSha: string;
  status: CleanupStatus;
}

export interface ExistingFixPullRequest {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  group: string;
  branch?: string;
  signature?: string;
  /** Commit the app last pushed (from the PR marker). */
  commitSha?: string;
  /** Current head of the PR branch; differs from `commitSha` when someone else pushed. */
  headSha?: string;
  draft?: boolean;
  labels?: readonly string[];
  pendingReviewers?: readonly string[];
  pendingUpdate?: PendingFixUpdate;
  cleanup?: BranchCleanup;
}

export type FixAction =
  | { type: "create"; change: FixChange }
  | { type: "update"; number: number; change: FixChange }
  | { type: "metadata"; number: number; group: string; labels: string[]; reviewers: string[]; recoverUpdate?: true; cleanup?: true }
  | { type: "close"; number: number; group: string; branch?: string; comment: string };

export interface SkippedFix {
  group: string;
  reason: "up-to-date" | "edited" | "declined" | "limit" | "reopened";
  number?: number;
}

export interface FixPlan {
  actions: FixAction[];
  skipped: SkippedFix[];
}

export interface FixPlanOptions {
  openPullRequestsLimit: number;
  baseSha?: string;
  labels?: readonly string[];
  reviewers?: readonly string[];
  /** Groups to rebuild even when unchanged (`rebase`); refuses when someone else pushed to the branch. */
  rebase?: ReadonlySet<string>;
  /** Groups to rebuild unconditionally, overwriting edits (`recreate`). */
  recreate?: ReadonlySet<string>;
}

function edited(pr: ExistingFixPullRequest): boolean {
  // Without an owned branch (see listManagedPullRequests) the PR is never rewritten or closed automatically.
  return !pr.branch || !pr.commitSha || !pr.headSha || pr.commitSha !== pr.headSha;
}

/**
 * Dependabot-style pull request lifecycle:
 * - an open PR is refreshed when its fixes changed, left alone when up to date, and never overwritten after
 *   someone else pushed to it (unless `recreate` is requested);
 * - a PR closed without merging is not reopened for the identical change (declined); a different change opens anew;
 * - PRs whose fixes are no longer needed (already applied on the base, or rules turned off) are closed;
 * - new PRs respect `openPullRequestsLimit` (0 disables new PRs).
 */
export function planFixPullRequests(changes: readonly FixChange[], existing: readonly ExistingFixPullRequest[], options: FixPlanOptions): FixPlan {
  const actions: FixAction[] = [];
  const skipped: SkippedFix[] = [];
  // A recorded target at the current head is our completed write, even if finalizing its marker failed.
  const newestFirst = existing.map((pr) => pr.pendingUpdate && pr.headSha === pr.pendingUpdate.commitSha
    ? { ...pr, commitSha: pr.pendingUpdate.commitSha, signature: pr.pendingUpdate.signature }
    : pr).sort((a, b) => b.number - a.number);
  const wanted = new Set(changes.map((change) => change.group));
  let open = existing.filter((pr) => pr.state === "open").length;

  for (const pr of newestFirst) {
    if (pr.state !== "open" || wanted.has(pr.group)) continue;
    if (pr.cleanup && !options.rebase?.has(pr.group) && !options.recreate?.has(pr.group)) {
      skipped.push({ group: pr.group, reason: "reopened", number: pr.number });
      continue;
    }
    if (edited(pr) && !options.recreate?.has(pr.group)) {
      skipped.push({ group: pr.group, reason: "edited", number: pr.number });
      continue;
    }
    actions.push({
      type: "close",
      number: pr.number,
      group: pr.group,
      ...(pr.branch !== undefined ? { branch: pr.branch } : {}),
      comment: "These fixes are no longer needed: the base branch already contains them, or the rules no longer apply. Closing.",
    });
    open -= 1;
  }

  for (const change of changes) {
    const current = newestFirst.find((pr) => pr.group === change.group && pr.state === "open");
    if (current) {
      if (current.cleanup && !options.rebase?.has(change.group) && !options.recreate?.has(change.group)) {
        skipped.push({ group: change.group, reason: "reopened", number: current.number });
        continue;
      }
      const completed = current.pendingUpdate?.commitSha === current.headSha && current.pendingUpdate !== undefined;
      const satisfied = completed && current.signature === change.signature && current.pendingUpdate?.baseSha === options.baseSha;
      if (satisfied) skipped.push({ group: change.group, reason: "up-to-date", number: current.number });
      else if (options.recreate?.has(change.group)) actions.push({ type: "update", number: current.number, change });
      else if (edited(current)) skipped.push({ group: change.group, reason: "edited", number: current.number });
      else if (current.signature === change.signature && !options.rebase?.has(change.group) && (!current.pendingUpdate || completed)) {
        skipped.push({ group: change.group, reason: "up-to-date", number: current.number });
      } else actions.push({ type: "update", number: current.number, change });
      continue;
    }
    const latest = newestFirst.find((pr) => pr.group === change.group);
    if (latest && !latest.merged && latest.signature === change.signature && !options.recreate?.has(change.group)) {
      skipped.push({ group: change.group, reason: "declined", number: latest.number });
      continue;
    }
    if (open >= options.openPullRequestsLimit) {
      skipped.push({ group: change.group, reason: "limit" });
      continue;
    }
    actions.push({ type: "create", change });
    open += 1;
  }
  const metadata: FixAction[] = [];
  for (const pr of newestFirst) {
    const cleanup = pr.cleanup?.status === "pending";
    if (pr.state !== "open" && !pr.pendingUpdate && !cleanup) continue;
    const currentLabels = new Set((pr.labels ?? []).map((label) => label.toLowerCase()));
    const labels = pr.state === "open" ? [...new Set(options.labels ?? [])].filter((label) => !currentLabels.has(label.toLowerCase())) : [];
    const closing = actions.some((action) => action.type === "close" && action.number === pr.number);
    const pending = closing || pr.state !== "open" || pr.draft ? [] : pr.pendingReviewers ?? [];
    if (labels.length === 0 && pending.length === 0 && !pr.pendingUpdate && !cleanup) continue;
    metadata.push({
      type: "metadata",
      number: pr.number,
      group: pr.group,
      labels,
      reviewers: pending.filter((reviewer) => options.reviewers?.includes(reviewer)),
      ...(pr.pendingUpdate ? { recoverUpdate: true as const } : {}),
      ...(cleanup ? { cleanup: true as const } : {}),
    });
  }
  return { actions: [...metadata, ...actions], skipped };
}
