import { ensureLabels, graphql, httpStatus, paginate, type GitHubClient, type RepoRef } from "../github/client.js";
import { branchSha, commitFiles, deleteBranch, updateBranch } from "../github/git.js";
import { marker, parseMarker } from "../issues/markers.js";
import type { SourceFile } from "../lint/types.js";
import type { HillClimbConfig } from "./config.js";
import { renderDecision, type Decision, type DispatchRequest } from "./decide.js";
import { armBranch, manifestPath, parseExperimentRef, renderRubric, scoreRubric, serializeManifest, TRUNK, trunkBranch, type ExperimentManifest } from "./manifest.js";
import type { BranchMeasurement, ExperimentMeasurements } from "./score.js";

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
  headRepository?: string;
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
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
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
        ...(pull.head.repo?.full_name ? { headRepository: pull.head.repo.full_name } : {}),
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

async function cleanupBranch(client: GitHubClient, repo: RepoRef, pull: ExperimentPullRequest, notes: string[]): Promise<void> {
  if (pull.headRepository?.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()) {
    notes.push(`Branch ${pull.head} retained because same-repository ownership could not be verified.`);
    return;
  }
  if (pull.head === pull.base) throw new Error("Refusing cleanup of an experiment's base branch.");
  const open = await client.request("GET /repos/{owner}/{repo}/pulls", {
    ...repo, state: "open", head: `${repo.owner}:${pull.head}`, per_page: 1,
  });
  if (!Array.isArray(open.data)) throw new Error("GitHub did not return the open PRs required for experiment cleanup.");
  if (open.data.length > 0) {
    notes.push(`Branch ${pull.head} retained because an open PR uses it.`);
    return;
  }
  const status = await deleteBranch(client, repo, pull.head, pull.headSha);
  if (status === "changed") notes.push(`Branch ${pull.head} retained because its head changed after grading.`);
}

async function closePull(client: GitHubClient, repo: RepoRef, pull: ExperimentPullRequest, comment: string, notes: string[]): Promise<void> {
  if (pull.state !== "open") return;
  await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: pull.number, body: comment });
  await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: pull.number, state: "closed" });
  await cleanupBranch(client, repo, pull, notes);
}

export interface AppliedDecision {
  action: Decision["action"];
  merged?: number;
  closed: number[];
  dispatched: number;
  notes: string[];
}

function requirePromotionEvidence(manifest: ExperimentManifest, state: ExperimentState, measurements?: ExperimentMeasurements): void {
  const trunk = state.trunk;
  const name = trunkBranch(manifest.name);
  const matches = (pull: ExperimentPullRequest, measurement: BranchMeasurement | undefined) =>
    Boolean(pull.headSha && measurement?.headSha === pull.headSha && measurement?.pullRequest === pull.number);
  if (manifest.status !== "running" || state.name !== manifest.name || !trunk || trunk.state !== "open" ||
    trunk.experiment !== manifest.name || trunk.arm !== TRUNK || trunk.head !== name || trunk.base === name ||
    measurements?.experiment !== manifest.name || measurements.control?.arm !== TRUNK ||
    !matches(trunk, measurements.control) || !Array.isArray(measurements.arms)) {
    throw new Error("Promotion control evidence is missing or stale. Recollect and re-evaluate the experiment before applying a decision.");
  }
  for (const arm of state.arms.filter((pull) => pull.state === "open")) {
    const measured = measurements.arms.filter((item) => item?.arm === arm.arm);
    if (arm.experiment !== manifest.name || !manifest.arms.some((spec) => spec.name === arm.arm) ||
      arm.head !== armBranch(manifest.name, arm.arm) || arm.base !== name ||
      measured.length !== 1 || !matches(arm, measured[0])) {
      throw new Error(`Promotion evidence for ${arm.arm} is missing or stale. Recollect and re-evaluate before applying a decision.`);
    }
  }
}

async function currentPromotionPull(client: GitHubClient, repo: RepoRef, expected: ExperimentPullRequest): Promise<RawPull> {
  const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: expected.number });
  const pull = response.data as RawPull | undefined;
  const repository = `${repo.owner}/${repo.repo}`.toLowerCase();
  if (!pull || pull.number !== expected.number || !expected.nodeId || pull.node_id !== expected.nodeId ||
    pull.state !== "open" || Boolean(pull.merged_at) || typeof pull.draft !== "boolean" || !expected.headSha ||
    expected.headRepository?.toLowerCase() !== repository || pull.head?.repo?.full_name.toLowerCase() !== repository ||
    pull.head.ref !== expected.head || pull.head.sha !== expected.headSha || pull.base?.ref !== expected.base) {
    throw new Error(`Experiment PR #${expected.number} changed or its ownership cannot be verified; recollect before promotion.`);
  }
  return pull;
}

