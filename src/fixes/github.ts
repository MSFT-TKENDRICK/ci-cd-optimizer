import type { FixesConfig } from "../lint/config.js";
import type { AnyRule } from "../lint/types.js";
import { ensureLabels, httpStatus, paginate, type GitHubClient, type RepoRef } from "../github/client.js";
import { branchSha, commitFiles, deleteBranch, pushBranch, updateBranch } from "../github/git.js";
import { parseMarker, updateMarker, type Marker } from "../issues/markers.js";
import { mapLimit } from "../utils.js";
import { COMMAND_HELP, type FixCommand } from "./commands.js";
import { branchFor, type BranchCleanup, type CleanupStatus, type Dismissals, type ExistingFixPullRequest, type FixAction, type FixChange, type PendingFixUpdate } from "./plan.js";
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
const CLEANUP_BLOCK = /<!-- cicd-optimizer:cleanup -->[\s\S]*?<!-- \/cicd-optimizer:cleanup -->/;

function isCleanupStatus(value: string | undefined): value is CleanupStatus {
  return value === "pending" || value === "deleted" || value === "missing" || value === "changed" || value === "in-use" || value === "reopened";
}

function branchCleanup(parsed: Marker, number: number): BranchCleanup | undefined {
  const { cleanupBranch, cleanupHead, cleanupStatus } = parsed.attributes;
  if (cleanupBranch === undefined && cleanupHead === undefined && cleanupStatus === undefined) return undefined;
  if (!cleanupBranch || !cleanupHead || !isCleanupStatus(cleanupStatus)) throw new Error(`Incomplete branch cleanup on PR #${number}; reconcile its marker.`);
  return { branch: cleanupBranch, headSha: cleanupHead, status: cleanupStatus };
}

function cleanupBody(body: string, group: string, cleanup: BranchCleanup): string {
  const descriptions: Record<CleanupStatus, string> = {
    pending: "Branch cleanup pending",
    deleted: "Branch deleted at the recorded head",
    missing: "Branch not found; no deletion was needed",
    changed: "Branch retained because its target changed",
    "in-use": "Branch retained because an open PR uses it",
    reopened: "Branch retained because this PR was reopened",
  };
  const notice = `<!-- cicd-optimizer:cleanup -->\n> ${descriptions[cleanup.status]}: \`${cleanup.branch}\` (recorded head \`${cleanup.headSha}\`).\n<!-- /cicd-optimizer:cleanup -->`;
  const marked = updateMarker(body, "fix", `group:${group}`, { cleanupBranch: cleanup.branch, cleanupHead: cleanup.headSha, cleanupStatus: cleanup.status });
  return CLEANUP_BLOCK.test(marked) ? marked.replace(CLEANUP_BLOCK, () => notice) : `${marked}\n\n${notice}`;
}

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

/**
 * Labels and markers are editable by collaborators, so a PR's head is only ours to rewrite or delete when it has the
 * deterministic shape of its group's branch (any prefix, so PRs survive `branchPrefix` changes).
 */
function ownedBranch(ref: string | undefined, group: string, baseRef: string | undefined, discovery?: FixDiscovery): string | undefined {
  const slug = branchFor(group, { branchPrefix: "" });
  if (!ref || !slug || ref === baseRef) return undefined;
  return ref === slug || ref.endsWith(`/${slug}`) || (discovery !== undefined && ref === branchFor(group, discovery)) ? ref : undefined;
}

/**
 * Discovery only reads, so its per-group lookups share a bounded pool instead of costing one serial round trip per group.
 * Eight in flight matches the repository blob fan-out and stays far below GitHub's 100-concurrent-request secondary limit.
 * GitHub's guidance still prefers serial requests, so writes stay serial, a failed lookup stops the queued ones and the
 * scan fails closed (nothing retries).
 */
const DISCOVERY_CONCURRENCY = 8;

