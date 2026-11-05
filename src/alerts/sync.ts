import type { AlertsConfig } from "../lint/config.js";
import { marker, signatureOf } from "../issues/markers.js";
import type { DesiredIssue, ExistingIssue, IssueAction, IssueSyncPlan } from "../issues/plan.js";
import { detectAnomalies, hasRecovered, seriesFingerprint, type DurationAlert, type DurationSeries } from "./anomaly.js";
import { formatDuration, renderAlertIssue, seriesKey } from "./render.js";

export interface ExistingAlertIssue extends ExistingIssue {
  attributes: Record<string, string>;
}

export interface AlertSyncInput {
  contextKey?: string;
  owner: string;
  repo: string;
  branch?: string | null;
  workflowId: number;
  workflowName: string;
  /** Every series of this workflow (workflow total and per job), oldest point first. */
  series: readonly DurationSeries[];
  /** Managed alert issues of the repository (other workflows are ignored). */
  existing: readonly ExistingAlertIssue[];
  /**
   * Contexts observed in a complete recent window of this workflow and branch. Open alerts of other contexts that are
   * absent from it no longer receive runs and are superseded; omit when the window is incomplete.
   */
  activeContexts?: ReadonlySet<string>;
  config: AlertsConfig;
  now: Date;
}

export interface AlertSyncPlan extends IssueSyncPlan {
  alerts: DurationAlert[];
}

export function alertIssueFingerprint(workflowId: number, contextKey?: string): string {
  return `duration:${workflowId}${contextKey ? `/${contextKey}` : ""}`;
}

