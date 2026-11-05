import type { FixesConfig } from "../lint/config.js";
import type { AnyRule } from "../lint/types.js";
import { ensureLabels, httpStatus, paginate, type GitHubClient, type RepoRef } from "../github/client.js";
import { branchSha, commitFiles, deleteBranch, pushBranch } from "../github/git.js";
import { parseMarker, updateMarker } from "../issues/markers.js";
import type { FixCommand } from "./commands.js";
import { branchFor, type Dismissals, type ExistingFixPullRequest, type FixAction, type FixChange } from "./plan.js";
import { commitMessage, fixBody, fixTitle } from "./render.js";

export const IGNORED_LABEL = "cicd-optimizer:ignored";

export interface ManagedPullRequest extends ExistingFixPullRequest {
  title: string;
  body: string;
  labels: string[];
  rules: string[];
  ignoredRules: string[];
  ignoredGroup: boolean;
}

interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  draft?: boolean;
  labels?: Array<string | { name?: string }>;
  pull_request?: { merged_at?: string | null };
}

interface RawPull extends RawIssue {
  merged_at?: string | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string };
}

interface FixDiscovery {
  baseBranch: string;
  branchPrefix: string;
  groups: readonly string[];
}

const list = (value: string | undefined) => (value ? value.split(",").filter(Boolean) : []);

/** Labels retain historical PRs; deterministic head/base lookups recover PRs whose initial labeling failed. */
export async function listManagedPullRequests(client: GitHubClient, repo: RepoRef, discovery?: FixDiscovery): Promise<ManagedPullRequest[]> {
  const raw = await paginate<RawIssue>(client, "GET /repos/{owner}/{repo}/issues", { ...repo, state: "all", labels: "cicd-optimizer" });
  const heads = new Map<number, RawPull["head"]>();
  if (discovery) {
    const known = new Set(raw.map((issue) => issue.number));
    for (const group of new Set(discovery.groups)) {
      if (raw.some((issue) => issue.pull_request && issue.state === "open" && parseMarker(issue.body)?.fingerprint === `group:${group}`)) continue;
      const branch = branchFor(group, discovery);
      const pulls = await paginate<RawPull>(client, "GET /repos/{owner}/{repo}/pulls", {
        ...repo, state: "all", head: `${repo.owner}:${branch}`, base: discovery.baseBranch, sort: "created", direction: "desc",
      });
      if (pulls.length === 1000) throw new Error(`Fix PR discovery reached its 1000-result limit for ${branch}; refusing an incomplete reconciliation.`);
      for (const pull of pulls) {
        if (known.has(pull.number) || pull.head.repo?.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase() ||
          pull.head.ref !== branch || pull.base.ref !== discovery.baseBranch) continue;
        const parsed = parseMarker(pull.body);
        if (parsed?.kind !== "fix" || parsed.fingerprint !== `group:${group}` || !parsed.attributes.signature || !parsed.attributes.commit) continue;
        raw.push({ ...pull, pull_request: { merged_at: pull.merged_at ?? null } });
        heads.set(pull.number, pull.head);
        known.add(pull.number);
      }
    }
  }
  const result: ManagedPullRequest[] = [];
  for (const issue of raw) {
    if (!issue.pull_request) continue;
    const parsed = parseMarker(issue.body);
    if (!parsed || parsed.kind !== "fix" || !parsed.fingerprint.startsWith("group:")) continue;
    const pr: ManagedPullRequest = {
      number: issue.number,
      state: issue.state,
      merged: Boolean(issue.pull_request.merged_at),
      group: parsed.fingerprint.slice("group:".length),
      title: issue.title,
      body: issue.body ?? "",
      labels: (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name ?? "")),
      rules: list(parsed.attributes.rules),
      ignoredRules: list(parsed.attributes.ignored),
      ignoredGroup: parsed.attributes.ignoredGroup === "true",
      pendingReviewers: list(parsed.attributes.pendingReviewers),
      ...(issue.draft !== undefined ? { draft: issue.draft } : {}),
      ...(parsed.attributes.signature ? { signature: parsed.attributes.signature } : {}),
      ...(parsed.attributes.commit ? { commitSha: parsed.attributes.commit } : {}),
    };
    if (pr.state === "open") {
      let head: { sha?: string; ref?: string } | undefined = heads.get(pr.number);
      if (!head) {
        const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: pr.number });
        const pull = response.data as { head?: { sha?: string; ref?: string }; draft?: boolean };
        head = pull.head;
        if (pull.draft !== undefined) pr.draft = pull.draft;
      }
      if (head?.sha) pr.headSha = head.sha;
      if (head?.ref) pr.branch = head.ref;
    }
    result.push(pr);
  }
  return result;
}

