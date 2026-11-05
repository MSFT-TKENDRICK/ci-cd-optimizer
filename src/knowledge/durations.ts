import { comparisonKey, comparisonProblem, jobComparisonContext } from "../telemetry/context.js";
import { byCompletion } from "../telemetry/history.js";
import { escapeCell, formatDuration } from "../telemetry/report.js";
import type { WorkflowSnapshot } from "../telemetry/types.js";
import { durationPolicyProblems, type DurationObjective, type DurationsConfig } from "./duration-policy.js";
import { identity } from "./identity.js";
import { runtimeFactsIdentity, validateRunObservation } from "./run-observation.js";
import type { RunEvidenceWindow, RunObservation } from "./types.js";

export interface DurationDistribution {
  sampleCount: number;
  minMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  maxMs: number;
}

interface DurationMetric {
  currentMs: number;
  distribution?: DurationDistribution;
  objective?: {
    definitionId: string;
    maxDurationMs: number;
    currentStatus: "within-budget" | "over-budget";
    historicalOverBudget: number;
    historicalSamples: number;
  };
}

export interface DurationReport {
  version: 1;
  policy: "immutable-duration-v1";
  quantileMethod: "R7";
  status: "ready" | "insufficient-history" | "reference-excluded";
  reason?: string;
  contextKey?: string;
  minimumSamples: number;
  window: { complete: boolean; runs: number };
  samples: Array<{ runId: number; observationIds: string[] }>;
  excluded: Array<{ runId: number; reason: string }>;
  workflow?: DurationMetric;
  jobs: Array<{ contextKey: string; key: string; name: string; metric: DurationMetric }>;
  unmatchedObjectives: DurationObjective[];
}

export interface DurationAnalysis {
  report: DurationReport;
  history: WorkflowSnapshot[];
  /** Additional guards for alert consumers; truncated groups cannot certify chronology. */
  alertHistoryUncertain: boolean;
  newerRunObserved: boolean;
  newerAttemptObserved: boolean;
}

function distribution(values: readonly number[]): DurationDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (probability: number) => {
    const index = (sorted.length - 1) * probability;
    const lower = sorted[Math.floor(index)]!;
    return lower + (sorted[Math.ceil(index)]! - lower) * (index - Math.floor(index));
  };
  return { sampleCount: sorted.length, minMs: sorted[0]!, p50Ms: quantile(0.5), p90Ms: quantile(0.9), p95Ms: quantile(0.95), maxMs: sorted.at(-1)! };
}

function groupProblem(group: RunEvidenceWindow["groups"][number]): string | undefined {
  if (!group.complete || group.observations.length === 0) return "incomplete-run-evidence";
  if (group.observations.some(({ run }) => run.runAttempt !== 1)) return "retry-observed";
  if (new Set(group.observations.map(({ run }) => runtimeFactsIdentity(run))).size !== 1) return "conflicting-runtime-observations";
  const run = group.observations[0]!.run;
  if (comparisonProblem(run)) return "ineligible-workload";
  if (new Set(run.jobs.map(jobComparisonContext)).size !== run.jobs.length) return "ambiguous-job-identity";
  return undefined;
}