/** Labels retain historical PRs; deterministic head/base lookups recover PRs whose initial labeling failed. */
export async function listManagedPullRequests(client: GitHubClient, repo: RepoRef, discovery?: FixDiscovery): Promise<ManagedPullRequest[]> {
  const raw = await paginate<RawIssue>(client, "GET /repos/{owner}/{repo}/issues", { ...repo, state: "all", labels: "cicd-optimizer" });
  const details = new Map<number, RawPull>();
  if (discovery) {
    const known = new Set(raw.map((issue) => issue.number));
    const lookups = await mapLimit([...new Set(discovery.groups)], DISCOVERY_CONCURRENCY, async (group) => {
      const branch = branchFor(group, discovery);
      const pulls = await paginate<RawPull>(client, "GET /repos/{owner}/{repo}/pulls", {
        ...repo, state: "all", head: `${repo.owner}:${branch}`, base: discovery.baseBranch, sort: "created", direction: "desc",
      });
      return { group, branch, pulls };
    });
    // Results keep group order, so adoption is identical to the serial walk this replaces.
    for (const { group, branch, pulls } of lookups) {
      if (pulls.length === 1000) throw new Error(`Fix PR discovery reached its 1000-result limit for ${branch}; refusing an incomplete reconciliation.`);
      for (const pull of pulls) {
        if (known.has(pull.number)) {
          details.set(pull.number, pull);
          continue;
        }
        if (pull.head.repo?.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase() ||
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
    let pull = details.get(issue.number);
    if (!pull) {
      const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: issue.number });
      pull = response.data as RawPull;
    }
    const head = pull.head;
    if (head?.repo?.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()) continue;
    // Closed history also influences declines, dismissals and branch reuse; an issue marker is not ownership evidence.
    issue = { ...issue, ...pull, pull_request: { ...issue.pull_request, ...(pull.merged_at !== undefined ? { merged_at: pull.merged_at } : {}) } };
    parsed = parseMarker(issue.body);
    if (!parsed || parsed.kind !== "fix" || !parsed.fingerprint.startsWith("group:")) continue;
    const pending = pendingUpdate(parsed, issue.number);
    const currentCleanup = branchCleanup(parsed, issue.number);
    const group = parsed.fingerprint.slice("group:".length);
    const branch = ownedBranch(head?.ref, group, pull.base?.ref, discovery);
    const pr: ManagedPullRequest = {
      number: issue.number,
      state: issue.state,
      merged: Boolean(issue.pull_request?.merged_at),
      group,
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
      ...(currentCleanup ? { cleanup: currentCleanup } : {}),
      ...(head?.sha ? { headSha: head.sha } : {}),
      ...(branch ? { branch } : {}),
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
    pull.state !== previous.state || !pull.head?.sha || pull.head.sha !== previous.headSha ||
    (previous.branch !== undefined && pull.head.ref !== previous.branch) || pull.head.repo?.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()) {
    throw new Error(`PR #${previous.number} changed since planning; retry without overwriting its branch or marker.`);
  }
  return { pull, parsed };
}

async function verifyBranchReuse(client: GitHubClient, repo: RepoRef, previous: ManagedPullRequest, baseBranch: string): Promise<void> {
  const { pull, parsed } = await currentFix(client, repo, previous);
  if (pull.state !== "closed" || pull.base?.ref !== baseBranch || parsed.attributes.commit !== pull.head.sha ||
    pendingUpdate(parsed, previous.number) || branchCleanup(parsed, previous.number)?.status === "pending") {
    throw new Error(`PR #${previous.number} does not authorize reuse of this branch and base; reconcile it before retrying.`);
  }
}

async function requireUnusedBranch(client: GitHubClient, repo: RepoRef, branch: string): Promise<void> {
  const response = await client.request("GET /repos/{owner}/{repo}/pulls", {
    ...repo, state: "open", head: `${repo.owner}:${branch}`, per_page: 100,
  });
  if (!Array.isArray(response.data)) throw new Error("GitHub did not return the open PRs required for branch reuse.");
  if ((response.data as RawPull[]).some((pull) => pull.head.ref === branch &&
    pull.head.repo?.full_name.toLowerCase() === `${repo.owner}/${repo.repo}`.toLowerCase())) {
    throw new Error(`An open PR already uses ${branch}; reconcile it before creating another. Its branch was not changed.`);
  }
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

/** The PR-close request also persists the cleanup target, so a retry never adopts a newer branch head. */
async function prepareClose(
  client: GitHubClient, repo: RepoRef, previous: ManagedPullRequest, attributes: Record<string, string> = {}, comment?: string,
): Promise<ManagedPullRequest> {
  if (previous.state === "closed") {
    if (Object.keys(attributes).length === 0) return previous;
    const body = updateMarker(previous.body, "fix", `group:${previous.group}`, attributes);
    await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: previous.number, body });
    return { ...previous, body };
  }
  const { pull } = await currentFix(client, repo, previous);
  if (!previous.headSha || previous.branch === pull.base?.ref) throw new Error("Refusing cleanup of an unknown or base branch.");
  const cleanup: BranchCleanup | undefined = previous.branch ? { branch: previous.branch, headSha: previous.headSha, status: "pending" } : undefined;
  const marked = updateMarker(pull.body ?? "", "fix", `group:${previous.group}`, attributes);
  const body = cleanup ? cleanupBody(marked, previous.group, cleanup) : marked;
  if (comment) await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: previous.number, body: comment });
  await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: previous.number, state: "closed", body });
  return { ...previous, state: "closed", body, ...(cleanup ? { cleanup } : {}) };
}

