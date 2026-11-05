import type { FixesConfig } from "../lint/config.js";
import type { AnyRule } from "../lint/types.js";
import { ensureLabels, httpStatus, paginate, type GitHubClient, type RepoRef } from "../github/client.js";
import { branchSha, commitFiles, deleteBranch, pushBranch, updateBranch } from "../github/git.js";
import { parseMarker, updateMarker, type Marker } from "../issues/markers.js";
import { COMMAND_HELP, type FixCommand } from "./commands.js";
import { branchFor, type Dismissals, type ExistingFixPullRequest, type FixAction, type FixChange, type PendingFixUpdate } from "./plan.js";
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
const PENDING_NOTICE = "\n\n> **Update pending:** The generated description below describes an intended update. Its branch write has not yet been confirmed.\n\n";
const INTERRUPTED_NOTICE = "\n\n> **Update interrupted:** The intended commit is not the current branch head. The description below may not match the branch; changed heads are protected from automatic replacement.\n\n";
const UPDATE_KEYS = ["pendingFrom", "pendingCommit", "pendingSignature", "pendingBase", "pendingRules"] as const;
const BODY_START = "<!-- cicd-optimizer:fix-body-start -->";
const BODY_END = "<!-- cicd-optimizer:fix-body-end -->";

function managedBody(generated: string, previous = ""): string {
  if (generated.includes(BODY_START) || generated.includes(BODY_END)) throw new Error("Rendered fix content contains reserved body boundaries.");
  const start = previous.indexOf(BODY_START);
  const end = previous.indexOf(BODY_END);
  const wrapped = `${BODY_START}\n${generated}\n${BODY_END}`;
  if (start < 0 && end < 0) {
    // Older generated bodies ended with Commands. Preserve notes appended after that known block.
    const commands = previous.indexOf(COMMAND_HELP);
    return wrapped + (commands >= 0 ? previous.slice(commands + COMMAND_HELP.length) : "");
  }
  if (start < 0 || end < start || start !== previous.lastIndexOf(BODY_START) || end !== previous.lastIndexOf(BODY_END)) {
    throw new Error("Fix body boundaries changed; reconcile the generated section before retrying.");
  }
  return previous.slice(0, start) + wrapped + previous.slice(end + BODY_END.length);
}

function pendingUpdate(parsed: Marker, number: number): PendingFixUpdate | undefined {
  const attrs = parsed.attributes;
  if (!UPDATE_KEYS.some((key) => key in attrs)) return undefined;
  if (!attrs.pendingFrom || !attrs.pendingCommit || !attrs.pendingSignature || !attrs.pendingBase) {
    throw new Error(`Incomplete pending update on PR #${number}; reconcile its fix marker before retrying.`);
  }
  return { fromSha: attrs.pendingFrom, commitSha: attrs.pendingCommit, signature: attrs.pendingSignature, baseSha: attrs.pendingBase, rules: list(attrs.pendingRules) };
}

/** Labels retain historical PRs; deterministic head/base lookups recover PRs whose initial labeling failed. */
export async function listManagedPullRequests(client: GitHubClient, repo: RepoRef, discovery?: FixDiscovery): Promise<ManagedPullRequest[]> {
  const raw = await paginate<RawIssue>(client, "GET /repos/{owner}/{repo}/issues", { ...repo, state: "all", labels: "cicd-optimizer" });
  const details = new Map<number, RawPull>();
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
        details.set(pull.number, pull);
        known.add(pull.number);
      }
    }
  }
  const result: ManagedPullRequest[] = [];
  for (let issue of raw) {
    if (!issue.pull_request) continue;
    let parsed = parseMarker(issue.body);
    if (!parsed || parsed.kind !== "fix" || !parsed.fingerprint.startsWith("group:")) continue;
    const initialAttributes = parsed.attributes;
    let head: RawPull["head"] | undefined;
    if (issue.state === "open" || UPDATE_KEYS.some((key) => key in initialAttributes)) {
      let pull = details.get(issue.number);
      if (!pull) {
        const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: issue.number });
        pull = response.data as RawPull;
      }
      head = pull.head;
      if (head?.repo?.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()) continue;
      // Read body and head together; the issues listing may predate a partially completed update.
      issue = { ...issue, ...pull, pull_request: { ...issue.pull_request, ...(pull.merged_at !== undefined ? { merged_at: pull.merged_at } : {}) } };
      parsed = parseMarker(issue.body);
      if (!parsed || parsed.kind !== "fix" || !parsed.fingerprint.startsWith("group:")) continue;
    }
    const pending = pendingUpdate(parsed, issue.number);
    const pr: ManagedPullRequest = {
      number: issue.number,
      state: issue.state,
      merged: Boolean(issue.pull_request?.merged_at),
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
      ...(pending ? { pendingUpdate: pending } : {}),
      ...(head?.sha ? { headSha: head.sha } : {}),
      ...(head?.ref ? { branch: head.ref } : {}),
    };
    if (pending && head?.sha === pending.commitSha) pr.rules = pending.rules;
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

async function currentFix(client: GitHubClient, repo: RepoRef, previous: ManagedPullRequest): Promise<{ pull: RawPull; parsed: Marker }> {
  const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: previous.number });
  const pull = response.data as RawPull;
  const parsed = parseMarker(pull.body);
  const expected = parseMarker(previous.body);
  if (!parsed || parsed.kind !== "fix" || parsed.fingerprint !== `group:${previous.group}` || !expected ||
    [...new Set([...Object.keys(parsed.attributes), ...Object.keys(expected.attributes)])].some((key) => parsed.attributes[key] !== expected.attributes[key]) ||
    pull.state !== previous.state || !pull.head?.sha || pull.head.sha !== previous.headSha || !previous.branch ||
    pull.head.ref !== previous.branch || pull.head.repo?.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()) {
    throw new Error(`PR #${previous.number} changed since planning; retry without overwriting its branch or marker.`);
  }
  return { pull, parsed };
}

