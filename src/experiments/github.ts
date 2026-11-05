import { ensureLabels, graphql, httpStatus, paginate, type GitHubClient, type RepoRef } from "../github/client.js";
import { branchSha, commitFiles, deleteBranch } from "../github/git.js";
import { marker, parseMarker } from "../issues/markers.js";
import type { SourceFile } from "../lint/types.js";
import type { HillClimbConfig } from "./config.js";
import { renderDecision, type Decision, type DispatchRequest } from "./decide.js";
import { armBranch, manifestPath, parseExperimentRef, renderRubric, scoreRubric, serializeManifest, TRUNK, trunkBranch, type ExperimentManifest } from "./manifest.js";

export const EXPERIMENT_LABEL = "experiment";
export const PROMOTE_LABEL = "experiment:promote";
export const OUTCOME_LABELS = { reject: "experiment:rejected", expire: "experiment:expired" } as const;

export interface ExperimentPullRequest {
  number: number;
  nodeId: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  title: string;
  body: string;
  labels: string[];
  head: string;
  headSha: string;
  base: string;
  experiment: string;
  arm: string;
  closedAt?: string;
}

export interface ExperimentState {
  name: string;
  trunk?: ExperimentPullRequest;
  arms: ExperimentPullRequest[];
}

interface RawPull {
  number: number;
  node_id: string;
  state: "open" | "closed";
  merged_at: string | null;
  closed_at: string | null;
  draft?: boolean;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  head: { ref: string; sha: string };
  base: { ref: string };
}

export async function listExperimentPullRequests(client: GitHubClient, repo: RepoRef, state: "open" | "closed" | "all" = "open"): Promise<ExperimentPullRequest[]> {
  const pulls = await paginate<RawPull>(client, "GET /repos/{owner}/{repo}/pulls", { ...repo, state, sort: "updated", direction: "desc" }, state === "open" ? 10 : 3);
  return pulls.flatMap((pull) => {
    const ref = parseExperimentRef(pull.head.ref);
    if (!ref) return [];
    return [
      {
        number: pull.number,
        nodeId: pull.node_id,
        state: pull.state,
        merged: pull.merged_at !== null,
        draft: pull.draft === true,
        title: pull.title,
        body: pull.body ?? "",
        labels: pull.labels.map((label) => label.name),
        head: pull.head.ref,
        headSha: pull.head.sha,
        base: pull.base.ref,
        experiment: ref.experiment,
        arm: ref.arm,
        ...(pull.closed_at ? { closedAt: pull.closed_at } : {}),
      },
    ];
  });
}

