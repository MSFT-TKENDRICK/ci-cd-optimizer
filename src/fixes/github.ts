import type { FixesConfig } from "../lint/config.js";
import type { AnyRule } from "../lint/types.js";
import { ensureLabels, httpStatus, paginate, type GitHubClient, type RepoRef } from "../github/client.js";
import { commitFiles, deleteBranch, pushBranch } from "../github/git.js";
import { parseMarker, updateMarker } from "../issues/markers.js";
import type { FixCommand } from "./commands.js";
import type { Dismissals, ExistingFixPullRequest, FixAction, FixChange } from "./plan.js";
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
  labels?: Array<string | { name?: string }>;
  pull_request?: { merged_at?: string | null };
}

const list = (value: string | undefined) => (value ? value.split(",").filter(Boolean) : []);

/** Fix pull requests opened by this app, found via label + marker (cheaper than listing every PR). */
export async function listManagedPullRequests(client: GitHubClient, repo: RepoRef): Promise<ManagedPullRequest[]> {
  const raw = await paginate<RawIssue>(client, "GET /repos/{owner}/{repo}/issues", { ...repo, state: "all", labels: "cicd-optimizer" });
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
      ...(parsed.attributes.signature ? { signature: parsed.attributes.signature } : {}),
      ...(parsed.attributes.commit ? { commitSha: parsed.attributes.commit } : {}),
    };
    if (pr.state === "open") {
      const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: pr.number });
      const head = (response.data as { head?: { sha?: string; ref?: string } }).head;
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

export async function applyFixActions(client: GitHubClient, repo: RepoRef, actions: readonly FixAction[], options: ApplyFixOptions): Promise<AppliedFixAction[]> {
  const labels = ["cicd-optimizer", ...options.config.labels];
  if (actions.some((action) => action.type === "create")) await ensureLabels(client, repo, labels);
  const applied: AppliedFixAction[] = [];
  for (const action of actions) {
    if (action.type === "close") {
      await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: action.number, body: action.comment });
      await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: action.number, state: "closed" });
      await deleteBranch(client, repo, action.branch);
      applied.push({ action, number: action.number });
      continue;
    }
    const { change } = action;
    const commitSha = await commitFiles(client, repo, options.baseSha, change.files, commitMessage(change));
    await pushBranch(client, repo, change.branch, commitSha);
    const previous = action.type === "update" ? options.existing.find((pr) => pr.number === action.number) : undefined;
    const ignoredRules = previous?.ignoredRules ?? [];
    const body = options.render?.body ? options.render.body(change, { commitSha, ignoredRules }) : fixBody(change, { rules: options.rules, commitSha, ignoredRules });
    const title = options.render?.title ? options.render.title(change) : fixTitle(change);
    if (action.type === "update") {
      await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: action.number, title, body });
      applied.push({ action, number: action.number, commitSha });
      continue;
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
      const reviewers = options.config.reviewers.filter((reviewer) => !reviewer.includes("/"));
      const teams = options.config.reviewers.filter((reviewer) => reviewer.includes("/")).map((team) => team.split("/")[1] as string);
      try {
        await client.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
          ...repo,
          pull_number: number,
          reviewers,
          team_reviewers: teams,
        });
      } catch (error) {
        if (httpStatus(error) !== 422) throw error;
      }
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
