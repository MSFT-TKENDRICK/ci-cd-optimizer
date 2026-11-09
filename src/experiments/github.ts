import { ensureLabels, graphql, httpStatus, paginate, type GitHubClient, type RepoRef } from "../github/client.js";
import { branchSha, commitFiles, deleteBranch, readFileAt, updateBranch } from "../github/git.js";
import { marker, parseMarker } from "../issues/markers.js";
import type { SourceFile } from "../lint/types.js";
import type { HillClimbConfig } from "./config.js";
import { renderDecision, type Decision, type DispatchRequest } from "./decide.js";
import { armBranch, manifestPath, parseExperimentRef, parseManifest, renderRubric, scoreRubric, serializeManifest, TRUNK, trunkBranch, type ExperimentManifest } from "./manifest.js";
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

async function openExperimentPull(
  client: GitHubClient, repo: RepoRef, manifest: ExperimentManifest, baseBranch: string, config: HillClimbConfig,
): Promise<number> {
  const pull = { ...repo, title: `experiment(${manifest.name}): ${manifest.title}`, head: trunkBranch(manifest.name), base: baseBranch, body: experimentBody(manifest, config), maintainer_can_modify: true };
  const response = await client.request("POST /repos/{owner}/{repo}/pulls", { ...pull, draft: true });
  const number = (response.data as { number?: unknown } | null)?.number;
  if (!Number.isSafeInteger(number) || typeof number !== "number" || number < 1) {
    throw new Error("GitHub did not return the experiment pull request number; inspect the branch before retrying.");
  }
  return number;
}

async function labelExperiment(client: GitHubClient, repo: RepoRef, number: number): Promise<void> {
  await ensureLabels(client, repo, [EXPERIMENT_LABEL]);
  await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: number, labels: [EXPERIMENT_LABEL] });
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
    throw new Error(`Cannot confirm creation of ${trunk} at ${sha}. Inspect that ref before retrying; if it exists at this commit, ` +
      `use experiments resume --experiment ${manifest.name} --expected-head ${sha} --base ${baseBranch}. ${(error as Error).message}`, { cause: error });
  }
  try {
    const number = await openExperimentPull(client, repo, manifest, baseBranch, config);
    await labelExperiment(client, repo, number);
    return { trunk, pullRequest: number, sha };
  } catch (error) {
    throw new Error(`Experiment trunk ${trunk} was retained at ${sha}, but publication did not finish: ${(error as Error).message}. ` +
      `After repairing access, run experiments resume --experiment ${manifest.name} --expected-head ${sha} --base ${baseBranch}.`, { cause: error });
  }
}

