import { buildSeries, type DurationAlert } from "../alerts/anomaly.js";
import { planAlertSync } from "../alerts/sync.js";
import type { GitHubClient, RepoRef } from "../github/client.js";
import { defaultBranch, loadRemoteConfig } from "../github/repository.js";
import { applyIssueActions, listManagedIssues, type AppliedIssueAction } from "../issues/github.js";
import type { IssueAction, SkippedIssue } from "../issues/plan.js";
import type { LintConfig } from "../lint/config.js";
import { computeBaseline } from "../telemetry/baseline.js";
import { byCompletion, latestAttempts } from "../telemetry/history.js";
import { createTelemetryReport } from "../telemetry/report.js";
import { buildWorkflowSnapshot, loadJobDefinitions, loadRunHistory, type WorkflowRunPayload } from "../telemetry/snapshot.js";
import type { TelemetryStore } from "../telemetry/store.js";
import type { WorkflowBaseline, WorkflowSnapshot } from "../telemetry/types.js";
import { matchesGlob } from "../utils.js";
import { publishCheck, TELEMETRY_CHECK_PREFIX } from "./checks.js";

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
  const branch = await defaultBranch(client, repo);
  const remote = await loadRemoteConfig(client, repo, branch);
  const config = remote.config;
  if (!config.enabled) return { status: "disabled" };

  const definitions = await loadJobDefinitions(client, repo, run.path, run.head_sha);
  const snapshot = await buildWorkflowSnapshot(client, repo, run, { definitions });
  if (snapshot.jobs.length === 0) {
    if (options.store && !options.dryRun) await options.store.save(snapshot);
    return { status: "skipped", reason: "The run has no completed jobs.", snapshot };
  }

  const history = await loadHistory(client, repo, run, snapshot, definitions, { limit: historyLimit(config), minSamples: config.alerts.minSamples }, options);
  if (history.some((item) => item.runId === snapshot.runId && item.runAttempt > snapshot.runAttempt)) {
    return { status: "skipped", reason: "A newer attempt is already recorded.", snapshot };
  }
  const prior = history.filter((item) => item.runId !== snapshot.runId);
  const baseline = computeBaseline(prior, snapshot);
  const report = createTelemetryReport(snapshot, baseline);
  const result: WorkflowRunResult = { status: "processed", snapshot, samples: prior.length, report, ...(baseline ? { baseline } : {}) };

  if (options.alerts !== false && config.alerts.enabled && remote.problems.length === 0 && alertsApply(run, config.alerts.branches, branch)) {
    const series = buildSeries([...prior, snapshot]);
    const existing = await listManagedIssues(client, repo, "alert");
    const plan = planAlertSync({
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
  definitions: Awaited<ReturnType<typeof loadJobDefinitions>>,
  { limit, minSamples }: { limit: number; minSamples: number },
  options: WorkflowRunOptions,
): Promise<WorkflowSnapshot[]> {
  const query = { owner: repo.owner, repo: repo.repo, workflowId: snapshot.workflowId, branch: snapshot.branch, limit: limit + 1 };
  const backfill = () => loadRunHistory(client, repo, { workflowId: snapshot.workflowId, branch: snapshot.branch, limit, definitions, excludeRunId: run.id });
  const store = options.store;
  if (!store) return merge(await backfill(), [snapshot], limit + 1);
  if (!options.dryRun) await store.save(snapshot);
  const [current, stored] = await Promise.all([
    store.history({ ...query, runId: snapshot.runId, limit: 1 }),
    store.history(query),
  ]);
  let history = stored;
  if (history.filter((item) => item.runId !== snapshot.runId).length < minSamples) {
    const fetched = await backfill();
    if (!options.dryRun) for (const item of fetched) await store.save(item);
    history = merge(history, fetched, limit + 1);
  }
  return [
    ...merge(history.filter((item) => item.runId !== snapshot.runId), [], limit),
    ...latestAttempts([...current, snapshot]),
  ].sort(byCompletion);
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
