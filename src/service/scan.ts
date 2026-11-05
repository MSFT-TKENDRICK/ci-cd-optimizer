import type { GitHubClient, RepoRef } from "../github/client.js";
import { uploadSarif, type SarifUploadResult } from "../github/code-scanning.js";
import { defaultBranch, loadRemoteConfig, loadRepositorySnapshot } from "../github/repository.js";
import { applyFixActions, dismissalsFrom, listManagedPullRequests, type AppliedFixAction } from "../fixes/github.js";
import { computeFixChanges, planFixPullRequests, type FixAction, type SkippedFix } from "../fixes/plan.js";
import { applyIssueActions, listManagedIssues, type AppliedIssueAction } from "../issues/github.js";
import { planIssueSync, type IssueAction, type SkippedIssue } from "../issues/plan.js";
import { desiredIssues } from "../issues/render.js";
import { lint } from "../lint/api.js";
import { sarif } from "../lint/formatters/index.js";
import { allRules } from "../lint/rules/index.js";
import type { AnalysisInput, LintResult } from "../lint/types.js";
import { VERSION } from "../version.js";

export interface ScanOptions {
  /** Branch or commit to scan; defaults to the default branch. Issues and fix pull requests only sync for the default branch. */
  ref?: string;
  /** Compute everything but write nothing to GitHub. */
  dryRun?: boolean;
  uploadSarif?: boolean;
  /** Set false to skip issue sync even when enabled in the configuration. */
  issues?: boolean;
  /** Set false to skip fix pull request sync even when enabled in the configuration. */
  fixes?: boolean;
  rebase?: ReadonlySet<string>;
  recreate?: ReadonlySet<string>;
  /** Client authenticated as a Copilot-licensed user, to assign finding issues to the coding agent. */
  copilotClient?: GitHubClient;
}

export interface ScanResult {
  repo: string;
  ref: string;
  sha?: string;
  status: "scanned" | "disabled" | "invalid-config";
  configProblems?: string[];
  result?: LintResult;
  inventoryComplete?: boolean;
  truncated?: string[];
  sarif?: SarifUploadResult | { status: "skipped" };
  issues?: { actions: IssueAction[]; skipped: SkippedIssue[]; applied: AppliedIssueAction[] };
  fixes?: { actions: FixAction[]; skipped: SkippedFix[]; applied: AppliedFixAction[] };
}

const isRecipeGroup = (group: string) => group.startsWith("recipe-");

/**
 * The repository scan, Dependabot/code-scanning style: lints the default branch, uploads SARIF to code scanning,
 * reconciles finding issues (for triage and coding-agent assignment), and reconciles autofix pull requests.
 * Idempotent: re-running with unchanged findings makes no writes.
 */
