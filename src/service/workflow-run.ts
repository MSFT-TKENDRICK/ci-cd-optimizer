import { buildSeries, type DurationAlert } from "../alerts/anomaly.js";
import { planAlertSync } from "../alerts/sync.js";
import type { GitHubClient, RepoRef } from "../github/client.js";
import { defaultBranch, loadRemoteConfig } from "../github/repository.js";
import { applyIssueActions, listManagedIssues, type AppliedIssueAction } from "../issues/github.js";
import type { IssueAction, SkippedIssue } from "../issues/plan.js";
import type { LintConfig } from "../lint/config.js";
import { computeBaseline } from "../telemetry/baseline.js";
import { benchmarkRun, type RunBenchmark } from "../telemetry/benchmark.js";
import { attemptIdentity, byCompletion, latestAttempts } from "../telemetry/history.js";
import { comparableHistory, comparisonKey, diagnoseBaseline, jobBaselines, jobHistoryApplies, summarizeBaselineGap, thinJobHistory } from "../telemetry/context.js";
import { attributeRun, collectJobLogs, type RunAttribution } from "../telemetry/attribution.js";
import { createTelemetryReport } from "../telemetry/report.js";
import { buildWorkflowSnapshot, loadJobDefinitions, loadRunHistory, type WorkflowRunPayload } from "../telemetry/snapshot.js";
import type { TelemetryStore } from "../telemetry/store.js";
import type { BaselineDiagnostic, JobBaseline, WorkflowBaseline, WorkflowSnapshot } from "../telemetry/types.js";
import { matchesGlob } from "../utils.js";
import { publishCheck, TELEMETRY_CHECK_PREFIX } from "./checks.js";
import type { KnowledgeStore } from "../knowledge/types.js";
import { collectRunKnowledge, describeRunKnowledge, type CollectedRunKnowledge, type RunKnowledge } from "./run-knowledge.js";

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
  /** Include bounded snapshots for the read-only dashboard projection. */
  dashboardHistory?: boolean;
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
  /** Why earlier runs were or were not usable as a run-level baseline (mutable history path only). */
  baselineDiagnostic?: BaselineDiagnostic;
  /** Per-job medians that survive unrelated job-set changes (mutable history path only). */
  jobBaselines?: JobBaseline[];
  attribution?: RunAttribution;
  attributionUnavailable?: string;
  dashboardHistory?: WorkflowSnapshot[];
  benchmark?: Omit<RunBenchmark, "schema" | "repositoryId" | "collectedAt">;
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
  let knowledgeComparison: CollectedRunKnowledge["comparison"];
  if (remote.problems.length === 0) {
    const store = options.dryRun ? undefined : await options.knowledgeStore?.();
    if (options.knowledge || store || (options.dryRun && options.knowledgeStore)) {
      const { comparison, ...captured } = await collectRunKnowledge(client, repo, snapshot, config, {
        ...(store ? { store } : {}),
        ...(options.expectedRepositoryId !== undefined ? { expectedRepositoryId: options.expectedRepositoryId } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
      knowledge = captured;
      knowledgeComparison = comparison;
    }
  }
  if (snapshot.jobs.length === 0) {
    if (options.store && !options.dryRun) await options.store.save(snapshot);
    return { status: "skipped", reason: "The run has no completed jobs.", snapshot, ...(knowledge ? { knowledge } : {}), ...(knowledgeSkipped ? { knowledgeSkipped } : {}) };
  }

  const attributionReady = snapshot.provenance?.jobsComplete === true && snapshot.provenance.definitionKnown;
  const attributionUnavailable = attributionReady
    ? undefined
    : "Bottleneck attribution was withheld because the Actions job inventory or workflow job definitions are incomplete.";
  const attribution = attributionReady ? attributeRun(snapshot, await collectJobLogs(client, repo, snapshot)) : undefined;
  if (attribution && snapshot.conclusion !== "success") {
    snapshot.failureAnalysis = {
      categories: [...new Set(attribution.bottlenecks.filter((finding) => finding.category === "generated-artifact-drift").map((finding) => finding.category))],
      jobsWithLogs: attribution.coverage.jobsWithLogs,
      jobs: attribution.coverage.jobs,
    };
  }
  const history = await loadHistory(client, repo, run, snapshot, { limit: historyLimit(config), minSamples: config.alerts.minSamples }, options, knowledgeComparison !== undefined);
  if (knowledgeComparison?.newerAttemptObserved || history.some((item) => item.runId === snapshot.runId && item.runAttempt > snapshot.runAttempt)) {
    return { status: "skipped", reason: "A newer attempt is already recorded.", snapshot, ...(knowledge ? { knowledge } : {}), ...(knowledgeSkipped ? { knowledgeSkipped } : {}) };
  }
  const prior = (knowledgeComparison?.history ?? comparableHistory(history, snapshot)).sort(byCompletion).slice(-historyLimit(config));
  const baseline = computeBaseline(prior, snapshot);
  // The durable knowledge path reports its own per-run exclusions and per-job distributions.
  const diagnostic = knowledgeComparison ? undefined : diagnoseBaseline(history, snapshot);
  const jobs = knowledgeComparison ? [] : jobBaselines(history, snapshot, historyLimit(config));
  const report = createTelemetryReport(snapshot, baseline, {
    ...(diagnostic ? { diagnostic } : {}),
    jobBaselines: jobs,
    ...(attribution ? { attribution } : {}),
    ...(attributionUnavailable ? { attributionUnavailable } : {}),
  }) +
    (knowledge ? describeRunKnowledge(knowledge) : "") +
    (knowledgeSkipped ? "\n\nProject declaration collection was skipped because the repository configuration is invalid." : "");
  const result: WorkflowRunResult = {
    status: "processed", snapshot, samples: prior.length, report, ...(baseline ? { baseline } : {}),
    ...(diagnostic ? { baselineDiagnostic: diagnostic } : {}), ...(jobs.length ? { jobBaselines: jobs } : {}),
    ...(attribution ? { attribution } : {}), ...(attributionUnavailable ? { attributionUnavailable } : {}),
    ...(options.dashboardHistory ? { dashboardHistory: history } : {}),
    benchmark: benchmarkRun(snapshot, attribution, prior.at(-1), history),
    ...(knowledge ? { knowledge } : {}), ...(knowledgeSkipped ? { knowledgeSkipped } : {}),
  };

  const contextKey = knowledgeComparison && knowledge?.durations?.status === "reference-excluded" ? undefined : comparisonKey(snapshot);
  const newerRunObserved = knowledgeComparison?.newerRunObserved || history.some((item) =>
    item.workflowId === snapshot.workflowId && item.branch === snapshot.branch && item.runId !== snapshot.runId && byCompletion(item, snapshot) > 0,
  );
  if (contextKey && !knowledgeComparison?.alertHistoryUncertain && !newerRunObserved && options.alerts !== false && config.alerts.enabled && remote.problems.length === 0 && alertsApply(run, config.alerts.branches, branch)) {
    const series = buildSeries([...prior, snapshot]);
    const existing = await listManagedIssues(client, repo, "alert");
    const branchRuns = latestAttempts(history).filter((item) => item.workflowId === snapshot.workflowId && item.branch === snapshot.branch).slice(-historyLimit(config));
    const activeContexts = branchRuns.length >= historyLimit(config)
      ? new Set(branchRuns.map(comparisonKey).filter((key): key is string => key !== undefined))
      : undefined;
    const plan = planAlertSync({
      contextKey,
      ...(activeContexts ? { activeContexts } : {}),
      owner: repo.owner,
      repo: repo.repo,
      branch: run.head_branch,
      workflowId: snapshot.workflowId,
      workflowName: snapshot.workflowName,
      series,
      existing,
      config: config.alerts,
      now: options.now ?? new Date(),
      copilotAssignable: Boolean(options.copilotClient),
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
      title: headline(snapshot, baseline, diagnostic),
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
  immutableHistory = false,
): Promise<WorkflowSnapshot[]> {
  const query = { owner: repo.owner, repo: repo.repo, workflowId: snapshot.workflowId, branch: snapshot.branch, limit: Math.max(200, limit + 1) };
  const backfill = () => loadRunHistory(client, repo, { workflowId: snapshot.workflowId, branch: snapshot.branch, limit, excludeRunId: run.id });
  // History also serves baseline diagnostics and per-job baselines, so it is loaded even when the run-level
  // comparison key is unavailable; backfill only when a run- or job-level comparison could still use it.
  const comparable = comparisonKey(snapshot) !== undefined || jobHistoryApplies(snapshot);
  const thin = (items: readonly WorkflowSnapshot[]) =>
    (comparisonKey(snapshot) !== undefined && comparableHistory(items, snapshot).length < minSamples) || thinJobHistory(items, snapshot, minSamples);
  const store = options.store;
  if (!store) return !immutableHistory && comparable ? merge(await backfill(), [snapshot], limit + 1) : [snapshot];
  if (!options.dryRun) await store.save(snapshot);
  const [current, stored] = await Promise.all([
    store.history({ ...query, runId: snapshot.runId, limit: 1 }),
    store.history({ ...query, attempts: "all" }),
  ]);
  let history = stored;
  if (!immutableHistory && comparable && thin(history)) {
    const fetched = await backfill();
    const recorded = new Set(history.map(attemptIdentity));
    if (!options.dryRun) for (const item of fetched) if (!recorded.has(attemptIdentity(item))) await store.save(item);
    // Backfilled timings do not replace log-backed evidence already recorded for the same completed attempt.
    history = merge(fetched, history, query.limit);
  }
  return merge(history, [...current, snapshot], query.limit + 1);
}

function merge(left: readonly WorkflowSnapshot[], right: readonly WorkflowSnapshot[], limit: number): WorkflowSnapshot[] {
  const attempts = new Map([...left, ...right].map((run) => [attemptIdentity(run), run]));
  return [...attempts.values()].sort(byCompletion).slice(-limit);
}

function headline(snapshot: WorkflowSnapshot, baseline?: WorkflowBaseline, diagnostic?: BaselineDiagnostic): string {
  const minutes = (snapshot.durationMs / 60_000).toFixed(1);
  if (!baseline || baseline.medianDurationMs === 0) return `${minutes} min (${summarizeBaselineGap(diagnostic)})`;
  const delta = ((snapshot.durationMs - baseline.medianDurationMs) / baseline.medianDurationMs) * 100;
  return `${minutes} min (${delta >= 0 ? "+" : ""}${delta.toFixed(0)}% vs ${baseline.sampleCount}-run median)`;
}