export function groupExperiments(pulls: readonly ExperimentPullRequest[]): ExperimentState[] {
  const byName = new Map<string, ExperimentState>();
  for (const pull of pulls) {
    const state = byName.get(pull.experiment) ?? { name: pull.experiment, arms: [] };
    if (pull.arm === TRUNK) state.trunk ??= pull;
    else if (pull.base === trunkBranch(pull.experiment)) state.arms.push(pull);
    byName.set(pull.experiment, state);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function experimentBody(manifest: ExperimentManifest, config: HillClimbConfig, decision?: string): string {
  const rubric = scoreRubric(manifest.rubric.scores, config.rubric);
  return [
    marker("experiment", manifest.name, { status: manifest.status, kind: manifest.kind, ...(manifest.winner ? { winner: manifest.winner } : {}) }),
    `## 🧪 Experiment: ${manifest.title}`,
    "",
    `**Hypothesis:** ${manifest.hypothesis}`,
    "",
    `**Kind:** \`${manifest.kind}\` · **Rubric score:** ${rubric.score} / 5 · **Expires:** ${manifest.expiresAt.slice(0, 10)}`,
    "",
    "| Arm | Approach |",
    "| --- | --- |",
    ...manifest.arms.map((arm) => `| \`${armBranch(manifest.name, arm.name)}\` | **${arm.title}** — ${arm.approach.replace(/\r?\n/g, " ")} |`),
    "",
    `Arms open pull requests into \`${trunkBranch(manifest.name)}\`. The grader merges the winning arm into this branch and marks this pull request ready for review; merging it promotes the result.`,
    ...(decision ? ["", "---", "", decision] : []),
    "",
    "<details><summary>Rubric</summary>",
    "",
    renderRubric(config.rubric),
    "",
    `Rationale: ${manifest.rubric.rationale || "–"}`,
    "",
    "</details>",
  ].join("\n");
}

export interface CreatedExperiment {
  trunk: string;
  pullRequest: number;
  sha: string;
}

/**
 * Creates `experiments/<name>/trunk` from the base branch with the manifest (and any new benchmark cases) committed,
 * then opens the draft promotion pull request. Arms are created afterwards by the arm workflow.
 */
export async function createExperiment(
  client: GitHubClient,
  repo: RepoRef,
  options: { manifest: ExperimentManifest; baseBranch: string; config: HillClimbConfig; files?: readonly SourceFile[] },
): Promise<CreatedExperiment> {
  const { manifest, baseBranch, config } = options;
  const trunk = trunkBranch(manifest.name);
  const baseSha = await branchSha(client, repo, baseBranch);
  const sha = await commitFiles(
    client,
    repo,
    baseSha,
    [{ path: manifestPath(manifest.name), content: serializeManifest(manifest) }, ...(options.files ?? [])],
    `experiment(${manifest.name}): ${manifest.title}`,
  );
  try {
    await client.request("POST /repos/{owner}/{repo}/git/refs", { ...repo, ref: `refs/heads/${trunk}`, sha });
  } catch (error) {
    if (httpStatus(error) === 422) throw new Error(`Experiment "${manifest.name}" already exists (${trunk}).`, { cause: error });
    throw error;
  }
  const pull = { ...repo, title: `experiment(${manifest.name}): ${manifest.title}`, head: trunk, base: baseBranch, body: experimentBody(manifest, config), maintainer_can_modify: true };
  let response;
  try {
    response = await client.request("POST /repos/{owner}/{repo}/pulls", { ...pull, draft: true });
  } catch (error) {
    // Draft pull requests are unavailable on some plans; fall back to a regular pull request.
    if (httpStatus(error) !== 422) throw error;
    response = await client.request("POST /repos/{owner}/{repo}/pulls", pull);
  }
  const number = (response.data as { number: number }).number;
  await ensureLabels(client, repo, [EXPERIMENT_LABEL]);
  await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: number, labels: [EXPERIMENT_LABEL] });
  return { trunk, pullRequest: number, sha };
}

export async function dispatchRuns(client: GitHubClient, repo: RepoRef, requests: readonly DispatchRequest[], maxPerRequest = 5): Promise<number> {
  let dispatched = 0;
  for (const request of requests) {
    for (let run = 0; run < Math.min(request.runs, maxPerRequest); run += 1) {
      await client.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", { ...repo, workflow_id: request.workflow, ref: request.ref });
      dispatched += 1;
    }
  }
  return dispatched;
}

/** Keeps one bot comment per experiment pull request up to date instead of adding a comment per grading run. */
async function upsertComment(client: GitHubClient, repo: RepoRef, issue: number, name: string, body: string): Promise<void> {
  const comments = await paginate<{ id: number; body?: string }>(client, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: issue }, 3);
  const existing = comments.find((comment) => {
    const parsed = parseMarker(comment.body);
    return parsed?.kind === "experiment" && parsed.fingerprint === name && parsed.attributes.role === "grade";
  });
  const text = `${marker("experiment", name, { role: "grade" })}\n${body}`;
  if (existing) await client.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", { ...repo, comment_id: existing.id, body: text });
  else await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: issue, body: text });
}

async function closePull(client: GitHubClient, repo: RepoRef, pull: ExperimentPullRequest, comment: string): Promise<void> {
  if (pull.state !== "open") return;
  await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: pull.number, body: comment });
  await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: pull.number, state: "closed" });
  await deleteBranch(client, repo, pull.head);
}

export interface AppliedDecision {
  action: Decision["action"];
  merged?: number;
  closed: number[];
  dispatched: number;
  notes: string[];
}