/** Finish or discard a write-ahead intent without writing a ref or regenerating the current body. */
async function finishPendingUpdate(client: GitHubClient, repo: RepoRef, previous: ManagedPullRequest): Promise<ManagedPullRequest> {
  const { pull, parsed } = await currentFix(client, repo, previous);
  const pending = pendingUpdate(parsed, previous.number);
  if (!pending) throw new Error(`Missing pending update on PR #${previous.number}; replan before retrying.`);
  const completed = pull.head.sha === pending.commitSha;
  const attributes: Record<string, string> = Object.fromEntries(UPDATE_KEYS.map((key) => [key, ""]));
  if (completed) Object.assign(attributes, { commit: pending.commitSha, signature: pending.signature, rules: pending.rules.join(",") });
  const body = updateMarker((pull.body ?? "").replace(PENDING_NOTICE, completed ? "\n\n" : INTERRUPTED_NOTICE), "fix", parsed.fingerprint, attributes);
  await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: previous.number, body });
  const recovered = { ...previous, body };
  delete recovered.pendingUpdate;
  if (completed) Object.assign(recovered, { commitSha: pending.commitSha, signature: pending.signature, rules: pending.rules });
  return recovered;
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
  const existing = new Map(options.existing.map((pr) => [pr.number, pr]));
  for (const action of actions) {
    if (action.type === "metadata") {
      let previous = existing.get(action.number);
      if (action.recoverUpdate) {
        if (!previous) throw new Error(`Missing PR #${action.number} for pending-update recovery.`);
        previous = await finishPendingUpdate(client, repo, previous);
        existing.set(action.number, previous);
      }
      if (action.labels.length > 0) {
        await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: action.number, labels: action.labels });
      }
      const closing = actions.some((candidate) => candidate.type === "close" && candidate.number === action.number);
      if (!closing && previous?.state === "open" && !previous.draft && previous.pendingReviewers?.length) {
        await finishReviewRequests(client, repo, action.number, action.group, action.reviewers);
        // Reviewer finalization changes the marker that the following content action will check.
        existing.set(action.number, { ...previous, body: updateMarker(previous.body, "fix", `group:${previous.group}`, { pendingReviewers: "" }), pendingReviewers: [] });
      }
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
    const previous = action.type === "update" ? existing.get(action.number) : undefined;
    const branch = action.type === "update" ? previous?.branch : change.branch;
    if (!branch || branch === options.baseBranch) throw new Error("A fix requires a known branch distinct from the repository's base branch.");
    let expectedHead = previous?.headSha;
    if (action.type === "update" && !expectedHead) throw new Error(`Missing current head for PR #${action.number}; refusing an unconditional update.`);
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
        if (!options.existing.some((pr) => pr.state === "closed" && pr.group === change.group && pr.commitSha === currentSha)) {
          throw new Error(`Refusing to overwrite unrecognized or modified branch ${change.branch}; reconcile it before retrying.`);
        }
        expectedHead = currentSha;
      } catch (error) {
        if (httpStatus(error) !== 404) throw error;
      }
    }
    const commitSha = await commitFiles(client, repo, options.baseSha, change.files, commitMessage(change));
    const ignoredRules = previous?.ignoredRules ?? [];
    let body = options.render?.body ? options.render.body(change, { commitSha, ignoredRules }) : fixBody(change, { rules: options.rules, commitSha, ignoredRules });
    const title = options.render?.title ? options.render.title(change) : fixTitle(change);
    if (action.type === "update") {
      if (!previous || !expectedHead) throw new Error(`Missing planned state for PR #${action.number}.`);
      const { pull, parsed } = await currentFix(client, repo, previous);
      if (pendingUpdate(parsed, action.number)) throw new Error(`PR #${action.number} has an unfinished update; reconcile it before rebuilding.`);
      const rendered = parseMarker(body);
      if (rendered?.kind !== "fix" || rendered.fingerprint !== `group:${change.group}`) throw new Error("An updated fix body must retain its group marker.");
      body = updateMarker(body, "fix", parsed.fingerprint, {
        ...parsed.attributes,
        commit: parsed.attributes.commit ?? "", signature: parsed.attributes.signature ?? "", rules: parsed.attributes.rules ?? "",
        pendingFrom: expectedHead, pendingCommit: commitSha, pendingSignature: change.signature, pendingBase: options.baseSha, pendingRules: change.rules.join(","),
      });
      // Persist the intended rendered body (including recipe markers) before the atomic branch write.
      body = managedBody(`${PENDING_NOTICE}${body}`, pull.body ?? "");
      await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: action.number, title, body });
      const prepared = { ...previous, body, title };
      await currentFix(client, repo, prepared);
      await updateBranch(client, repo, branch, commitSha, expectedHead);
      await finishPendingUpdate(client, repo, { ...prepared, headSha: commitSha });
      applied.push({ action, number: action.number, commitSha });
      continue;
    }
    if (options.config.reviewers.length > 0) {
      body = updateMarker(body, "fix", `group:${change.group}`, { pendingReviewers: options.config.reviewers.join(",") });
    }
    body = managedBody(body);
    if (expectedHead) await updateBranch(client, repo, branch, commitSha, expectedHead);
    else await pushBranch(client, repo, branch, commitSha);
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
