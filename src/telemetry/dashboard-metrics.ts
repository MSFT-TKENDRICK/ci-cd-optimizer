import { computeBaseline } from "./baseline.js";
import {
  comparableHistory,
  diagnoseBaseline,
} from "./context.js";
import { byCompletion } from "./history.js";
import { attributeRun, readyQueueMs } from "./attribution.js";
import type { RunAttribution } from "./attribution.js";
import type { JobSnapshot, WorkflowSnapshot } from "./types.js";

export const DASHBOARD_METRICS_SCHEMA = "cicd-optimizer/dashboard-metrics-v1";
export const DEFAULT_DASHBOARD_HISTORY_LIMIT = 20;
export const MAX_DASHBOARD_HISTORY_LIMIT = 100;

export interface DashboardMetricsInput {
  /** Full collector snapshot; do not reconstruct this from report pages or summaries. */
  snapshot: WorkflowSnapshot;
  /** Optional attribution already computed from this snapshot and its collected logs. */
  attribution?: RunAttribution;
  /** Earlier full snapshots from the same history scope. */
  history?: readonly WorkflowSnapshot[];
  /** Maximum comparable runs retained for median and run-ID drilldown (1-100). */
  historyLimit?: number;
}

export interface DashboardInterval {
  /** Exact collector timestamp; null only when absent or malformed. */
  startedAt: string | null;
  completedAt: string | null;
  /** Collector-reported duration. */
  durationMs: number | null;
  /** Difference between valid timestamps; null if the interval is invalid. */
  intervalDurationMs: number | null;
}

export interface DashboardStep extends DashboardInterval {
  number: number;
  name: string;
  conclusion: string | null;
}

export interface DashboardJob extends DashboardInterval {
  id: number;
  key: string;
  name: string;
  conclusion: string | null;
  queuedAt: string | null;
  queueMs: number | null;
  /** Runner-ready wait after recorded queue entry and known dependencies finish. */
  readyQueueMs: number | null;
  needs: string[];
  runnerName: string | null;
  runnerGroupId: number | null;
  labels: string[] | null;
  critical: boolean | null;
  slackMs: number | null;
  headroomMs: number | null;
  limitedBy: string | null;
  /** All API-reported steps, ordered by start time; no top-N truncation. */
  steps: DashboardStep[];
}

export interface DashboardMetricsProjection {
  schema: typeof DASHBOARD_METRICS_SCHEMA;
  provenance: {
    owner: string;
    repo: string;
    workflowId: number;
    workflowName: string;
    workflowPath: string | null;
    runId: number;
    runAttempt: number;
    headSha: string;
    branch: string | null;
    event: string;
    conclusion: string | null;
    createdAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    collectedAt: string | null;
    collector: string | null;
    htmlUrl: string | null;
  };
  metrics: {
    /** Run execution duration plus the initial queue duration; retries have no known initial queue. */
    queueInclusiveLatencyMs: number | null;
    /** Collector-reported run duration, excluding initial queue time. */
    executionElapsedMs: number | null;
    /** Known only for the first attempt. */
    initialQueueMs: number | null;
    /** Sum of valid observed job durations, even if the job inventory is incomplete. */
    observedRunnerWorkMs: number | null;
    /** Sum of job durations only when the collector confirms a complete, valid job inventory. */
    completeRunnerWorkMs: number | null;
    completeness: {
      runTiming: boolean;
      initialQueue: boolean;
      jobInventory: boolean;
      runnerWork: boolean;
      definitions: boolean;
      criticalPath: boolean;
      /** The collector has no completeness marker for the optional jobs-API step list. */
      stepIntervals: false;
    };
    observedJobCount: number;
    invalidJobDurationCount: number;
    jobsWithSteps: number;
    jobsWithoutSteps: number;
  };
  jobs: DashboardJob[];
  attribution: {
    /** False unless the collected job inventory is complete. */
    available: boolean;
    unavailableReason: "job-inventory-incomplete" | null;
    logCoverage: RunAttribution["coverage"] | null;
    /** All observed findings, including cache/install/container evidence; no top-N truncation. */
    findings: RunAttribution["bottlenecks"];
    gaps: RunAttribution["gaps"];
    technologyEvidence: RunAttribution["bottlenecks"];
  };
  reworkExposure: {
    label: "exposure-not-savings";
    source: "provided-history-and-current-snapshot";
    observedAttempts: number;
    failedAttempts: number;
    /** Observed failed-attempt job work only; null means none of the failed attempts has known work. */
    failedAttemptRunnerWorkMs: number | null;
    failedAttemptsWithKnownWork: number;
    failedAttemptsWithUnknownWork: number;
    workCoverage: "no-failed-attempts" | "complete" | "partial" | "unknown";
    allFailedAttemptInventoriesComplete: boolean;
    failedAttemptsDetail: Array<{
      runId: number;
      runAttempt: number;
      headSha: string;
      observedRunnerWorkMs: number | null;
      jobsComplete: boolean;
    }>;
  };
  comparison: {
    sampleCount: number;
    medianExecutionElapsedMs: number | null;
    medianInitialQueueMs: number | null;
    comparableRunIds: number[];
    examined: number;
    excluded: ReturnType<typeof diagnoseBaseline>["excluded"];
    currentProblem: ReturnType<typeof diagnoseBaseline>["currentProblem"] | null;
  };
}