/** Descriptive, as-known evidence; neither quantiles nor matching source declarations establish causality. */
export function analyzeDurations(reference: RunObservation, window: RunEvidenceWindow, config: DurationsConfig): DurationAnalysis {
  validateRunObservation(reference);
  const problems = durationPolicyProblems(config);
  if (problems.length) throw new Error(`Invalid duration policy: ${problems.map((problem) => problem.path).join(", ")}`);
  if (new Set(window.groups.map((group) => group.runId)).size !== window.groups.length) throw new Error("Duplicate logical runs in duration evidence");
  for (const group of window.groups) for (const observation of group.observations) {
    validateRunObservation(observation);
    if (observation.run.runId !== group.runId || observation.repository.host !== reference.repository.host ||
        observation.repository.repositoryId !== reference.repository.repositoryId) throw new Error("Duration evidence crosses its repository or logical run scope");
  }
  const run = reference.run;
  const report: DurationReport = {
    version: 1, policy: "immutable-duration-v1", quantileMethod: "R7", status: "reference-excluded",
    minimumSamples: config.minSamples, window: { complete: window.complete, runs: window.groups.length },
    samples: [], excluded: [], jobs: [], unmatchedObjectives: [],
  };
  const analysis: DurationAnalysis = {
    report, history: [], alertHistoryUncertain: window.groups.some((group) => !group.complete),
    newerRunObserved: window.groups.some((group) => group.observations.some(({ run: other }) =>
      other.runId !== run.runId && other.workflowId === run.workflowId && other.branch === run.branch && byCompletion(other, run) > 0)),
    newerAttemptObserved: window.groups.some((group) => group.runId === run.runId &&
      group.observations.some(({ run: other }) => other.runAttempt > run.runAttempt)),
  };
  const referenceGroup = window.groups.find((group) => group.runId === run.runId);
  const problem = referenceGroup ? groupProblem(referenceGroup) : "reference-not-recorded";
  if (problem || !referenceGroup?.observations.some((observation) => observation.id === reference.id)) {
    report.reason = problem ?? "reference-not-recorded";
    return analysis;
  }
  report.contextKey = comparisonKey(run)!;
  for (const group of window.groups) {
    if (group.runId === run.runId) continue;
    let reason = groupProblem(group);
    const prior = group.observations[0]?.run;
    if (!reason && prior) {
      if (byCompletion(prior, run) >= 0) reason = "not-prior";
      else if (comparisonKey(prior) !== report.contextKey) reason = "different-workload-context";
    }
    if (reason || !prior) {
      report.excluded.push({ runId: group.runId, reason: reason ?? "incomplete-run-evidence" });
      continue;
    }
    report.samples.push({ runId: group.runId, observationIds: group.observations.map((observation) => observation.id).sort() });
    analysis.history.push(prior);
  }
  analysis.history.sort(byCompletion);
  report.samples.sort((a, b) => a.runId - b.runId);
  report.status = analysis.history.length >= config.minSamples ? "ready" : "insufficient-history";
  const metric = (currentMs: number, values: number[], objective?: DurationObjective): DurationMetric => ({
    currentMs,
    ...(values.length >= config.minSamples ? { distribution: distribution(values) } : {}),
    ...(objective ? { objective: {
      definitionId: identity(["duration-objective-v1", objective]), maxDurationMs: objective.maxDurationMs,
      currentStatus: currentMs > objective.maxDurationMs ? "over-budget" as const : "within-budget" as const,
      historicalOverBudget: values.filter((value) => value > objective.maxDurationMs).length, historicalSamples: values.length,
    } } : {}),
  });
  const objectives = config.objectives.filter((objective) => objective.workflow === run.path);
  report.workflow = metric(run.durationMs, analysis.history.map((snapshot) => snapshot.durationMs), objectives.find((objective) => objective.job === undefined));
  report.jobs = run.jobs.map((job) => {
    const context = jobComparisonContext(job);
    const values = analysis.history.map((snapshot) => snapshot.jobs.find((other) => jobComparisonContext(other) === context)!.durationMs);
    return { contextKey: identity(["duration-job-v1", context]), key: job.key, name: job.name,
      metric: metric(job.durationMs, values, objectives.find((objective) => objective.job === job.key)) };
  }).sort((a, b) => a.contextKey.localeCompare(b.contextKey));
  report.unmatchedObjectives = objectives.filter((objective) => objective.job !== undefined && !run.jobs.some((job) => job.key === objective.job));
  return structuredClone(analysis);
}

export function describeDurations(report: DurationReport): string {
  const lines = [
    "\n\n### Immutable duration evidence\n",
    `${report.samples.length} independent prior runs; ${report.excluded.length} excluded; minimum ${report.minimumSamples} for quantiles. ` +
      `The bounded window covers ${report.window.runs} most recently observed logical runs${report.window.complete ? " in the stored matching evidence" : "; additional stored runs were omitted"}.`,
  ];
  if (report.status === "reference-excluded") lines.push(`\nComparison and budget assessment withheld: ${report.reason}.`);
  else {
    lines.push("\n| Scope | This run | Historical p50 | Historical p95 | Configured budget |",
      "|---|---:|---:|---:|---|");
    const row = (name: string, metric: DurationMetric) => `| ${escapeCell(name)} | ${formatDuration(metric.currentMs)} | ` +
      `${metric.distribution ? formatDuration(metric.distribution.p50Ms) : "insufficient evidence"} | ` +
      `${metric.distribution ? formatDuration(metric.distribution.p95Ms) : "insufficient evidence"} | ` +
      `${metric.objective ? `${formatDuration(metric.objective.maxDurationMs)} (${metric.objective.currentStatus})` : "not configured"} |`;
    if (report.workflow) lines.push(row("Workflow", report.workflow));
    lines.push(...report.jobs.slice(0, 20).map((job) => row(`${job.key}: ${job.name}`, job.metric)));
    if (report.jobs.length > 20) lines.push(`\n${report.jobs.length - 20} additional job distributions are available in JSON.`);
  }
  if (report.excluded.length) {
    const counts = new Map<string, number>();
    for (const { reason } of report.excluded) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    lines.push(`\nExclusions: ${[...counts].map(([reason, count]) => `${reason} (${count})`).join(", ")}.`);
  }
  if (report.unmatchedObjectives.length) lines.push(`\n${report.unmatchedObjectives.length} configured job budgets did not match an observed job; they were not assessed.`);
  lines.push("\nR7 quantiles describe eligible successful runs, not prediction bounds or guarantees. Budgets are explicit current configuration, not learned targets or historical SLO compliance. Runner labels do not establish identical hardware/cache state; workflow/job durations do not identify executed projects or causal benefits.");
  return lines.join("\n");
}
