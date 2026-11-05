import type { AlertsConfig } from "../lint/config.js";
import type { JobSnapshot, WorkflowSnapshot } from "../telemetry/types.js";
import { byCompletion, latestAttempts } from "../telemetry/history.js";
import { comparisonKey } from "../telemetry/context.js";
import { mad, mannWhitneyGreater, median, robustZ } from "./stats.js";

export interface DurationPoint {
  runId: number;
  completedAt: string;
  durationMs: number;
  headSha?: string;
}

/** A duration time series for a whole workflow (jobKey undefined) or one job, oldest first. */
export interface DurationSeries {
  contextKey?: string;
  workflowId: number;
  workflowName: string;
  jobKey?: string;
  jobName?: string;
  points: DurationPoint[];
}

export type AlertKind = "spike" | "regression";

export interface DurationAlert {
  contextKey?: string;
  kind: AlertKind;
  fingerprint: string;
  severity: "warning" | "critical";
  workflowId: number;
  workflowName: string;
  jobKey?: string;
  jobName?: string;
  runId: number;
  /** The anomalous value: the run duration for spikes, the recent-window median for regressions. */
  observedMs: number;
  baselineMedianMs: number;
  baselineMadMs: number;
  increaseMs: number;
  increasePercent: number;
  zScore?: number;
  pValue?: number;
  baselineSamples: number;
  recentRunIds: number[];
}

export type AlertSettings = Pick<
  AlertsConfig,
  "minSamples" | "window" | "zThreshold" | "minIncreasePercent" | "minIncreaseSeconds" | "regressionWindow" | "pValue" | "recoveryRuns"
>;

export function seriesFingerprint(series: Pick<DurationSeries, "workflowId" | "jobKey" | "contextKey">): string {
  return `duration:${series.workflowId}${series.contextKey ? `/${series.contextKey}` : ""}/${series.jobKey ?? "*"}`;
}

/**
 * Builds per-workflow and per-job series from successful runs (failed/cancelled runs stop early and would hide
 * slowdowns). Job keys are stable across runs (matrix legs keep their names), so each leg gets its own series.
 */
/** One successful job per key and run: matrix legs share a key, and the slowest leg is the job's wall time. */
export function slowestPerKey<T extends Pick<JobSnapshot, "key" | "conclusion" | "durationMs">>(jobs: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const job of jobs) {
    if (job.conclusion !== "success") continue;
    const current = byKey.get(job.key);
    if (!current || job.durationMs > current.durationMs) byKey.set(job.key, job);
  }
  return [...byKey.values()];
}

export function buildSeries(snapshots: readonly WorkflowSnapshot[]): DurationSeries[] {
  const ordered = latestAttempts(snapshots)
    .filter((snapshot) => snapshot.conclusion === "success")
    .sort(byCompletion);
  const byKey = new Map<string, DurationSeries>();
  const push = (key: string, base: Omit<DurationSeries, "points">, point: DurationPoint) => {
    const series = byKey.get(key) ?? { ...base, points: [] };
    series.points.push(point);
    byKey.set(key, series);
  };
  for (const snapshot of ordered) {
    const contextKey = comparisonKey(snapshot);
    if (!contextKey) continue;
    const point = { runId: snapshot.runId, completedAt: snapshot.completedAt, headSha: snapshot.headSha };
    push(`${contextKey}/*`, { contextKey, workflowId: snapshot.workflowId, workflowName: snapshot.workflowName }, { ...point, durationMs: snapshot.durationMs });
    for (const job of slowestPerKey(snapshot.jobs)) {
      push(
        `${contextKey}/${job.key}`,
        { contextKey, workflowId: snapshot.workflowId, workflowName: snapshot.workflowName, jobKey: job.key, jobName: job.name },
        { ...point, durationMs: job.durationMs },
      );
    }
  }
  return [...byKey.values()];
}

function magnitude(observed: number, baseline: number, settings: AlertSettings) {
  const increaseMs = observed - baseline;
  const increasePercent = baseline > 0 ? (increaseMs / baseline) * 100 : Number.POSITIVE_INFINITY;
  const material = increaseMs >= settings.minIncreaseSeconds * 1000 && increasePercent >= settings.minIncreasePercent;
  return { increaseMs, increasePercent, material };
}