const validDuration = (value: number | undefined): number | null =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;

function interval(startedAt: string | undefined, completedAt: string | undefined, durationMs: number): DashboardInterval {
  const start = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  const end = completedAt === undefined ? Number.NaN : Date.parse(completedAt);
  const validInterval = Number.isFinite(start) && Number.isFinite(end) && end >= start;
  return {
    startedAt: startedAt !== undefined && Number.isFinite(Date.parse(startedAt)) ? startedAt : null,
    completedAt: completedAt !== undefined && Number.isFinite(Date.parse(completedAt)) ? completedAt : null,
    durationMs: validDuration(durationMs),
    intervalDurationMs: validInterval ? end - start : null,
  };
}

function chronological<T extends DashboardInterval>(items: T[]): T[] {
  return items.sort((left, right) => {
    const leftStart = left.startedAt === null ? Number.POSITIVE_INFINITY : Date.parse(left.startedAt);
    const rightStart = right.startedAt === null ? Number.POSITIVE_INFINITY : Date.parse(right.startedAt);
    return leftStart - rightStart;
  });
}

function observedRunnerWork(snapshot: WorkflowSnapshot): { total: number | null; invalid: number } {
  const durations = snapshot.jobs.map((job) => validDuration(job.durationMs));
  const valid = durations.filter((duration): duration is number => duration !== null);
  const noJobsAndComplete = snapshot.jobs.length === 0 && snapshot.provenance?.jobsComplete === true;
  return { total: valid.length > 0 ? valid.reduce((sum, duration) => sum + duration, 0) : noJobsAndComplete ? 0 : null,
    invalid: durations.length - valid.length };
}

function validRunTiming(snapshot: WorkflowSnapshot): boolean {
  return interval(snapshot.startedAt, snapshot.completedAt, snapshot.durationMs).intervalDurationMs !== null &&
    validDuration(snapshot.durationMs) !== null;
}

