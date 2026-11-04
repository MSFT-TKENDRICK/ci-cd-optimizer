import type { DurationAlert, DurationPoint, DurationSeries } from "./anomaly.js";
import { seriesFingerprint } from "./anomaly.js";

export interface AlertRenderContext {
  owner: string;
  repo: string;
  branch?: string | null;
  /** All series of the workflow, keyed by `seriesFingerprint`. */
  series: ReadonlyMap<string, DurationSeries>;
  recoveryRuns: number;
  snoozeDays: number;
  /** Baselines recorded when the issue was opened (series key → median ms); they take precedence. */
  baselines?: Record<string, number>;
  previousIssue?: number;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(Math.abs(ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const sign = ms < 0 ? "-" : "";
  if (hours > 0) return `${sign}${hours}h ${minutes}m`;
  if (minutes > 0) return `${sign}${minutes}m ${seconds}s`;
  return `${sign}${seconds}s`;
}

export function seriesKey(alert: Pick<DurationAlert, "jobKey">): string {
  return alert.jobKey ?? "*";
}

function scope(alert: DurationAlert): string {
  return alert.jobKey === undefined ? "Workflow total" : `Job \`${alert.jobName ?? alert.jobKey}\``;
}

function runUrl(context: AlertRenderContext, runId: number): string {
  return `https://github.com/${context.owner}/${context.repo}/actions/runs/${runId}`;
}

function evidence(alert: DurationAlert): string {
  if (alert.kind === "regression") {
    return `Mann-Whitney U p=${(alert.pValue ?? 1).toPrecision(2)} (${alert.recentRunIds.length} recent vs ${alert.baselineSamples} baseline runs)`;
  }
  return `robust z=${(alert.zScore ?? 0).toFixed(1)} vs ${alert.baselineSamples} runs (MAD ${formatDuration(alert.baselineMadMs)})`;
}

/** Most important alert first: workflow-total alerts, then by relative increase. */
export function primaryAlert(alerts: readonly DurationAlert[]): DurationAlert {
  return [...alerts].sort((a, b) => Number(a.jobKey !== undefined) - Number(b.jobKey !== undefined) || b.increasePercent - a.increasePercent)[0] as DurationAlert;
}

function chart(series: DurationSeries, baselineMs: number, title: string): string[] {
  const points = series.points.slice(-30);
  if (points.length < 2) return [];
  const minutes = (ms: number) => Number((ms / 60000).toFixed(2));
  const values = points.map((point) => minutes(point.durationMs));
  const max = Math.max(...values, minutes(baselineMs));
  return [
    "```mermaid",
    "xychart-beta",
    `  title "${title.replace(/"/g, "'")}"`,
    `  x-axis "Runs (oldest to newest)" 1 --> ${points.length}`,
    `  y-axis "Minutes" 0 --> ${Math.max(1, Math.ceil(max * 1.15))}`,
    `  line [${values.join(", ")}]`,
    `  line [${points.map(() => minutes(baselineMs)).join(", ")}]`,
    "```",
    "",
    "_Lower line: baseline median. Only successful runs are plotted._",
  ];
}

/** Last normal run and first slow run, so the commits in between can be inspected (a poor man's bisect). */
export function suspectRange(alert: DurationAlert, series: DurationSeries | undefined): { good?: DurationPoint; bad?: DurationPoint } {
  if (!series) return {};
  const firstSlowRun = alert.kind === "regression" ? alert.recentRunIds[0] : alert.runId;
  const index = series.points.findIndex((point) => point.runId === firstSlowRun);
  if (index < 0) return {};
  return {
    ...(index > 0 ? { good: series.points[index - 1] as DurationPoint } : {}),
    bad: series.points[index] as DurationPoint,
  };
}

export function renderAlertIssue(workflowName: string, alerts: readonly DurationAlert[], context: AlertRenderContext): { title: string; body: string } {
  const primary = primaryAlert(alerts);
  const critical = alerts.some((alert) => alert.severity === "critical");
  const what = primary.jobKey === undefined ? `"${workflowName}"` : `job "${primary.jobName ?? primary.jobKey}" in "${workflowName}"`;
  const title = `CI slowdown: ${what} is ${Math.round(primary.increasePercent)}% slower (${primary.kind})`;
  const primarySeries = context.series.get(seriesFingerprint(primary));
  const baselineOf = (alert: DurationAlert) => context.baselines?.[seriesKey(alert)] ?? alert.baselineMedianMs;

  const lines = [
    `## CI duration ${primary.kind} in \`${workflowName}\``,
    "",
    `**Severity:** ${critical ? "critical" : "warning"} · **Latest run:** [#${primary.runId}](${runUrl(context, primary.runId)})${context.branch ? ` · **Branch:** \`${context.branch}\`` : ""}`,
    "",
    primary.kind === "regression"
      ? "Recent runs are **consistently** slower than the baseline (a step change), not just a single noisy run."
      : "The latest run took **significantly** longer than the recent baseline.",
    "",
    "| Scope | Kind | Baseline (median) | Observed | Change | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...[...alerts]
      .sort((a, b) => b.increasePercent - a.increasePercent)
      .map(
        (alert) =>
          `| ${scope(alert)} | ${alert.kind} | ${formatDuration(baselineOf(alert))} | ${formatDuration(alert.observedMs)} | +${Math.round(alert.increasePercent)}% (+${formatDuration(alert.increaseMs)}) | ${evidence(alert)} |`,
      ),
    "",
  ];
  if (primarySeries) {
    lines.push("### Duration history", "", ...chart(primarySeries, baselineOf(primary), `${primary.jobName ?? workflowName} duration`), "");
  }

  const { good, bad } = suspectRange(primary, primarySeries);
  lines.push("### Where to look", "");
  if (good?.headSha && bad?.headSha && good.headSha !== bad.headSha) {
    lines.push(
      `- **Suspect commits:** [\`${good.headSha.slice(0, 7)}...${bad.headSha.slice(0, 7)}\`](https://github.com/${context.owner}/${context.repo}/compare/${good.headSha}...${bad.headSha}) (between the last normal run and the first slow run).`,
    );
  }
  if (good) lines.push(`- Last normal run: [#${good.runId}](${runUrl(context, good.runId)}) (${formatDuration(good.durationMs)})`);
  if (bad) lines.push(`- First slow run: [#${bad.runId}](${runUrl(context, bad.runId)}) (${formatDuration(bad.durationMs)})`);
  lines.push(
    "- Common causes: cache misses or evicted caches (check `cache-hit` outputs and the 10 GB cache quota), changed lockfiles that bust dependency/Docker layer caches, new or slower tests, runner image updates (`*-latest` labels), larger checkouts, and queueing on self-hosted runners.",
    "",
    "### Instructions for coding agents",
    "",
    "1. Compare per-step timings of the first slow run with the last normal run (`gh run view <run-id> --json jobs`) and identify the steps whose duration grew.",
    "2. Inspect the suspect commits for changes to workflows, lockfiles, Dockerfiles, test suites, or build configuration that explain the growth.",
    "3. Propose the smallest change that restores the previous duration (for example restore cache keys, add a missing cache, split or shard the slow job). Report before/after timings in the pull request.",
    "4. If the slowdown is expected and accepted (for example, new tests were added intentionally), explain why in a comment instead of changing code.",
    "",
  );
  if (context.previousIssue) lines.push(`_This workflow previously regressed in #${context.previousIssue}._`, "");
  lines.push(
    `<sub>Opened by CI/CD Optimizer from Actions run telemetry. It closes automatically after ${context.recoveryRuns} consecutive runs are back within the baseline. Close as **not planned** to snooze alerts for this workflow for ${context.snoozeDays} days.</sub>`,
  );
  return { title, body: lines.join("\n") };
}