function base(series: DurationSeries, kind: AlertKind) {
  return {
    ...(series.contextKey ? { contextKey: series.contextKey } : {}),
    kind,
    fingerprint: seriesFingerprint(series),
    workflowId: series.workflowId,
    workflowName: series.workflowName,
    ...(series.jobKey !== undefined ? { jobKey: series.jobKey } : {}),
    ...(series.jobName !== undefined ? { jobName: series.jobName } : {}),
  };
}

/** Floor for MAD so near-constant series do not alert on tiny absolute jitter. */
function madFloor(center: number): number {
  return Math.max(center * 0.02, 1000);
}

/** Single-run spike: robust z-score of the newest run against the previous `window` runs. */
export function detectSpike(series: DurationSeries, settings: AlertSettings): DurationAlert | undefined {
  const latest = series.points.at(-1);
  const history = series.points.slice(0, -1).slice(-settings.window).map((point) => point.durationMs);
  if (!latest || history.length < settings.minSamples) return undefined;
  const center = median(history);
  const deviation = mad(history, center);
  const z = robustZ(latest.durationMs, center, deviation, madFloor(center));
  const { increaseMs, increasePercent, material } = magnitude(latest.durationMs, center, settings);
  if (z <= settings.zThreshold || !material) return undefined;
  return {
    ...base(series, "spike"),
    // Severity follows magnitude: with the MAD floor, any material increase on a stable series has a large z.
    severity: increasePercent >= 100 ? "critical" : "warning",
    runId: latest.runId,
    observedMs: latest.durationMs,
    baselineMedianMs: center,
    baselineMadMs: deviation,
    increaseMs,
    increasePercent,
    zScore: z,
    baselineSamples: history.length,
    recentRunIds: [latest.runId],
  };
}

/**
 * Sustained regression (step change): the last `regressionWindow` runs are stochastically slower than the
 * preceding `window` runs (one-sided Mann-Whitney U, p < pValue) and the median shift is material. This is the
 * same family of tests Chromium's perf dashboard uses for change points, applied to a fixed recent window.
 */
export function detectRegression(series: DurationSeries, settings: AlertSettings): DurationAlert | undefined {
  const recent = series.points.slice(-settings.regressionWindow);
  const reference = series.points.slice(0, -settings.regressionWindow).slice(-settings.window);
  if (recent.length < settings.regressionWindow || reference.length < settings.minSamples) return undefined;
  const recentValues = recent.map((point) => point.durationMs);
  const referenceValues = reference.map((point) => point.durationMs);
  const center = median(referenceValues);
  const observed = median(recentValues);
  const { increaseMs, increasePercent, material } = magnitude(observed, center, settings);
  if (!material) return undefined;
  const test = mannWhitneyGreater(recentValues, referenceValues);
  if (test.pValue >= settings.pValue) return undefined;
  const latest = recent.at(-1) as DurationPoint;
  return {
    ...base(series, "regression"),
    severity: increasePercent >= 50 ? "critical" : "warning",
    runId: latest.runId,
    observedMs: observed,
    baselineMedianMs: center,
    baselineMadMs: mad(referenceValues, center),
    increaseMs,
    increasePercent,
    pValue: test.pValue,
    baselineSamples: referenceValues.length,
    recentRunIds: recent.map((point) => point.runId),
  };
}

/** A sustained regression takes precedence over a spike for the same series. */
export function detectAnomalies(series: readonly DurationSeries[], settings: AlertSettings): DurationAlert[] {
  const alerts: DurationAlert[] = [];
  for (const entry of series) {
    const alert = detectRegression(entry, settings) ?? detectSpike(entry, settings);
    if (alert) alerts.push(alert);
  }
  return alerts.sort((a, b) => b.increasePercent - a.increasePercent);
}

/** True when the last `recoveryRuns` runs are all back within the non-material band of the alert's baseline. */
export function hasRecovered(series: DurationSeries, baselineMedianMs: number, settings: AlertSettings): boolean {
  const recent = series.points.slice(-settings.recoveryRuns);
  if (recent.length < settings.recoveryRuns) return false;
  return recent.every((point) => !magnitude(point.durationMs, baselineMedianMs, settings).material);
}
