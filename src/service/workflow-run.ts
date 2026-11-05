import { buildSeries, type DurationAlert } from "../alerts/anomaly.js";
import { planAlertSync } from "../alerts/sync.js";
import type { GitHubClient, RepoRef } from "../github/client.js";
import { defaultBranch, loadRemoteConfig } from "../github/repository.js";
import { applyIssueActions, listManagedIssues, type AppliedIssueAction } from "../issues/github.js";
import type { IssueAction, SkippedIssue } from "../issues/plan.js";
import type { LintConfig } from "../lint/config.js";
import { computeBaseline } from "../telemetry/baseline.js";
import { byCompletion, latestAttempts } from "../telemetry/history.js";
import { comparableHistory, comparisonKey } from "../telemetry/context.js";
import { createTelemetryReport } from "../telemetry/report.js";
import { buildWorkflowSnapshot, loadJobDefinitions, loadRunHistory, type WorkflowRunPayload } from "../telemetry/snapshot.js";
import type { TelemetryStore } from "../telemetry/store.js";
import type { WorkflowBaseline, WorkflowSnapshot } from "../telemetry/types.js";
import { matchesGlob } from "../utils.js";
import { publishCheck, TELEMETRY_CHECK_PREFIX } from "./checks.js";
import type { KnowledgeStore } from "../knowledge/types.js";
import { collectRunKnowledge, describeRunKnowledge, type RunKnowledge } from "./run-knowledge.js";

export interface WorkflowRunOptions {
  /** Persists snapshots between runs; without one, history is rebuilt from the Actions API each time. */
  store?: TelemetryStore;
  copilotClient?: GitHubClient;
  now?: Date;
  dryRun?: boolean;
  /** Publish the report as a neutral check run on the run's head commit (default true). */
  check?: boolean;
  /** Set false to skip duration alerting even when enabled in the configuration. */
  alerts?: boolean;
  knowledge?: boolean;
  knowledgeStore?: () => Promise<KnowledgeStore | undefined>;
  expectedRepositoryId?: number;
}

export interface WorkflowRunResult {
  status: "processed" | "disabled" | "skipped";
  reason?: string;
  snapshot?: WorkflowSnapshot;
  baseline?: WorkflowBaseline;
  /** Number of prior runs used for the baseline and anomaly detection. */
  samples?: number;
  report?: string;
  alerts?: { detected: DurationAlert[]; actions: IssueAction[]; skipped: SkippedIssue[]; applied: AppliedIssueAction[] };
  checkRunId?: number;
  knowledge?: RunKnowledge;
  knowledgeSkipped?: "invalid-config";
}

const PULL_REQUEST_EVENTS = new Set(["pull_request", "pull_request_target"]);

/**
 * Whether duration alerts apply to a run. Pull request runs are excluded (their duration depends on the change, and
 * fork branches can share names with the base). `branches` are globs; empty means the default branch only.
 */
export function alertsApply(run: Pick<WorkflowRunPayload, "event" | "head_branch">, branches: readonly string[], defaultBranchName: string): boolean {
  if (PULL_REQUEST_EVENTS.has(run.event) || !run.head_branch) return false;
  const patterns = branches.length > 0 ? branches : [defaultBranchName];
  return patterns.some((pattern) => matchesGlob(run.head_branch as string, pattern));
}

function historyLimit(config: LintConfig): number {
  return Math.max(config.alerts.window + config.alerts.regressionWindow, 20);
}

/**
 * Handles a completed workflow run: snapshot (jobs, steps, runner queue), persist, baseline, Gantt/critical-path
 * report as a check run, and statistically gated duration alerts (spikes and sustained regressions) as issues.
 */