const isMutationPayload = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Executes a grading decision; interrupted multi-write promotions may require operator reconciliation. */
export async function applyDecision(
  client: GitHubClient,
  repo: RepoRef,
  options: { manifest: ExperimentManifest; decision: Decision; state: ExperimentState; config: HillClimbConfig; measurements?: ExperimentMeasurements },
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
    if (!winner || !trunk) throw new Error("Promotion requires an open winner and trunk PR. Recollect the experiment before retrying.");
    requirePromotionEvidence(manifest, state, options.measurements);
    await currentPromotionPull(client, repo, trunk);
    for (const arm of state.arms.filter((pull) => pull.state === "open")) {
      const current = await currentPromotionPull(client, repo, arm);
      if (arm.number === winner.number && current.draft) throw new Error("The winning arm is still a draft; recollect after it is ready.");
    }
    const measured = decision.scores.find((score) => score.arm === decision.winner);
    const response = await client.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
      ...repo,
      pull_number: winner.number,
      merge_method: "squash",
      sha: winner.headSha,
      commit_title: `experiment(${manifest.name}): adopt ${decision.winner} (#${winner.number})`,
      commit_message: `${decision.reason}\n\nWeighted improvement: ${((measured?.deterministic ?? 0) * 100).toFixed(1)}%`,
    });
    const merge = response.data as { merged?: unknown; sha?: unknown } | undefined;
    if (response.status !== 200 || merge?.merged !== true || typeof merge.sha !== "string" || !merge.sha.trim()) {
      throw new Error(`GitHub did not confirm merging winning PR #${winner.number}; reconcile the merge before retrying.`);
    }
    const mergeSha = merge.sha;
    result.merged = winner.number;
    await currentPromotionPull(client, repo, { ...trunk, headSha: mergeSha });
    const mergedCommit = await client.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { ...repo, commit_sha: mergeSha });
    const parents = (mergedCommit.data as { parents?: Array<{ sha?: string }> } | undefined)?.parents;
    if (!Array.isArray(parents) || parents.length !== 1 || parents[0]?.sha !== trunk.headSha) {
      throw new Error("The squash merge is not based on the measured control commit; reconcile it before promotion.");
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
    const sha = await commitFiles(client, repo, mergeSha, [{ path: manifestPath(manifest.name), content: serializeManifest(promoted) }], `experiment(${manifest.name}): promote ${decision.winner}`);
    await updateBranch(client, repo, trunkName, sha, mergeSha);
    const current = await currentPromotionPull(client, repo, { ...trunk, headSha: sha });
    await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: trunk.number, body: experimentBody(promoted, config, report) });
    const labels = [PROMOTE_LABEL, ...config.promotion.labels];
    await ensureLabels(client, repo, labels);
    await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: trunk.number, labels });
    if (current.draft) {
      const ready = await graphql(client, "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }", { id: trunk.nodeId }) as { markPullRequestReadyForReview?: unknown } | undefined;
      if (!isMutationPayload(ready?.markPullRequestReadyForReview)) throw new Error("GitHub did not acknowledge marking the promotion PR ready for review.");
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
    const confirmed = await currentPromotionPull(client, repo, { ...trunk, headSha: sha });
    const recorded = parseMarker(confirmed.body);
    if (confirmed.draft || recorded?.kind !== "experiment" || recorded.fingerprint !== manifest.name ||
      recorded.attributes.status !== "promoted" || recorded.attributes.winner !== decision.winner) {
      throw new Error("The promotion PR metadata was not confirmed; reconcile it before cleanup.");
    }
    if (config.promotion.autoMerge) {
      try {
        const enabled = await graphql(client, "mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId } }", { id: trunk.nodeId }) as { enablePullRequestAutoMerge?: unknown } | undefined;
        if (!isMutationPayload(enabled?.enablePullRequestAutoMerge)) throw new Error("GitHub did not acknowledge enabling auto-merge.");
      } catch (error) {
        result.notes.push(`auto-merge unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await upsertComment(client, repo, trunk.number, manifest.name, report);
    await cleanupBranch(client, repo, winner, result.notes);
    for (const loser of state.arms.filter((arm) => arm.arm !== decision.winner && arm.state === "open")) {
      await currentPromotionPull(client, repo, loser);
      await closePull(client, repo, loser, `Not selected: \`${decision.winner}\` won experiment \`${manifest.name}\`.\n\n${report}`, result.notes);
      result.closed.push(loser.number);
    }
    return result;
  }

  // reject / expire: close everything but keep the pull requests (and their grading comments) as the learning record.
  for (const arm of state.arms) {
    await closePull(client, repo, arm, `Experiment \`${manifest.name}\` ${decision.action === "reject" ? "was rejected" : "expired"}.`, result.notes);
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
    await cleanupBranch(client, repo, trunk, result.notes);
  }
  return result;
}
