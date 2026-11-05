import { paginate, type GitHubClient, type RepoRef } from "../github/client.js";
import { readFileAt } from "../github/git.js";
import { defaultBranch, loadRemoteConfig, loadRepositorySnapshot } from "../github/repository.js";
import { listExperimentPullRequests } from "../experiments/github.js";
import { manifestPath, parseManifest, type ExperimentManifest } from "../experiments/manifest.js";
import type { HillClimbConfig } from "../experiments/config.js";
import { applyFixActions, listManagedPullRequests } from "../fixes/github.js";
import { planFixPullRequests } from "../fixes/plan.js";
import { allRules } from "../lint/rules/index.js";
import type { LintConfig } from "../lint/config.js";
import { applyIssueActions, listManagedIssues } from "../issues/github.js";
import { findMarker } from "../issues/markers.js";
import { planIssueSync } from "../issues/plan.js";
import { classifyIssueOutcome, classifyOutcome, compatibility, type CheckRunSummary } from "./compat.js";
import { planRecipe, recipeGroup, recipeIssue, recipePullRequestBody, recipeTitle, type RecipePlan } from "./apply.js";
import { buildRecipe, type BuildRecipeResult, type PullRequestFile, type Recipe } from "./recipe.js";
import type { TargetStatus } from "./rollout.js";

/**
 * Builds the recipe for a promoted experiment from the merged winning-arm pull request
 * (`experiments/<name>/<winner>` → `experiments/<name>/trunk`).
 */