function readBaselines(issue: ExistingAlertIssue | undefined): Record<string, number> {
  if (!issue?.attributes.baselines) return {};
  try {
    const parsed = JSON.parse(issue.attributes.baselines) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}

function shapeOf(alerts: readonly DurationAlert[]): string {
  return alerts
    .map((alert) => `${seriesKey(alert)}:${alert.kind}:${alert.severity}`)
    .sort()
    .join(",");
}

/**
 * Plans alert issues for one workflow after a run completes (GHAS-style alert lifecycle):
 * - anomalies and no open issue: open one issue per workflow listing every anomalous series, unless the last
 *   issue was dismissed ("not planned") within `snoozeDays`;
 * - anomalies and an open issue: refresh it; comment when the set of anomalous series, kinds, or severities changes;
 * - no anomalies and an open issue: close it once every tracked series has `recoveryRuns` normal runs in a row
 *   relative to the baseline recorded when the issue was opened (detection alone can stop firing once the
 *   slower runs become the new baseline, which must not count as recovery).
 */
export function planAlertSync(input: AlertSyncInput): AlertSyncPlan {
  const fingerprint = alertIssueFingerprint(input.workflowId, input.contextKey);
  const scopedSeries = input.series.filter((series) => series.workflowId === input.workflowId && series.contextKey === input.contextKey);
  const seriesMap = new Map(scopedSeries.map((series) => [seriesFingerprint(series), series]));
  const alerts = detectAnomalies(scopedSeries, input.config);
  const history = input.existing.filter((issue) => issue.fingerprint === fingerprint).sort((a, b) => b.number - a.number);
  const open = history.find((issue) => issue.state === "open");
  // Pre-context alerts (`duration:<id>`) and alerts of an earlier job layout on this branch share the lineage.
  const legacy = alertIssueFingerprint(input.workflowId);
  const related = input.contextKey === undefined ? [] : input.existing.filter((issue) =>
    issue.fingerprint === legacy ||
    (issue.fingerprint.startsWith(`${legacy}/`) && issue.fingerprint !== fingerprint && issue.attributes.branch === (input.branch ?? "")));
  const latestClosed = [...history, ...related].sort((a, b) => b.number - a.number).find((issue) => issue.state === "closed");
  const actions: IssueAction[] = [];
  const plan: AlertSyncPlan = { actions, skipped: [], alerts };
  for (const issue of related) {
    if (issue.state !== "open") continue;
    const stale = issue.fingerprint === legacy || (input.activeContexts !== undefined && !input.activeContexts.has(issue.attributes.context ?? ""));
    if (!stale) continue;
    actions.push({
      type: "close",
      number: issue.number,
      fingerprint: issue.fingerprint,
      comment: "Superseded: this alert tracked a job layout, runner routing, or alert identity that no longer runs on this branch. " +
        "Durations are now compared per workload context; a new alert opens if the slowdown persists.",
    });
  }

  if (alerts.length === 0) {
    if (!open) return plan;
    const baselines = readBaselines(open);
    const keys = Object.keys(baselines);
    const recovered =
      keys.length > 0 &&
      keys.every((key) => {
        const series = seriesMap.get(seriesFingerprint({
          workflowId: input.workflowId, ...(input.contextKey ? { contextKey: input.contextKey } : {}), ...(key === "*" ? {} : { jobKey: key }),
        }));
        return series !== undefined && hasRecovered(series, baselines[key] as number, input.config);
      });
    if (recovered) {
      actions.push({
        type: "close",
        number: open.number,
        fingerprint,
        comment: `Durations are back within the baseline for the last ${input.config.recoveryRuns} runs (${keys
          .map((key) => `${key === "*" ? "workflow" : `\`${key}\``} ≤ ${formatDuration(baselines[key] as number)} + tolerance`)
          .join(", ")}). Closing this alert. :tada:`,
      });
    }
    return plan;
  }

  if (!open && latestClosed?.stateReason === "not_planned" && latestClosed.closedAt) {
    const snoozedUntil = Date.parse(latestClosed.closedAt) + input.config.snoozeDays * 86_400_000;
    if (input.now.getTime() < snoozedUntil) {
      plan.skipped.push({ fingerprint, reason: "dismissed", number: latestClosed.number });
      return plan;
    }
  }

  const baselines = readBaselines(open);
  for (const alert of alerts) baselines[seriesKey(alert)] ??= Math.round(alert.baselineMedianMs);
  const shape = shapeOf(alerts);
  const latestRun = Math.max(...alerts.map((alert) => alert.runId));
  const rendered = renderAlertIssue(input.workflowName, alerts, {
    owner: input.owner,
    repo: input.repo,
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    series: seriesMap,
    recoveryRuns: input.config.recoveryRuns,
    snoozeDays: input.config.snoozeDays,
    baselines,
    ...(!open && latestClosed ? { previousIssue: latestClosed.number } : {}),
  });
  const signature = signatureOf([shape, String(latestRun)]);
  const critical = alerts.some((alert) => alert.severity === "critical");
  const desired: DesiredIssue = {
    fingerprint,
    signature,
    title: rendered.title,
    body: `${marker("alert", fingerprint, { signature, shape, workflow: String(input.workflowId), ...(input.contextKey ? { context: input.contextKey, branch: input.branch ?? "" } : {}), baselines: JSON.stringify(baselines) })}\n${rendered.body}`,
    labels: [...new Set(["cicd-optimizer", "alert:duration", critical ? "severity:error" : "severity:warn", ...input.config.labels])],
    assignees: input.config.assignees,
    assignCopilot: input.config.assignCopilot,
    priority: critical ? 2 : 1,
  };

  if (!open) {
    actions.push({ type: "create", desired });
    return plan;
  }
  if (open.signature === signature) return plan;
  const changed = open.attributes.shape !== shape;
  actions.push({
    type: "update",
    number: open.number,
    desired,
    ...(changed
      ? {
          comment: `The anomaly changed on run [#${latestRun}](https://github.com/${input.owner}/${input.repo}/actions/runs/${latestRun}): ${alerts
            .map((alert) => `${alert.jobKey === undefined ? "workflow" : `\`${alert.jobName ?? alert.jobKey}\``} ${alert.kind} +${Math.round(alert.increasePercent)}% (${alert.severity})`)
            .join("; ")}.`,
        }
      : {}),
  });
  return plan;
}