/** Repairs interrupted publication without rewriting branches or redispatching arm agents. */
export async function resumeExperiment(
  client: GitHubClient, repo: RepoRef,
  options: { name: string; expectedSha: string; config: HillClimbConfig; baseBranch?: string; now?: Date; dryRun?: boolean },
): Promise<{ trunk: string; sha: string; baseBranch: string; pullRequest?: number; created: boolean }> {
  const { name, config } = options;
  const expectedSha = options.expectedSha.toLowerCase();
  const trunk = trunkBranch(name);
  if (!parseExperimentRef(trunk) || !/^[a-f0-9]{40}$/i.test(expectedSha)) {
    throw new Error("Recovery requires a valid experiment name and its exact 40-character commit SHA.");
  }
  const repository = await client.request("GET /repos/{owner}/{repo}", { ...repo });
  const defaultBranch = (repository.data as { default_branch?: unknown } | null)?.default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch || defaultBranch === trunk) {
    throw new Error("Cannot safely identify the default branch for experiment recovery.");
  }
  const baseBranch = options.baseBranch ?? defaultBranch;
  if (!baseBranch || baseBranch === trunk) throw new Error("An experiment cannot be its own promotion base.");
  await branchSha(client, repo, baseBranch);
  const checkHead = async () => {
    if (await branchSha(client, repo, trunk) !== expectedSha) {
      throw new Error("Experiment trunk changed; inspect its current commit before resuming.");
    }
  };
  await checkHead();
  const text = await readFileAt(client, repo, manifestPath(name), expectedSha);
  if (text === undefined) throw new Error(`No experiment manifest at ${expectedSha}.`);
  const parsed = parseManifest(text, { config });
  const manifest = parsed.manifest;
  if (!manifest || manifest.name !== name || manifest.status !== "running" || manifest.winner || manifest.evidence) {
    throw new Error("Only a valid running experiment without a recorded outcome can be resumed.");
  }
  const rubric = scoreRubric(manifest.rubric.scores, config.rubric);
  const now = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(now) || Date.parse(manifest.createdAt) > now) throw new Error("The experiment creation time is in the future or the recovery clock is invalid.");
  if (!rubric.passed || rubric.missing.length > 0) throw new Error("The experiment no longer meets the configured proposal rubric.");
  if (Date.parse(manifest.expiresAt) <= now || Date.parse(manifest.createdAt) + config.selection.maxAgeDays * 86_400_000 <= now) {
    throw new Error("The experiment has expired; publication cannot be resumed.");
  }
  const history = await paginate<RawPull>(client, "GET /repos/{owner}/{repo}/pulls", {
    ...repo, state: "all", head: `${repo.owner}:${trunk}`,
  });
  const sameRepository = `${repo.owner}/${repo.repo}`.toLowerCase();
  const isExpectedPull = (pull: RawPull | null): boolean => {
    const recorded = parseMarker(pull?.body ?? "");
    return !!pull && Number.isSafeInteger(pull.number) && pull.number > 0 && pull.state === "open" && pull.draft === true && pull.merged_at === null &&
      pull.head?.ref === trunk && pull.head.sha === expectedSha &&
      pull.head.repo?.full_name?.toLowerCase() === sameRepository && pull.base?.ref === baseBranch &&
      recorded?.kind === "experiment" && recorded.fingerprint === name && recorded.attributes.status === "running";
  };
  const matches = history.filter((pull) => pull.head?.ref === trunk);
  if (matches.length > 1) throw new Error("Multiple promotion pull requests use this trunk; reconcile them before resuming.");
  let number: number | undefined;
  const existing = matches[0];
  if (existing) {
    if (!isExpectedPull(existing)) {
      throw new Error("The existing promotion pull request is completed, changed, or not owned by this experiment.");
    }
    number = existing.number;
  } else {
    const open = groupExperiments(await listExperimentPullRequests(client, repo));
    if (open.filter((experiment) => experiment.trunk?.state === "open").length >= config.selection.maxConcurrent) {
      throw new Error("The concurrent experiment budget is already full.");
    }
  }
  if (options.dryRun) return { trunk, sha: expectedSha, baseBranch, ...(number === undefined ? {} : { pullRequest: number }), created: false };
  await checkHead();
  const created = number === undefined;
  number ??= await openExperimentPull(client, repo, manifest, baseBranch, config);
  const verifyPull = async (requireLabel = false) => {
    const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: number });
    const pull = response.data as RawPull | null;
    if (!isExpectedPull(pull) || pull?.number !== number || (requireLabel && !pull?.labels?.some((label) => label.name === EXPERIMENT_LABEL))) {
      throw new Error("Experiment publication is not confirmed at the expected commit; reconcile the pull request before continuing.");
    }
    await checkHead();
  };
  await verifyPull();
  await labelExperiment(client, repo, number);
  await verifyPull(true);
  return { trunk, sha: expectedSha, baseBranch, pullRequest: number, created };
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

async function closeVerifiedPull(client: GitHubClient, repo: RepoRef, pull: ExperimentPullRequest, notes: string[]): Promise<void> {
  await currentExperimentPull(client, repo, pull);
  await client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: pull.number, state: "closed" });
  await currentExperimentPull(client, repo, { ...pull, state: "closed" });
  await cleanupBranch(client, repo, pull, notes);
}

async function closePull(client: GitHubClient, repo: RepoRef, pull: ExperimentPullRequest, comment: string, notes: string[]): Promise<void> {
  if (pull.state !== "open") return;
  await currentExperimentPull(client, repo, pull);
  await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: pull.number, body: comment });
  await closeVerifiedPull(client, repo, pull, notes);
}

export interface AppliedDecision {
  action: Decision["action"];
  merged?: number;
  closed: number[];
  dispatched: number;
  notes: string[];
}

function requireDecisionEvidence(manifest: ExperimentManifest, state: ExperimentState, measurements?: ExperimentMeasurements): void {
  const trunk = state.trunk;
  const name = trunkBranch(manifest.name);
  const matches = (pull: ExperimentPullRequest, measurement: BranchMeasurement | undefined) =>
    Boolean(pull.headSha && measurement?.headSha === pull.headSha && measurement?.pullRequest === pull.number);
  if (manifest.status !== "running" || state.name !== manifest.name || !trunk || trunk.state !== "open" ||
    trunk.experiment !== manifest.name || trunk.arm !== TRUNK || trunk.head !== name || trunk.base === name ||
    measurements?.experiment !== manifest.name || measurements.control?.arm !== TRUNK ||
    !matches(trunk, measurements.control) || !Array.isArray(measurements.arms)) {
    throw new Error("Experiment control evidence is missing or stale. Recollect and re-evaluate the experiment before applying a decision.");
  }
  for (const arm of state.arms.filter((pull) => pull.state === "open")) {
    const measured = measurements.arms.filter((item) => item?.arm === arm.arm);
    if (arm.experiment !== manifest.name || !manifest.arms.some((spec) => spec.name === arm.arm) ||
      arm.head !== armBranch(manifest.name, arm.arm) || arm.base !== name ||
      measured.length !== 1 || !matches(arm, measured[0])) {
      throw new Error(`Experiment evidence for ${arm.arm} is missing or stale. Recollect and re-evaluate before applying a decision.`);
    }
  }
}