/** Executes a grading decision. Every step is idempotent so a re-run after a partial failure converges. */
export async function applyDecision(
  client: GitHubClient,
  repo: RepoRef,
  options: { manifest: ExperimentManifest; decision: Decision; state: ExperimentState; config: HillClimbConfig },
): Promise<AppliedDecision> {
  const { manifest, decision, state, config } = options;
  const result: AppliedDecision = { action: decision.action, closed: [], dispatched: 0, notes: [] };
  const report = renderDecision(manifest, decision);
  const trunk = state.trunk;
  if (decision.action === "skip") return result;

  if (decision.action === "wait") {
    result.dispatched = await dispatchRuns(client, repo, decision.dispatch);
    if (trunk) await upsertComment(client, repo, trunk.number, manifest.name, report);
    return result;
  }

  if (decision.action === "promote") {
    const winner = state.arms.find((arm) => arm.arm === decision.winner && arm.state === "open");
    if (!winner) {
      result.notes.push(`winning arm ${decision.winner} has no open pull request`);
      return result;
    }
    const measured = decision.scores.find((score) => score.arm === decision.winner);
    await client.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
      ...repo,
      pull_number: winner.number,
      merge_method: "squash",
      sha: winner.headSha,
      commit_title: `experiment(${manifest.name}): adopt ${decision.winner} (#${winner.number})`,
      commit_message: `${decision.reason}\n\nWeighted improvement: ${((measured?.deterministic ?? 0) * 100).toFixed(1)}%`,
    });
    result.merged = winner.number;
    await deleteBranch(client, repo, winner.head);
    for (const loser of state.arms.filter((arm) => arm.arm !== decision.winner)) {
      await closePull(client, repo, loser, `Not selected: \`${decision.winner}\` won experiment \`${manifest.name}\`.\n\n${report}`);
      if (loser.state === "open") result.closed.push(loser.number);
    }
    const promoted: ExperimentManifest = {
      ...manifest,
      status: "promoted",
      winner: decision.winner,
      evidence: {
        improvement: measured?.deterministic ?? 0,
        metrics: (measured?.metrics ?? []).map((metric) => ({
          metric: metric.id,
          delta: metric.delta,
          ...(metric.control !== undefined ? { control: metric.control } : {}),
          ...(metric.arm !== undefined ? { arm: metric.arm } : {}),
          ...(metric.pValue !== undefined ? { pValue: metric.pValue } : {}),
        })),
      },
    };
    const trunkName = trunkBranch(manifest.name);
    const head = await branchSha(client, repo, trunkName);
    const sha = await commitFiles(client, repo, head, [{ path: manifestPath(manifest.name), content: serializeManifest(promoted) }], `experiment(${manifest.name}): promote ${decision.winner}`);
    await client.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", { ...repo, ref: `heads/${trunkName}`, sha, force: false });
    if (trunk) {
      await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: trunk.number, body: experimentBody(promoted, config, report) });
      const labels = [PROMOTE_LABEL, ...config.promotion.labels];
      await ensureLabels(client, repo, labels);
      await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: trunk.number, labels });
      if (trunk.draft) {
        await graphql(client, "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }", { id: trunk.nodeId });
      }
      const users = config.promotion.reviewers.filter((reviewer) => !reviewer.includes("/"));
      const teams = config.promotion.reviewers.filter((reviewer) => reviewer.includes("/")).map((team) => team.split("/")[1] as string);
      if (users.length > 0 || teams.length > 0) {
        try {
          await client.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", { ...repo, pull_number: trunk.number, reviewers: users, team_reviewers: teams });
        } catch (error) {
          if (httpStatus(error) !== 422) throw error;
          result.notes.push("could not request reviewers");
        }
      }
      if (config.promotion.autoMerge) {
        try {
          await graphql(client, "mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId } }", { id: trunk.nodeId });
        } catch (error) {
          result.notes.push(`auto-merge unavailable: ${(error as Error).message}`);
        }
      }
      await upsertComment(client, repo, trunk.number, manifest.name, report);
    }
    return result;
  }

  // reject / expire: close everything but keep the pull requests (and their grading comments) as the learning record.
  for (const arm of state.arms) {
    await closePull(client, repo, arm, `Experiment \`${manifest.name}\` ${decision.action === "reject" ? "was rejected" : "expired"}.`);
    if (arm.state === "open") result.closed.push(arm.number);
  }
  if (trunk) {
    await upsertComment(client, repo, trunk.number, manifest.name, report);
    const label = OUTCOME_LABELS[decision.action];
    await ensureLabels(client, repo, [label]);
    await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: trunk.number, labels: [label] });
    if (trunk.state === "open") {
      await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: trunk.number, state: "closed" });
      result.closed.push(trunk.number);
    }
    await deleteBranch(client, repo, trunk.head);
  }
  return result;
}
