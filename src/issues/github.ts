import type { CopilotAssignment } from "../lint/config.js";
import { ensureLabels, httpStatus, paginate, type GitHubClient, type RepoRef } from "../github/client.js";
import { parseMarker, type ManagedKind } from "./markers.js";
import type { ExistingIssue, IssueAction } from "./plan.js";

export const COPILOT_LOGIN = "copilot-swe-agent[bot]";
export const COPILOT_READY_LABEL = "copilot:ready";

interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  state_reason?: string | null;
  closed_at?: string | null;
  pull_request?: unknown;
  labels?: Array<string | { name?: string }>;
}

export interface ManagedIssue extends ExistingIssue {
  attributes: Record<string, string>;
}

/** Lists issues created by this app (label + hidden marker), excluding pull requests. */
export async function listManagedIssues(client: GitHubClient, repo: RepoRef, kind: ManagedKind): Promise<ManagedIssue[]> {
  const raw = await paginate<RawIssue>(client, "GET /repos/{owner}/{repo}/issues", { ...repo, state: "all", labels: "cicd-optimizer" });
  const result: ManagedIssue[] = [];
  for (const issue of raw) {
    if (issue.pull_request) continue;
    const parsed = parseMarker(issue.body);
    if (!parsed || parsed.kind !== kind) continue;
    result.push({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      stateReason: issue.state_reason ?? null,
      closedAt: issue.closed_at ?? null,
      fingerprint: parsed.fingerprint,
      attributes: parsed.attributes,
      ...(issue.labels ? { copilotPending: issue.labels.some((label) => (typeof label === "string" ? label : label.name) === COPILOT_READY_LABEL) } : {}),
      ...(parsed.attributes.signature !== undefined ? { signature: parsed.attributes.signature } : {}),
    });
  }
  return result;
}

export type CopilotAssignmentResult = "assigned" | "labeled" | "failed";

function hasCopilot(data: unknown): boolean {
  if (!data || typeof data !== "object" || !("assignees" in data) || !Array.isArray(data.assignees)) return false;
  return data.assignees.some((actor: unknown) => actor !== null && typeof actor === "object" && "login" in actor &&
    typeof actor.login === "string" && ["copilot", "copilot-swe-agent", COPILOT_LOGIN].includes(actor.login.toLowerCase()));
}

async function clearPending(client: GitHubClient, repo: RepoRef, number: number): Promise<void> {
  try {
    await client.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
      ...repo, issue_number: number, name: COPILOT_READY_LABEL,
    });
  } catch (error) {
    if (httpStatus(error) !== 404) throw error;
  }
}

/**
 * Assigns the Copilot coding agent. The assignment API requires a *user* token (PAT or user-to-server token of a
 * Copilot-licensed user); installation tokens cannot start agent sessions. Without one, the issue is labeled
 * `copilot:ready` so a workflow holding a user token (see docs/issues-and-alerts.md) can assign it.
 */
export async function assignCopilot(
  issueClient: GitHubClient,
  userClient: GitHubClient | undefined,
  repo: RepoRef,
  issueNumber: number,
  assignment: CopilotAssignment,
): Promise<CopilotAssignmentResult> {
  // A retry after a lost response must not start another agent on already-assigned work.
  const current = await issueClient.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { ...repo, issue_number: issueNumber });
  if (hasCopilot(current.data)) {
    await clearPending(issueClient, repo, issueNumber);
    return "assigned";
  }
  if (userClient) {
    let accepted = false;
    try {
      const response = await userClient.request("POST /repos/{owner}/{repo}/issues/{issue_number}/assignees", {
        ...repo,
        issue_number: issueNumber,
        assignees: [COPILOT_LOGIN],
        agent_assignment: {
          target_repo: `${repo.owner}/${repo.repo}`,
          ...(assignment.baseBranch ? { base_branch: assignment.baseBranch } : {}),
          ...(assignment.customInstructions ? { custom_instructions: assignment.customInstructions } : {}),
          ...(assignment.customAgent ? { custom_agent: assignment.customAgent } : {}),
          ...(assignment.model ? { model: assignment.model } : {}),
        },
      });
      // The REST API can silently ignore an unassignable login even with a 2xx response.
      accepted = hasCopilot(response.data);
    } catch (error) {
      if (![403, 404, 422].includes(httpStatus(error) ?? 0)) throw error;
    }
    if (accepted) {
      await clearPending(issueClient, repo, issueNumber);
      return "assigned";
    }
  }
  await issueClient.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
    ...repo,
    issue_number: issueNumber,
    labels: [COPILOT_READY_LABEL],
  });
  return "labeled";
}

export interface ApplyIssueOptions {
  /** Client authenticated as a Copilot-licensed user, for agent assignment. */
  copilotClient?: GitHubClient;
  copilot?: CopilotAssignment;
}

export interface AppliedIssueAction {
  action: IssueAction;
  number: number;
  copilot?: CopilotAssignmentResult;
}

export async function applyIssueActions(
  client: GitHubClient,
  repo: RepoRef,
  actions: readonly IssueAction[],
  options: ApplyIssueOptions = {},
): Promise<AppliedIssueAction[]> {
  const labels = actions.flatMap((action) => (action.type === "close" ? [] : action.desired.labels));
  if (actions.some((action) => action.type !== "close" && action.desired.assignCopilot)) labels.push(COPILOT_READY_LABEL);
  await ensureLabels(client, repo, labels);
  const applied: AppliedIssueAction[] = [];
  for (const action of actions) {
    if (action.type === "close") {
      await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: action.number, body: action.comment });
      await client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
        ...repo,
        issue_number: action.number,
        state: "closed",
        state_reason: "completed",
      });
      applied.push({ action, number: action.number });
      continue;
    }
    const { desired } = action;
    if (action.type === "assign") {
      applied.push({ action, number: action.number, copilot: await assignCopilot(client, options.copilotClient, repo, action.number, options.copilot ?? {}) });
      continue;
    }
    const handoff = desired.assignCopilot && (action.type !== "update" || action.retryCopilot === true);
    let number: number;
    if (action.type === "create") {
      const response = await client.request("POST /repos/{owner}/{repo}/issues", {
        ...repo,
        title: desired.title,
        body: desired.body,
        // Persist the handoff intent with creation, before an assignment request can fail.
        labels: handoff ? [...new Set([...desired.labels, COPILOT_READY_LABEL])] : desired.labels,
        ...(desired.assignees.length > 0 ? { assignees: desired.assignees } : {}),
      });
      number = (response.data as { number: number }).number;
    } else {
      number = action.number;
      await client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
        ...repo,
        issue_number: number,
        title: desired.title,
        body: desired.body,
        labels: handoff ? [...new Set([...desired.labels, COPILOT_READY_LABEL])] : desired.labels,
        ...(action.type === "reopen" ? { state: "open" } : {}),
      });
      if (action.type === "update" && action.comment) {
        await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: number, body: action.comment });
      }
    }
    const result: AppliedIssueAction = { action, number };
    if (handoff) {
      result.copilot = await assignCopilot(client, options.copilotClient, repo, number, options.copilot ?? {});
    }
    applied.push(result);
  }
  return applied;
}