async function finishBranchCleanup(client: GitHubClient, repo: RepoRef, previous: ManagedPullRequest): Promise<ManagedPullRequest> {
  const expected = previous.cleanup;
  if (!expected || expected.status !== "pending") return previous;
  const read = async () => {
    const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: previous.number });
    const pull = response.data as RawPull;
    const parsed = parseMarker(pull.body);
    const cleanup = parsed ? branchCleanup(parsed, previous.number) : undefined;
    if (parsed?.kind !== "fix" || parsed.fingerprint !== `group:${previous.group}` || !cleanup ||
      cleanup.branch !== expected.branch || cleanup.headSha !== expected.headSha) {
      throw new Error(`Cleanup target changed on PR #${previous.number}; refusing to adopt a different branch or head.`);
    }
    return { pull, cleanup };
  };
  const { pull, cleanup } = await read();
  if (cleanup.status !== "pending") return { ...previous, body: pull.body ?? "", cleanup };
  let status: CleanupStatus;
  if (pull.state !== "closed") status = "reopened";
  else if (pull.head?.repo?.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()) {
    throw new Error(`Cannot verify branch ownership for PR #${previous.number}.`);
  } else if (pull.head.ref !== cleanup.branch) status = "changed";
  else {
    if (cleanup.branch === pull.base?.ref) throw new Error("Refusing cleanup of a PR's base branch.");
    const open = await client.request("GET /repos/{owner}/{repo}/pulls", { ...repo, state: "open", head: `${repo.owner}:${cleanup.branch}`, per_page: 1 });
    if (!Array.isArray(open.data)) throw new Error("GitHub did not return the open PRs required for branch cleanup.");
    status = open.data.length > 0 ? "in-use" : await deleteBranch(client, repo, cleanup.branch, cleanup.headSha);
  }
  const latest = await read();
  if (latest.cleanup.status !== "pending") return { ...previous, body: latest.pull.body ?? "", cleanup: latest.cleanup };
  const finished = { ...cleanup, status };
  const body = cleanupBody(latest.pull.body ?? "", previous.group, finished);
  await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: previous.number, body });
  return { ...previous, body, cleanup: finished };
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
      if (action.cleanup) {
        if (!previous) throw new Error(`Missing PR #${action.number} for branch cleanup.`);
        previous = await finishBranchCleanup(client, repo, previous);
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
      const previous = existing.get(action.number);
      if (!previous) throw new Error(`Missing planned PR #${action.number} for safe closure.`);
      await finishBranchCleanup(client, repo, await prepareClose(client, repo, previous, {}, action.comment));
      applied.push({ action, number: action.number });
      continue;
    }
    const { change } = action;
    const previous = action.type === "update" ? existing.get(action.number) : undefined;
    const branch = action.type === "update" ? previous?.branch : change.branch;
    if (!branch || branch === options.baseBranch) throw new Error("A fix requires a known branch distinct from the repository's base branch.");
    let expectedHead = previous?.headSha;
    let reused: ManagedPullRequest | undefined;
    if (action.type === "update" && !expectedHead) throw new Error(`Missing current head for PR #${action.number}; refusing an unconditional update.`);
    if (action.type === "create") {
      await requireUnusedBranch(client, repo, branch);
      let currentSha: string | undefined;
      try {
        currentSha = await branchSha(client, repo, branch);
        if (!currentSha) throw new Error(`GitHub did not return the current head of ${branch}.`);
      } catch (error) {
        if (httpStatus(error) !== 404) throw error;
      }
      if (currentSha) {
        reused = [...existing.values()].find((pr) => pr.state === "closed" && pr.group === change.group &&
          pr.branch === branch && pr.commitSha === currentSha && pr.headSha === currentSha);
        if (!reused) throw new Error(`Refusing to overwrite unrecognized or modified branch ${branch}; reconcile it before retrying.`);
        await verifyBranchReuse(client, repo, reused, options.baseBranch);
        expectedHead = currentSha;
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
        cleanupBranch: "", cleanupHead: "", cleanupStatus: "",
        pendingFrom: expectedHead, pendingCommit: commitSha, pendingSignature: change.signature, pendingBase: options.baseSha, pendingRules: change.rules.join(","),
      });
      // Persist the intended rendered body (including recipe markers) before the atomic branch write.
      body = managedBody(`${PENDING_NOTICE}${body}`, (pull.body ?? "").replace(CLEANUP_BLOCK, ""));
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
    if (reused) {
      await verifyBranchReuse(client, repo, reused, options.baseBranch);
      await requireUnusedBranch(client, repo, branch);
    }
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
        Object.assign(pr, await finishBranchCleanup(client, repo, await prepareClose(client, repo, pr)));
        outcome.replies.push("Closed. This change will not be proposed again unless the fixes change.");
        if (!pr.cleanup) outcome.replies.push("No recorded cleanup target; any remaining branch was retained.");
        break;
      case "ignore-group":
      case "ignore-rule": {
        const ignoredRules =
          command.type === "ignore-rule" ? [...new Set([...pr.ignoredRules, ...(command.rule ? [command.rule] : pr.rules)])] : pr.ignoredRules;
        const attributes = {
          ignored: ignoredRules.join(","),
          ...(command.type === "ignore-group" ? { ignoredGroup: "true" } : {}),
        };
        await ensureLabels(client, repo, [IGNORED_LABEL]);
        if (command.type === "ignore-group") Object.assign(pr, await prepareClose(client, repo, pr, attributes));
        else {
          const body = updateMarker(pr.body, "fix", `group:${pr.group}`, attributes);
          await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: pr.number, body });
          pr.body = body;
        }
        await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: pr.number, labels: [IGNORED_LABEL] });
        pr.ignoredRules = ignoredRules;
        pr.labels = [...new Set([...pr.labels, IGNORED_LABEL])];
        if (command.type === "ignore-group") {
          pr.ignoredGroup = true;
          Object.assign(pr, await finishBranchCleanup(client, repo, pr));
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