function failedAttemptExposure(history: readonly WorkflowSnapshot[], current: WorkflowSnapshot): DashboardMetricsProjection["reworkExposure"] {
  const attempts = new Map<string, WorkflowSnapshot>();
  for (const run of [...history, current].filter((item) =>
    item.owner === current.owner && item.repo === current.repo && item.workflowId === current.workflowId)) {
    attempts.set(JSON.stringify([run.owner, run.repo, run.runId, run.runAttempt]), run);
  }
  const failed = [...attempts.values()].filter((run) => run.conclusion === "failure");
  const details = failed.map((run) => {
    const work = observedRunnerWork(run);
    return {
      runId: run.runId,
      runAttempt: run.runAttempt,
      headSha: run.headSha,
      observedRunnerWorkMs: work.total,
      jobsComplete: run.provenance?.jobsComplete === true && work.invalid === 0,
    };
  });
  const knownWork = details.filter((item) => item.observedRunnerWorkMs !== null);
  const unknownWorkCount = details.length - knownWork.length;
  return {
    label: "exposure-not-savings",
    source: "provided-history-and-current-snapshot",
    observedAttempts: attempts.size,
    failedAttempts: failed.length,
    failedAttemptRunnerWorkMs: failed.length === 0
      ? 0
      : knownWork.length > 0
        ? knownWork.reduce((sum, item) => sum + item.observedRunnerWorkMs!, 0)
        : null,
    failedAttemptsWithKnownWork: knownWork.length,
    failedAttemptsWithUnknownWork: unknownWorkCount,
    workCoverage: failed.length === 0 ? "no-failed-attempts"
      : knownWork.length === 0 ? "unknown"
        : unknownWorkCount > 0 || details.some((item) => !item.jobsComplete) ? "partial" : "complete",
    allFailedAttemptInventoriesComplete: details.every((item) => item.jobsComplete),
    failedAttemptsDetail: details,
  };
}

const TECHNOLOGY_CATEGORIES = new Set([
  "cache-export", "image-load", "layer-cache-miss", "layer-cache-unknown", "package-cache",
  "builder-setup", "builder-teardown", "toolchain-download", "service-startup", "repeated-setup", "repeated-command",
]);

/**
 * Projects a full collected workflow snapshot into dashboard-ready, drilldown-preserving metrics.
 *
 * Queue-inclusive latency is available only when both the run duration and first-attempt queue
 * measurement are known. Runner work is a sum of job execution durations, never queue time.
 * Historical medians use the same successful-first-attempt workload comparability policy as
 * telemetry reports. The caller should pass full snapshots from the collector/history store;
 * report summaries do not preserve enough timestamps or provenance for this projection.
 */