export async function processWorkflowRun(client: GitHubClient, repo: RepoRef, run: WorkflowRunPayload, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
  if (run.status && run.status !== "completed") return { status: "skipped", reason: `Run is ${run.status}.` };
  const branch = await defaultBranch(client, repo, options.expectedRepositoryId);
  const remote = await loadRemoteConfig(client, repo, branch);
  const config = remote.config;
  if (!config.enabled) return { status: "disabled" };

  const definitions = await loadJobDefinitions(client, repo, run.path, run.head_sha);
  const snapshot = await buildWorkflowSnapshot(client, repo, run, { definitions });
  const knowledgeSkipped = remote.problems.length > 0 && (options.knowledge || options.knowledgeStore) ? "invalid-config" as const : undefined;
  let knowledge: RunKnowledge | undefined;
  if (remote.problems.length === 0) {
    const store = options.dryRun ? undefined : await options.knowledgeStore?.();
    if (options.knowledge || store || (options.dryRun && options.knowledgeStore)) {
      knowledge = await collectRunKnowledge(client, repo, snapshot, config, {
        ...(store ? { store } : {}),
        ...(options.expectedRepositoryId !== undefined ? { expectedRepositoryId: options.expectedRepositoryId } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    }
  }
  if (snapshot.jobs.length === 0) {
    if (options.store && !options.dryRun) await options.store.save(snapshot);
    return { status: "skipped", reason: "The run has no completed jobs.", snapshot, ...(knowledge ? { knowledge } : {}), ...(knowledgeSkipped ? { knowledgeSkipped } : {}) };
  }

  const history = await loadHistory(client, repo, run, snapshot, { limit: historyLimit(config), minSamples: config.alerts.minSamples }, options);
  if (history.some((item) => item.runId === snapshot.runId && item.runAttempt > snapshot.runAttempt)) {
    return { status: "skipped", reason: "A newer attempt is already recorded.", snapshot, ...(knowledge ? { knowledge } : {}), ...(knowledgeSkipped ? { knowledgeSkipped } : {}) };
  }
  const prior = comparableHistory(history, snapshot).sort(byCompletion).slice(-historyLimit(config));
  const baseline = computeBaseline(prior, snapshot);
  const report = createTelemetryReport(snapshot, baseline) + (knowledge ? describeRunKnowledge(knowledge) : "") +
    (knowledgeSkipped ? "\n\nProject declaration collection was skipped because the repository configuration is invalid." : "");
  const result: WorkflowRunResult = {
    status: "processed", snapshot, samples: prior.length, report, ...(baseline ? { baseline } : {}),
    ...(knowledge ? { knowledge } : {}), ...(knowledgeSkipped ? { knowledgeSkipped } : {}),
  };

  const contextKey = comparisonKey(snapshot);
  const newerRunObserved = history.some((item) =>
    item.workflowId === snapshot.workflowId && item.branch === snapshot.branch && item.runId !== snapshot.runId && byCompletion(item, snapshot) > 0,
  );
  if (contextKey && !newerRunObserved && options.alerts !== false && config.alerts.enabled && remote.problems.length === 0 && alertsApply(run, config.alerts.branches, branch)) {
    const series = buildSeries([...prior, snapshot]);
    const existing = await listManagedIssues(client, repo, "alert");
    const plan = planAlertSync({
      contextKey,
      owner: repo.owner,
      repo: repo.repo,
      branch: run.head_branch,
      workflowId: snapshot.workflowId,
      workflowName: snapshot.workflowName,
      series,
      existing,
      config: config.alerts,
      now: options.now ?? new Date(),
    });
    const applied = options.dryRun
      ? []
      : await applyIssueActions(client, repo, plan.actions, { ...(options.copilotClient ? { copilotClient: options.copilotClient } : {}), copilot: config.issues.copilot });
    result.alerts = { detected: plan.alerts, actions: plan.actions, skipped: plan.skipped, applied };
  }

  if (options.check !== false && !options.dryRun) {
    result.checkRunId = await publishCheck(client, repo, {
      name: `${TELEMETRY_CHECK_PREFIX} (${snapshot.workflowName})`,
      headSha: snapshot.headSha,
      conclusion: "neutral",
      title: headline(snapshot, baseline),
      summary: report,
      ...(snapshot.htmlUrl ? { detailsUrl: snapshot.htmlUrl } : {}),
    });
  }
  return result;
}

/**
 * Prior runs of the same workflow and branch, oldest first, including the current snapshot. A cold store (fewer than
 * `minSamples` runs) is backfilled from the Actions API, and the backfill persisted, so alerts work from the first event.
 */
async function loadHistory(
  client: GitHubClient,
  repo: RepoRef,
  run: WorkflowRunPayload,
  snapshot: WorkflowSnapshot,
  { limit, minSamples }: { limit: number; minSamples: number },
  options: WorkflowRunOptions,
): Promise<WorkflowSnapshot[]> {
  const query = { owner: repo.owner, repo: repo.repo, workflowId: snapshot.workflowId, branch: snapshot.branch, limit: Math.max(200, limit + 1) };
  const backfill = () => loadRunHistory(client, repo, { workflowId: snapshot.workflowId, branch: snapshot.branch, limit, excludeRunId: run.id });
  const store = options.store;
  if (!store) return comparisonKey(snapshot) ? merge(await backfill(), [snapshot], limit + 1) : [snapshot];
  if (!options.dryRun) await store.save(snapshot);
  if (!comparisonKey(snapshot)) {
    return latestAttempts([...(await store.history({ ...query, runId: snapshot.runId, limit: 1 })), snapshot]);
  }
  const [current, stored] = await Promise.all([
    store.history({ ...query, runId: snapshot.runId, limit: 1 }),
    store.history(query),
  ]);
  let history = stored;
  if (comparisonKey(snapshot) && comparableHistory(history, snapshot).length < minSamples) {
    const fetched = await backfill();
    if (!options.dryRun) for (const item of fetched) await store.save(item);
    history = merge(history, fetched, query.limit);
  }
  return merge(history, [...current, snapshot], query.limit + 1);
}

function merge(left: readonly WorkflowSnapshot[], right: readonly WorkflowSnapshot[], limit: number): WorkflowSnapshot[] {
  return latestAttempts([...left, ...right]).sort(byCompletion).slice(-limit);
}

function headline(snapshot: WorkflowSnapshot, baseline?: WorkflowBaseline): string {
  const minutes = (snapshot.durationMs / 60_000).toFixed(1);
  if (!baseline || baseline.medianDurationMs === 0) return `${minutes} min (no baseline yet)`;
  const delta = ((snapshot.durationMs - baseline.medianDurationMs) / baseline.medianDurationMs) * 100;
  return `${minutes} min (${delta >= 0 ? "+" : ""}${delta.toFixed(0)}% vs ${baseline.sampleCount}-run median)`;
}
