import type { GitHubClient, RepoRef } from "../github/client.js";
import { parseCommands, type FixCommand } from "../fixes/commands.js";
import { handleFixCommands, listManagedPullRequests, type CommandOutcome } from "../fixes/github.js";
import { scanRepository, type ScanOptions, type ScanResult } from "./scan.js";

export interface IssueCommentPayload {
  issue: { number: number; pull_request?: unknown };
  comment: { body?: string | null; author_association?: string; user?: { login?: string; type?: string } | null };
}

export interface CommentResult {
  status: "ignored" | "unauthorized" | "handled";
  reason?: string;
  outcome?: CommandOutcome;
  scan?: ScanResult;
}

/** Same bar as Dependabot: only people with push access can steer the bot's pull requests. */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const REBUILD = new Set<FixCommand["type"]>(["rebase", "recreate"]);

/**
 * Handles `@cicd-optimizer` commands on the app's fix and recipe pull requests. Ignores and closes apply
 * immediately; rebuilds (and ignores that shrink a fix pull request) re-run the fixes-only scan.
 */
export async function handleIssueComment(
  client: GitHubClient,
  repo: RepoRef,
  payload: IssueCommentPayload,
  options: Pick<ScanOptions, "dryRun"> = {},
): Promise<CommentResult> {
  if (!payload.issue.pull_request) return { status: "ignored", reason: "Not a pull request." };
  if (payload.comment.user?.type === "Bot") return { status: "ignored", reason: "Comment from a bot." };
  const commands = parseCommands(payload.comment.body);
  if (commands.length === 0) return { status: "ignored", reason: "No commands." };

  const pr = (await listManagedPullRequests(client, repo)).find((candidate) => candidate.number === payload.issue.number);
  if (!pr) return { status: "ignored", reason: "Not a pull request managed by this app." };
  if (!TRUSTED.has(payload.comment.author_association ?? "")) {
    if (!options.dryRun) {
      await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        ...repo,
        issue_number: pr.number,
        body: `Sorry @${payload.comment.user?.login ?? "there"}, only users with push access to this repository can use \`@cicd-optimizer\` commands.`,
      });
    }
    return { status: "unauthorized" };
  }
  if (options.dryRun) return { status: "handled", reason: `Would run: ${commands.map((command) => command.type).join(", ")}` };

  const recipe = pr.group.startsWith("recipe-");
  const direct = recipe ? commands.filter((command) => !REBUILD.has(command.type)) : commands;
  const outcome = await handleFixCommands(client, repo, pr, direct);
  if (recipe) {
    if (direct.length < commands.length) {
      await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        ...repo,
        issue_number: pr.number,
        body: "Recipe pull requests are rebuilt by the recipe's next rollout run (or `cicd-optimizer recipes apply`), not on demand.",
      });
    }
    return { status: "handled", outcome };
  }
  if (!outcome.recompute) return { status: "handled", outcome };
  const scan = await scanRepository(client, repo, { issues: false, rebase: outcome.rebase, recreate: outcome.recreate });
  return { status: "handled", outcome, scan };
}