async function currentExperimentPull(client: GitHubClient, repo: RepoRef, expected: ExperimentPullRequest): Promise<RawPull> {
  const response = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: expected.number });
  const pull = response.data as RawPull | undefined;
  const repository = `${repo.owner}/${repo.repo}`.toLowerCase();
  if (!pull || pull.number !== expected.number || !expected.nodeId || pull.node_id !== expected.nodeId ||
    pull.state !== expected.state || expected.merged || pull.merged_at !== null || typeof pull.draft !== "boolean" || !expected.headSha ||
    expected.headRepository?.toLowerCase() !== repository || pull.head?.repo?.full_name.toLowerCase() !== repository ||
    pull.head.ref !== expected.head || pull.head.sha !== expected.headSha || pull.base?.ref !== expected.base) {
    const reason = expected.state === "closed" ? "closure was not confirmed; reconcile before cleanup."
      : "changed or its ownership cannot be verified; recollect before applying the decision.";
    throw new Error(`Experiment PR #${expected.number} ${reason}`);
  }
  return pull;
}

const isMutationPayload = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Executes a grading decision; interrupted multi-write promotions may require operator reconciliation. */
export async function applyDecision(
  client: GitHubClient,
  repo: RepoRef,
  options: { manifest: ExperimentManifest; decision: Decision; state: ExperimentState; config: HillClimbConfig; measurements?: ExperimentMeasurements; dispatchClient?: GitHubClient },
): Promise<AppliedDecision> {
  const { manifest, decision, state, config } = options;
  const result: AppliedDecision = { action: decision.action, closed: [], dispatched: 0, notes: [] };
  const report = renderDecision(manifest, decision);
  const trunk = state.trunk;
  if (decision.action === "skip") return result;

  if (decision.action === "wait") {
    result.dispatched = await dispatchRuns(options.dispatchClient ?? client, repo, decision.dispatch);
    if (trunk) await upsertComment(client, repo, trunk.number, manifest.name, report);
    return result;
  }

  if (decision.action === "promote") {
    const winner = state.arms.find((arm) => arm.arm === decision.winner && arm.state === "open");
    if (!winner || !trunk) throw new Error("Promotion requires an open winner and trunk PR. Recollect the experiment before retrying.");
    requireDecisionEvidence(manifest, state, options.measurements);
    await currentExperimentPull(client, repo, trunk);
    for (const arm of state.arms.filter((pull) => pull.state === "open")) {
      const current = await currentExperimentPull(client, repo, arm);
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
    await currentExperimentPull(client, repo, { ...trunk, headSha: mergeSha });
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
    const current = await currentExperimentPull(client, repo, { ...trunk, headSha: sha });
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
    const confirmed = await currentExperimentPull(client, repo, { ...trunk, headSha: sha });
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
      await closePull(client, repo, loser, `Not selected: \`${decision.winner}\` won experiment \`${manifest.name}\`.\n\n${report}`, result.notes);
      result.closed.push(loser.number);
    }
    return result;
  }

  // reject / expire: close everything but keep the pull requests (and their grading comments) as the learning record.
  requireDecisionEvidence(manifest, state, options.measurements);
  if (trunk) await currentExperimentPull(client, repo, trunk);
  for (const arm of state.arms.filter((pull) => pull.state === "open")) await currentExperimentPull(client, repo, arm);
  for (const arm of state.arms) {
    await closePull(client, repo, arm, `Experiment \`${manifest.name}\` ${decision.action === "reject" ? "was rejected" : "expired"}.`, result.notes);
    if (arm.state === "open") result.closed.push(arm.number);
  }
  if (trunk) {
    await currentExperimentPull(client, repo, trunk);
    await upsertComment(client, repo, trunk.number, manifest.name, report);
    const label = OUTCOME_LABELS[decision.action];
    await ensureLabels(client, repo, [label]);
    await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...repo, issue_number: trunk.number, labels: [label] });
    await closeVerifiedPull(client, repo, trunk, result.notes);
    result.closed.push(trunk.number);
  }
  return result;
}