/** Ignores recorded by `@cicd-optimizer ignore ...` commands; removing the label undoes them. */
export function dismissalsFrom(prs: readonly ManagedPullRequest[]): Dismissals {
  const rules = new Set<string>();
  const groups = new Set<string>();
  for (const pr of prs) {
    if (!pr.labels.includes(IGNORED_LABEL)) continue;
    for (const rule of pr.ignoredRules) rules.add(rule);
    if (pr.ignoredGroup) groups.add(pr.group);
  }
  return { rules, groups };
}

export { commitFiles, pushBranch };

export interface ApplyFixOptions {
  baseBranch: string;
  baseSha: string;
  config: FixesConfig;
  rules: readonly AnyRule[];
  existing: readonly ManagedPullRequest[];
  /** Overrides for callers (such as recipes) that need a different title or body; the body must keep the fix marker. */
  render?: {
    title?: (change: FixChange) => string;
    body?: (change: FixChange, context: { commitSha: string; ignoredRules: string[] }) => string;
  };
}

export interface AppliedFixAction {
  action: FixAction;
  number: number;
  commitSha?: string;
}

async function finishReviewRequests(client: GitHubClient, repo: RepoRef, number: number, group: string, reviewers: readonly string[]): Promise<void> {
  const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: number });
  const { body, draft } = response.data as { body: string | null; draft?: boolean };
  const parsed = parseMarker(body);
  if (!parsed || parsed.kind !== "fix" || parsed.fingerprint !== `group:${group}`) {
    throw new Error(`Fix marker changed on PR #${number}; refusing to overwrite its body.`);
  }
  // GitHub cannot request reviews on a draft. Keep the marker for the next scan after it becomes ready.
  if (!parsed.attributes.pendingReviewers || draft) return;
  if (reviewers.length > 0) {
    const requested = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", { ...repo, pull_number: number });
    const current = requested.data as { users: Array<{ login: string }>; teams: Array<{ slug: string }> };
    const users = new Set(current.users.map((user) => user.login.toLowerCase()));
    const teams = new Set(current.teams.map((team) => team.slug.toLowerCase()));
    const missingUsers = reviewers.filter((reviewer) => !reviewer.includes("/") && !users.has(reviewer.toLowerCase()));
    const missingTeams = reviewers.filter((reviewer) => reviewer.includes("/")).map((team) => team.split("/")[1] as string)
      .filter((team) => !teams.has(team.toLowerCase()));
    if (missingUsers.length > 0 || missingTeams.length > 0) {
      await client.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
        ...repo, pull_number: number, reviewers: missingUsers, team_reviewers: missingTeams,
      });
    }
  }
  await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
    ...repo, pull_number: number, body: updateMarker(body ?? "", "fix", parsed.fingerprint, { pendingReviewers: "" }),
  });
}

export async function applyFixActions(client: GitHubClient, repo: RepoRef, actions: readonly FixAction[], options: ApplyFixOptions): Promise<AppliedFixAction[]> {
  const labels = ["cicd-optimizer", ...options.config.labels];
  const neededLabels = actions.flatMap((action) => action.type === "create" ? labels : action.type === "metadata" ? action.labels : []);
  if (neededLabels.length > 0) await ensureLabels(client, repo, neededLabels);
  const applied: AppliedFixAction[] = [];
  for (const action of actions) {
    if (action.type === "metadata") {
      if (action.labels.length > 0) {
        await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: action.number, labels: action.labels });
      }
      const previous = options.existing.find((pr) => pr.number === action.number);
      const closing = actions.some((candidate) => candidate.type === "close" && candidate.number === action.number);
      if (!closing && !previous?.draft && previous?.pendingReviewers?.length) await finishReviewRequests(client, repo, action.number, action.group, action.reviewers);
      applied.push({ action, number: action.number });
      continue;
    }
    if (action.type === "close") {
      await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: action.number, body: action.comment });
      await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: action.number, state: "closed" });
      await deleteBranch(client, repo, action.branch);
      applied.push({ action, number: action.number });
      continue;
    }
    const { change } = action;
    if (change.branch === options.baseBranch) throw new Error("A fix branch cannot be the repository's base branch.");
    let replaceExistingBranch = false;
    if (action.type === "create") {
      const response = await client.request("GET /repos/{owner}/{repo}/pulls", {
        ...repo, state: "open", head: `${repo.owner}:${change.branch}`, per_page: 100,
      });
      if ((response.data as RawPull[]).some((pull) => pull.head.ref === change.branch &&
        pull.head.repo?.full_name.toLowerCase() === `${repo.owner}/${repo.repo}`.toLowerCase())) {
        throw new Error(`An open PR already uses ${change.branch}; reconcile it before creating another. Its branch was not changed.`);
      }
      try {
        const currentSha = await branchSha(client, repo, change.branch);
        replaceExistingBranch = options.existing.some((pr) => pr.state === "closed" && pr.group === change.group && pr.commitSha === currentSha);
        if (!replaceExistingBranch) throw new Error(`Refusing to overwrite unrecognized or modified branch ${change.branch}; reconcile it before retrying.`);
      } catch (error) {
        if (httpStatus(error) !== 404) throw error;
      }
    }
    const commitSha = await commitFiles(client, repo, options.baseSha, change.files, commitMessage(change));
    await pushBranch(client, repo, change.branch, commitSha, action.type === "update" || replaceExistingBranch);
    const previous = action.type === "update" ? options.existing.find((pr) => pr.number === action.number) : undefined;
    const ignoredRules = previous?.ignoredRules ?? [];
    let body = options.render?.body ? options.render.body(change, { commitSha, ignoredRules }) : fixBody(change, { rules: options.rules, commitSha, ignoredRules });
    const title = options.render?.title ? options.render.title(change) : fixTitle(change);
    if (action.type === "update") {
      await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: action.number, title, body });
      applied.push({ action, number: action.number, commitSha });
      continue;
    }
    if (options.config.reviewers.length > 0) {
      body = updateMarker(body, "fix", `group:${change.group}`, { pendingReviewers: options.config.reviewers.join(",") });
    }
    const created = await client.request("POST /repos/{owner}/{repo}/pulls", {
      ...repo,
      title,
      head: change.branch,
      base: options.baseBranch,
      body,
      draft: options.config.draft,
      maintainer_can_modify: true,
    });
    const number = (created.data as { number: number }).number;
    await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: number, labels });
    if (options.config.reviewers.length > 0) {
      await finishReviewRequests(client, repo, number, change.group, options.config.reviewers);
    }
    applied.push({ action, number, commitSha });
  }
  return applied;
}

