import { paginate, type GitHubClient, type RepoRef } from "../github/client.js";
import { loadRemoteConfig, loadRepositorySnapshot } from "../github/repository.js";
import { lint } from "../lint/api.js";
import { exceedsThreshold } from "../lint/engine.js";
import { markdown } from "../lint/formatters/index.js";
import { isInventoryPath } from "../lint/inventory.js";
import type { ChangeContext, Diagnostic, LintResult } from "../lint/types.js";
import { annotationsFor, CHECK_NAME, completeCheck, startCheck, type CheckConclusion, type CheckOutput } from "./checks.js";

export interface PullRequestRef {
  number: number;
  headSha: string;
  baseRef: string;
  baseSha: string;
}

export interface PullRequestCheckResult {
  conclusion: CheckConclusion;
  output: CheckOutput;
  /** Findings this pull request adds (absent on the base). */
  introduced: Diagnostic[];
  /** Pre-existing findings in files the pull request touches. */
  touched: Diagnostic[];
  /** Pre-existing findings elsewhere (not reported on the pull request). */
  existing: number;
  checkRunId?: number;
}

interface PullFile {
  filename: string;
  previous_filename?: string;
}

/**
 * The pull request check: lints the head and the base through the API and reports only what the pull request
 * introduces (failing per `failOn`), plus pre-existing findings in touched files as annotations. Policy always
 * comes from the base so a pull request cannot relax its own check.
 */
export async function runPullRequestCheck(
  client: GitHubClient,
  repo: RepoRef,
  pr: PullRequestRef,
  options: { dryRun?: boolean; checkRunId?: number } = {},
): Promise<PullRequestCheckResult> {
  const checkRunId = options.checkRunId ?? (options.dryRun ? undefined : await startCheck(client, repo, { name: CHECK_NAME, headSha: pr.headSha }));
  const finish = async (result: Omit<PullRequestCheckResult, "checkRunId">): Promise<PullRequestCheckResult> => {
    if (checkRunId !== undefined) await completeCheck(client, repo, checkRunId, result.conclusion, result.output);
    return { ...result, ...(checkRunId !== undefined ? { checkRunId } : {}) };
  };
  const empty = { introduced: [], touched: [], existing: 0 };
  try {
    const remote = await loadRemoteConfig(client, repo, pr.baseSha);
    if (remote.problems.length > 0) {
      return await finish({
        ...empty,
        conclusion: "failure",
        output: {
          title: `Invalid ${remote.path ?? "configuration"}`,
          summary: [`The configuration on the base branch has problems; fix them so this check can run.`, "", ...remote.problems.map((problem) => `- \`${problem.path}\`: ${problem.message}`)].join("\n"),
        },
      });
    }
    const config = remote.config;
    if (!config.enabled) return await finish({ ...empty, conclusion: "neutral", output: { title: "Disabled", summary: "`enabled: false` in the repository configuration." } });

    const files = await paginate<PullFile>(client, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", { ...repo, pull_number: pr.number }, 30);
    const changedPaths = [...new Set(files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]))];
    // Rules see only inventory files and never depend on the change set, so other changes cannot add findings.
    if (!changedPaths.some(isInventoryPath)) {
      return await finish({ ...empty, conclusion: "success", output: { title: "No CI/CD-relevant changes", summary: "This pull request does not touch workflows, build, container, or package manifest files." } });
    }

    const change: ChangeContext = { event: "pull_request", baseSha: pr.baseSha, headSha: pr.headSha, changedPaths };
    const [head, base] = await Promise.all([
      loadRepositorySnapshot(client, repo, { ref: pr.headSha, config, change }),
      loadRepositorySnapshot(client, repo, { ref: pr.baseSha, config }),
    ]);
    const baseFingerprints = new Set(lint({ input: base.input, config }).diagnostics.map((diagnostic) => diagnostic.fingerprint));
    const result = lint({ input: head.input, config, baseFingerprints });
    const introduced = result.diagnostics.filter((diagnostic) => diagnostic.scope === "introduced");
    const touched = result.diagnostics.filter((diagnostic) => diagnostic.scope === "changed-file");
    const existing = result.diagnostics.length - introduced.length - touched.length;
    const conclusion: CheckConclusion = exceedsThreshold(introduced, config.failOn) ? "failure" : introduced.length > 0 ? "neutral" : "success";
    return await finish({
      conclusion,
      introduced,
      touched,
      existing,
      output: {
        title: title(introduced, touched),
        summary: summary(result, introduced, touched, existing, { failOn: config.failOn, truncated: head.input.truncated, inventoryComplete: head.input.inventoryComplete }),
        annotations: annotationsFor([...introduced, ...touched]),
      },
    });
  } catch (error) {
    if (checkRunId !== undefined) {
      await completeCheck(client, repo, checkRunId, "neutral", {
        title: "Analysis could not complete",
        summary: `The analysis failed and will be retried on the next push or a re-run of this check.\n\n\`${String((error as Error).message ?? error).slice(0, 500)}\``,
      }).catch(() => undefined);
    }
    throw error;
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function title(introduced: readonly Diagnostic[], touched: readonly Diagnostic[]): string {
  if (introduced.length === 0 && touched.length === 0) return "No new CI/CD findings";
  if (introduced.length === 0) return `${plural(touched.length, "existing finding")} in changed files`;
  return `${plural(introduced.length, "new finding")}${touched.length > 0 ? `, ${touched.length} existing in changed files` : ""}`;
}

function summary(
  result: LintResult,
  introduced: Diagnostic[],
  touched: Diagnostic[],
  existing: number,
  context: { failOn: string; truncated: readonly string[]; inventoryComplete: boolean },
): string {
  const fixable = [...introduced, ...touched].filter((diagnostic) => diagnostic.fix).length;
  const lines = [
    `**${introduced.length}** introduced by this pull request · **${touched.length}** pre-existing in changed files · ${existing} elsewhere in the repository (tracked by the repository scan). Fails on: \`${context.failOn}\`.`,
    "",
  ];
  if (fixable > 0) lines.push(`${plural(fixable, "finding")} can be fixed automatically: \`npx ci-cd-optimizer lint --fix\`.`, "");
  if (!context.inventoryComplete) lines.push(`> [!NOTE]\n> The file inventory hit configured limits (${context.truncated.length} file(s) truncated); rules that check for missing files were skipped.`, "");
  lines.push(markdown({ ...result, diagnostics: introduced }, { title: "Introduced", limit: 50 }).replace(/^## /, "### "));
  if (touched.length > 0) lines.push("", markdown({ ...result, diagnostics: touched, skipped: [] }, { title: "Pre-existing in changed files", limit: 25 }).replace(/^## /, "### "));
  lines.push("", "Suppress a finding inline with `# cicd-optimizer-disable-next-line <rule-id> -- reason`, or tune rules in `.github/ci-cd-optimizer.yml`.");
  return lines.join("\n");
}