export async function publishRecipe(
  client: GitHubClient,
  repo: RepoRef,
  options: { experiment: string; config: HillClimbConfig; manifest?: ExperimentManifest; ref?: string; previous?: Recipe },
): Promise<BuildRecipeResult> {
  let manifest = options.manifest;
  if (!manifest) {
    const ref = options.ref ?? (await defaultBranch(client, repo));
    const text = await readFileAt(client, repo, manifestPath(options.experiment), ref);
    if (text === undefined) return { error: `${manifestPath(options.experiment)} was not found on ${ref}.` };
    const parsed = parseManifest(text, { config: options.config });
    if (!parsed.manifest) return { error: `Invalid manifest: ${parsed.problems.map((problem) => `${problem.path}: ${problem.message}`).join("; ")}` };
    manifest = parsed.manifest;
  }
  const pulls = await listExperimentPullRequests(client, repo, "all");
  const winner = pulls.find((pull) => pull.experiment === manifest.name && pull.arm === manifest.winner && pull.merged);
  const files = winner ? await paginate<PullRequestFile>(client, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", { ...repo, pull_number: winner.number }, 3) : [];
  return buildRecipe({
    manifest,
    repository: `${repo.owner}/${repo.repo}`,
    files,
    ...(winner ? { pullRequest: winner.number } : {}),
    ...(winner?.closedAt ? { promotedAt: winner.closedAt } : {}),
    ...(options.previous ? { previous: options.previous } : {}),
  });
}

export interface RecipeApplyResult {
  repo: string;
  plan: RecipePlan;
  pullRequest?: number;
  issue?: number;
  copilot?: string;
  /** True when a pull request or issue now exists for the recipe (the target counts as attempted). */
  attempted: boolean;
  configProblems?: string[];
}

export interface ApplyRecipeOptions {
  dryRun?: boolean;
  /** Client authenticated as a Copilot-licensed user to assign adaptation issues to the coding agent. */
  copilotClient?: GitHubClient;
  /** Current compatibility shown in the change (from the rollout); defaults to the recipe's recorded stats. */
  compatibility?: { passed: number; failed: number };
  server?: string;
}

/**
 * Applies a recipe to one target repository, Dependabot-style: deterministic parts become a pull request rebuilt on
 * the target's default branch; anything that needs judgment becomes an issue for a coding agent. Re-running is
 * idempotent (unchanged pull requests and issues are left alone; obsolete ones are closed).
 */
export async function applyRecipe(client: GitHubClient, target: RepoRef, recipe: Recipe, options: ApplyRecipeOptions = {}): Promise<RecipeApplyResult> {
  const name = `${target.owner}/${target.repo}`;
  const branch = await defaultBranch(client, target);
  const remote = await loadRemoteConfig(client, target, branch);
  if (remote.problems.length > 0) {
    return {
      repo: name,
      attempted: false,
      plan: { status: "ignored", reason: `Invalid ${remote.path ?? "configuration"}; fix it before recipes can be applied.`, rules: [], remaining: [], matchedFiles: [] },
      configProblems: remote.problems.map((problem) => `${problem.path}: ${problem.message}`),
    };
  }
  const config: LintConfig = remote.config;
  const snapshot = await loadRepositorySnapshot(client, target, { ref: branch, config });
  const plan = planRecipe({ recipe, input: snapshot.input, config });
  const result: RecipeApplyResult = { repo: name, plan, attempted: false };
  if (options.dryRun) return result;

  const compat = compatibility(options.compatibility ?? recipe.compatibility);
  const render = { compatibility: compat, ...(options.server ? { server: options.server } : {}) };
  const group = recipeGroup(recipe);
  const existingPulls = (await listManagedPullRequests(client, target, {
    baseBranch: branch, branchPrefix: config.fixes.branchPrefix, groups: [group],
  })).filter((pr) => pr.group === group);
  const fixes = { ...config.fixes, labels: [...new Set([...config.fixes.labels, `recipe:${recipe.id}`, ...config.recipes.labels])] };
  const fixPlan = planFixPullRequests(plan.change ? [plan.change] : [], existingPulls, {
    openPullRequestsLimit: 1, baseSha: snapshot.sha, labels: ["cicd-optimizer", ...fixes.labels], reviewers: fixes.reviewers,
  });
  const appliedPulls = await applyFixActions(client, target, fixPlan.actions, {
    baseBranch: branch,
    baseSha: snapshot.sha,
    config: fixes,
    rules: allRules,
    existing: existingPulls,
    render: {
      title: () => recipeTitle(recipe),
      body: (change, context) => recipePullRequestBody(recipe, change, { ...render, ...context }),
    },
  });
  const pull = appliedPulls.find((applied) => applied.action.type !== "close")?.number ?? fixPlan.skipped.find((skip) => skip.number !== undefined)?.number;
  if (pull !== undefined && plan.change) result.pullRequest = pull;

  const wantsIssue = plan.status === "adapt" || plan.status === "partial";
  const existingIssues = (await listManagedIssues(client, target, "recipe")).filter((issue) => issue.fingerprint === recipe.id);
  const desired = wantsIssue
    ? [recipeIssue(recipe, plan, { ...render, config, owner: target.owner, repo: target.repo, sha: snapshot.sha, ...(result.pullRequest !== undefined ? { pullRequest: result.pullRequest } : {}) })]
    : [];
  const issuePlan = planIssueSync(existingIssues, desired, {
    maxOpen: 1,
    closeResolved: true,
    resolvedComment: "This recipe no longer applies here (it was applied, the findings are gone, or the repository opted out).",
  });
  const appliedIssues = await applyIssueActions(client, target, issuePlan.actions, {
    ...(options.copilotClient ? { copilotClient: options.copilotClient } : {}),
    copilot: config.issues.copilot,
  });
  const issue = appliedIssues.find((applied) => applied.action.type !== "close");
  if (issue) {
    result.issue = issue.number;
    if (issue.copilot) result.copilot = issue.copilot;
  } else if (wantsIssue) {
    const open = existingIssues.find((candidate) => candidate.state === "open");
    if (open) result.issue = open.number;
  }
  result.attempted = result.pullRequest !== undefined || result.issue !== undefined;
  return result;
}

/**
 * Current rollout state of a recipe in one target, from the pull request's CI or the adaptation issue's resolution.
 * Only changes for the recipe's current revision count: a new revision is a different change with its own compatibility.
 */
export async function recipeStatus(client: GitHubClient, target: RepoRef, recipe: Recipe, server = "https://github.com"): Promise<TargetStatus> {
  const name = `${target.owner}/${target.repo}`;
  const group = recipeGroup(recipe);
  const revision = String(recipe.revision);
  // Open pull requests are live (re-synced on every apply); closed ones only count for the revision they were opened for.
  const pulls = (await listManagedPullRequests(client, target))
    .filter((pr) => pr.group === group && (pr.state === "open" || findMarker(pr.body, "recipe")?.attributes.revision === revision))
    .sort((a, b) => b.number - a.number);
  const pull = pulls[0];
  if (pull) {
    const url = `${server}/${name}/pull/${pull.number}`;
    if (pull.merged) return { repo: name, state: "passed", number: pull.number, url };
    const sha = pull.headSha ?? pull.commitSha;
    let runs: CheckRunSummary[] = [];
    if (sha) {
      const response = await client.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { ...target, ref: sha, per_page: 100 });
      runs = (response.data as { check_runs?: CheckRunSummary[] }).check_runs ?? [];
    }
    // Ignore our own check so a recipe PR is judged by the target's CI, not by the linter that proposed it.
    const state = classifyOutcome(runs.filter((run) => run.name !== "CI/CD Optimizer"), pull);
    // A PR closed without merging and without CI evidence was declined; count it as not compatible.
    return { repo: name, state: pull.state === "closed" && state === "unknown" ? "failed" : state, number: pull.number, url };
  }
  const issues = (await listManagedIssues(client, target, "recipe"))
    .filter((issue) => issue.fingerprint === recipe.id && (issue.state === "open" || issue.attributes.revision === revision))
    .sort((a, b) => b.number - a.number);
  const issue = issues[0];
  if (issue) return { repo: name, state: classifyIssueOutcome(issue), number: issue.number, url: `${server}/${name}/issues/${issue.number}` };
  return { repo: name, state: "untouched" };
}