export interface CommandOutcome {
  /** Groups to rebuild in the follow-up fix run. */
  rebase: Set<string>;
  recreate: Set<string>;
  /** Whether a fix run should follow (for example after ignoring a rule, so the PR shrinks or closes). */
  recompute: boolean;
  replies: string[];
}

/** Applies `@cicd-optimizer` commands on a fix pull request. Rebuilding is left to the caller's fix run. */
export async function handleFixCommands(client: GitHubClient, repo: RepoRef, pr: ManagedPullRequest, commands: readonly FixCommand[]): Promise<CommandOutcome> {
  const outcome: CommandOutcome = { rebase: new Set(), recreate: new Set(), recompute: false, replies: [] };
  for (const command of commands) {
    switch (command.type) {
      case "rebase":
        outcome.rebase.add(pr.group);
        outcome.recompute = true;
        outcome.replies.push("Rebuilding this pull request on the latest base branch.");
        break;
      case "recreate":
        outcome.recreate.add(pr.group);
        outcome.recompute = true;
        outcome.replies.push("Recreating this pull request; edits made to it will be overwritten.");
        break;
      case "close":
        await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: pr.number, state: "closed" });
        await deleteBranch(client, repo, pr.branch);
        outcome.replies.push("Closed. This change will not be proposed again unless the fixes change.");
        break;
      case "ignore-group":
      case "ignore-rule": {
        const ignoredRules =
          command.type === "ignore-rule" ? [...new Set([...pr.ignoredRules, ...(command.rule ? [command.rule] : pr.rules)])] : pr.ignoredRules;
        const body = updateMarker(pr.body, "fix", `group:${pr.group}`, {
          ignored: ignoredRules.join(","),
          ...(command.type === "ignore-group" ? { ignoredGroup: "true" } : {}),
        });
        await ensureLabels(client, repo, [IGNORED_LABEL]);
        await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
          ...repo,
          pull_number: pr.number,
          body,
          ...(command.type === "ignore-group" ? { state: "closed" } : {}),
        });
        await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: pr.number, labels: [IGNORED_LABEL] });
        pr.body = body;
        pr.ignoredRules = ignoredRules;
        pr.labels = [...new Set([...pr.labels, IGNORED_LABEL])];
        if (command.type === "ignore-group") {
          pr.ignoredGroup = true;
          pr.state = "closed";
          await deleteBranch(client, repo, pr.branch);
          outcome.replies.push(`OK, fixes for the \`${pr.group}\` group will no longer be proposed. Remove the \`${IGNORED_LABEL}\` label to undo.`);
        } else {
          outcome.recompute = true;
          outcome.replies.push(
            `OK, ${ignoredRules.map((rule) => `\`${rule}\``).join(", ")} will no longer be fixed automatically. Remove the \`${IGNORED_LABEL}\` label to undo.`,
          );
        }
        break;
      }
    }
  }
  if (outcome.replies.length > 0) {
    await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: pr.number, body: outcome.replies.join("\n\n") });
  }
  return outcome;
}