export async function scanRepository(client: GitHubClient, repo: RepoRef, options: ScanOptions = {}): Promise<ScanResult> {
  const name = `${repo.owner}/${repo.repo}`;
  const branch = await defaultBranch(client, repo);
  const ref = options.ref ?? branch;
  const remote = await loadRemoteConfig(client, repo, branch);
  if (remote.problems.length > 0) {
    return { repo: name, ref, status: "invalid-config", configProblems: remote.problems.map((problem) => `${problem.path}: ${problem.message}`) };
  }
  const config = remote.config;
  if (!config.enabled) return { repo: name, ref, status: "disabled" };

  const snapshot = await loadRepositorySnapshot(client, repo, { ref, config });
  const { input } = snapshot;
  const truncated = new Set(input.truncated);
  const result = lint({ input, config });
  const scan: ScanResult = {
    repo: name,
    ref,
    sha: snapshot.sha,
    status: "scanned",
    result,
    inventoryComplete: input.inventoryComplete,
    truncated: input.truncated,
  };

  if (options.uploadSarif) {
    scan.sarif = options.dryRun
      ? { status: "skipped" }
      : await uploadSarif(client, repo, { sarif: sarif(result, allRules, VERSION), commitSha: snapshot.sha, ref: ref === snapshot.sha ? branch : ref });
  }
  const onDefaultBranch = ref === branch || ref === `refs/heads/${branch}`;

  if (onDefaultBranch && options.issues !== false && config.issues.enabled) {
    const existing = await listManagedIssues(client, repo, "finding");
    const desired = desiredIssues(result.diagnostics, config.issues, { owner: repo.owner, repo: repo.repo, sha: snapshot.sha, rules: allRules });
    // Absence-check rules are skipped on a truncated inventory, so their issues must not be closed as resolved.
    const plan = planIssueSync(existing, desired, { maxOpen: config.issues.maxOpen, closeResolved: config.issues.closeResolved && input.inventoryComplete });
    const applied = options.dryRun
      ? []
      : await applyIssueActions(client, repo, plan.actions, { ...(options.copilotClient ? { copilotClient: options.copilotClient } : {}), copilot: config.issues.copilot });
    scan.issues = { ...plan, applied };
  }

  if (onDefaultBranch && options.fixes !== false && config.fixes.enabled) {
    // Recipe pull requests are owned by their rollout; leave them alone here.
    const existing = (await listManagedPullRequests(client, repo, {
      baseBranch: branch,
      branchPrefix: config.fixes.branchPrefix,
      groups: [...Object.keys(config.fixes.groups), ...allRules.map((rule) => rule.meta.ruleset)],
    })).filter((pr) => !isRecipeGroup(pr.group));
    const changes = computeFixChanges({
      input,
      // Fixing a file the inventory only partly read would truncate it.
      lint: (next: AnalysisInput) => {
        const linted = lint({ input: next, config });
        return { ...linted, diagnostics: linted.diagnostics.filter((diagnostic) => !truncated.has(diagnostic.path)) };
      },
      config: config.fixes,
      dismissed: dismissalsFrom(existing),
    });
    const plan = planFixPullRequests(changes, existing, {
      openPullRequestsLimit: config.fixes.openPullRequestsLimit,
      baseSha: snapshot.sha,
      labels: ["cicd-optimizer", ...config.fixes.labels],
      reviewers: config.fixes.reviewers,
      ...(options.rebase ? { rebase: options.rebase } : {}),
      ...(options.recreate ? { recreate: options.recreate } : {}),
    });
    const applied = options.dryRun
      ? []
      : await applyFixActions(client, repo, plan.actions, { baseBranch: branch, baseSha: snapshot.sha, config: config.fixes, rules: allRules, existing });
    scan.fixes = { ...plan, applied };
  }
  return scan;
}

/** One-line human summary of a scan (CLI output, logs). */
export function describeScan(scan: ScanResult): string {
  if (scan.status === "disabled") return `${scan.repo}: disabled by configuration.`;
  if (scan.status === "invalid-config") return `${scan.repo}: invalid configuration — ${scan.configProblems?.join("; ")}`;
  const counts = { error: 0, warn: 0, info: 0 };
  for (const diagnostic of scan.result?.diagnostics ?? []) counts[diagnostic.severity] += 1;
  const parts = [`${scan.repo}@${scan.ref}: ${counts.error} error(s), ${counts.warn} warning(s), ${counts.info} info`];
  if (scan.sarif) parts.push(`SARIF ${scan.sarif.status}`);
  if (scan.issues) parts.push(`issues: ${tally(scan.issues.actions)}${scan.issues.skipped.length ? `, ${scan.issues.skipped.length} skipped` : ""}`);
  if (scan.fixes) parts.push(`fix PRs: ${tally(scan.fixes.actions)}${scan.fixes.skipped.length ? `, ${scan.fixes.skipped.length} skipped` : ""}`);
  if (scan.inventoryComplete === false) parts.push(`inventory truncated (${scan.truncated?.length ?? 0} file(s))`);
  return parts.join(" · ");
}

function tally(actions: readonly { type: string }[]): string {
  if (actions.length === 0) return "no changes";
  const counts = new Map<string, number>();
  for (const action of actions) counts.set(action.type, (counts.get(action.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => `${count} ${type}`).join(", ");
}