export function projectDashboardMetrics(input: DashboardMetricsInput): DashboardMetricsProjection {
  const { snapshot } = input;
  const history = input.history ?? [];
  const historyLimit = input.historyLimit ?? DEFAULT_DASHBOARD_HISTORY_LIMIT;
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > MAX_DASHBOARD_HISTORY_LIMIT) {
    throw new Error(`Dashboard history limit must be an integer from 1 to ${MAX_DASHBOARD_HISTORY_LIMIT}`);
  }
  const jobInventory = snapshot.provenance?.jobsComplete === true;
  const runTiming = jobInventory && validRunTiming(snapshot);
  const executionElapsedMs = runTiming ? snapshot.durationMs : null;
  const queueKnown = snapshot.runAttempt === 1 && validDuration(snapshot.queueMs ?? undefined) !== null;
  const initialQueueMs = queueKnown ? snapshot.queueMs : null;
  const queueInclusiveLatencyMs = executionElapsedMs !== null && initialQueueMs !== null
    ? executionElapsedMs + initialQueueMs
    : null;
  const work = observedRunnerWork(snapshot);
  const runnerWorkComplete = jobInventory && work.invalid === 0;
  const definitions = snapshot.provenance?.definitionKnown === true;
  const attribution = input.attribution ?? attributeRun(snapshot);
  const criticalPathAvailable = jobInventory && definitions && attribution.jobs.length > 0;
  const attributedById = new Map(attribution.jobs.map((job) => [job.id, job]));

  const jobs = chronological(snapshot.jobs.map((job: JobSnapshot): DashboardJob => {
    const jobAttribution = attributedById.get(job.id);
    const steps = chronological((job.steps ?? []).map((step): DashboardStep => ({
      ...interval(step.startedAt, step.completedAt, step.durationMs),
      number: step.number,
      name: step.name,
      conclusion: step.conclusion,
    })));
    return {
      ...interval(job.startedAt, job.completedAt, job.durationMs),
      id: job.id,
      key: job.key,
      name: job.name,
      conclusion: job.conclusion,
      queuedAt: job.queuedAt && Number.isFinite(Date.parse(job.queuedAt)) ? job.queuedAt : null,
      queueMs: validDuration(job.queueMs),
      readyQueueMs: definitions ? readyQueueMs(job, snapshot.jobs) ?? null : null,
      needs: [...job.needs],
      runnerName: job.runnerName ?? null,
      runnerGroupId: job.runnerGroupId ?? null,
      labels: job.labels ? [...job.labels] : null,
      critical: criticalPathAvailable && jobAttribution ? jobAttribution.critical : null,
      slackMs: criticalPathAvailable && jobAttribution ? jobAttribution.slackMs : null,
      headroomMs: criticalPathAvailable ? jobAttribution?.headroomMs ?? null : null,
      limitedBy: criticalPathAvailable ? jobAttribution?.limitedBy ?? null : null,
      steps,
    };
  }));
  const comparable = comparableHistory(history, snapshot).sort(byCompletion).slice(-historyLimit);
  const baseline = computeBaseline(comparable, snapshot, historyLimit);
  const diagnostic = diagnoseBaseline(history, snapshot);
  const findings = jobInventory ? attribution.bottlenecks : [];

  return {
    schema: DASHBOARD_METRICS_SCHEMA,
    provenance: {
      owner: snapshot.owner,
      repo: snapshot.repo,
      workflowId: snapshot.workflowId,
      workflowName: snapshot.workflowName,
      workflowPath: snapshot.path ?? null,
      runId: snapshot.runId,
      runAttempt: snapshot.runAttempt,
      headSha: snapshot.headSha,
      branch: snapshot.branch,
      event: snapshot.event,
      conclusion: snapshot.conclusion,
      createdAt: snapshot.createdAt && Number.isFinite(Date.parse(snapshot.createdAt)) ? snapshot.createdAt : null,
      startedAt: snapshot.startedAt && Number.isFinite(Date.parse(snapshot.startedAt)) ? snapshot.startedAt : null,
      completedAt: snapshot.completedAt && Number.isFinite(Date.parse(snapshot.completedAt)) ? snapshot.completedAt : null,
      collectedAt: snapshot.provenance?.collectedAt && Number.isFinite(Date.parse(snapshot.provenance.collectedAt))
        ? snapshot.provenance.collectedAt : null,
      collector: snapshot.provenance?.collector ?? null,
      htmlUrl: snapshot.htmlUrl ?? null,
    },
    metrics: {
      queueInclusiveLatencyMs,
      executionElapsedMs,
      initialQueueMs,
      observedRunnerWorkMs: work.total,
      completeRunnerWorkMs: runnerWorkComplete ? work.total : null,
      completeness: {
        runTiming,
        initialQueue: queueKnown,
        jobInventory,
        runnerWork: runnerWorkComplete,
        definitions,
        criticalPath: criticalPathAvailable,
        stepIntervals: false,
      },
      observedJobCount: snapshot.jobs.length,
      invalidJobDurationCount: work.invalid,
      jobsWithSteps: snapshot.jobs.filter((job) => (job.steps?.length ?? 0) > 0).length,
      jobsWithoutSteps: snapshot.jobs.filter((job) => (job.steps?.length ?? 0) === 0).length,
    },
    jobs,
    attribution: {
      available: jobInventory && attribution.jobs.length > 0,
      unavailableReason: jobInventory ? null : "job-inventory-incomplete",
      logCoverage: jobInventory ? attribution.coverage : null,
      findings,
      gaps: jobInventory ? attribution.gaps : [],
      technologyEvidence: jobInventory ? findings.filter((finding) => TECHNOLOGY_CATEGORIES.has(finding.category)) : [],
    },
    reworkExposure: failedAttemptExposure(history, snapshot),
    comparison: {
      sampleCount: baseline?.sampleCount ?? 0,
      medianExecutionElapsedMs: baseline?.medianDurationMs ?? null,
      medianInitialQueueMs: baseline?.medianQueueMs ?? null,
      comparableRunIds: comparable.map((run) => run.runId),
      examined: diagnostic.examined,
      excluded: diagnostic.excluded,
      currentProblem: diagnostic.currentProblem ?? null,
    },
  };
}
