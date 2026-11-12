import { createHash } from "node:crypto";
import { byCompletion, latestAttempts } from "./history.js";
import type { BaselineDiagnostic, BaselineExclusion, JobBaseline, JobSnapshot, WorkflowSnapshot } from "./types.js";
import { median } from "../alerts/stats.js";

export const EXCLUSION_DESCRIPTIONS: Record<BaselineExclusion, string> = {
  rerun: "Reruns may execute only part of the workload or reuse warmed state.",
  unsuccessful: "The workflow did not complete successfully.",
  provenance: "Collection provenance is unavailable or unsupported.",
  "incomplete-jobs": "Job collection is incomplete.",
  "definition-unknown": "The workflow job definitions are unavailable.",
  "no-jobs": "No executed jobs were observed.",
  "job-failed": "Some observed jobs neither succeeded nor were skipped.",
  "labels-missing": "Runner routing labels are unavailable.",
  "context-changed": "The run used a different repository, workflow, branch, or event.",
  "job-set-changed": "The workflow's job set (names, needs, runner labels, runner group, or skipped jobs) differs.",
};

/** Why a run cannot anchor or join a run-level comparison, as a stable code. */
export function comparisonExclusion(snapshot: WorkflowSnapshot): BaselineExclusion | undefined {
  if (snapshot.runAttempt !== 1) return "rerun";
  if (snapshot.conclusion !== "success") return "unsuccessful";
  const provenance = snapshot.provenance;
  if (provenance?.version !== 1 || provenance.collector !== "github-actions-rest") return "provenance";
  if (!provenance.jobsComplete) return "incomplete-jobs";
  if (!provenance.definitionKnown) return "definition-unknown";
  // Skipped jobs never acquire a runner; they join the comparison key but are neither sampled nor label-checked.
  if (snapshot.jobs.some((job) => job.conclusion !== "success" && job.conclusion !== "skipped")) return "job-failed";
  const executed = snapshot.jobs.filter((job) => job.conclusion === "success");
  if (executed.length === 0) return "no-jobs";
  if (executed.some((job) => !hasLabels(job))) return "labels-missing";
  return undefined;
}

/** A comparison policy, not a claim that labels identify hardware or that a change caused an improvement. */
export function comparisonProblem(snapshot: WorkflowSnapshot): string | undefined {
  const code = comparisonExclusion(snapshot);
  return code ? EXCLUSION_DESCRIPTIONS[code] : undefined;
}

function hasLabels(job: JobSnapshot): boolean {
  return Boolean(job.labels?.length) && !job.labels!.some((label) => !label.trim());
}

function sameContext(left: WorkflowSnapshot, right: WorkflowSnapshot): boolean {
  return left.owner === right.owner && left.repo === right.repo && left.workflowId === right.workflowId &&
    left.branch === right.branch && left.event === right.event;
}

export function jobComparisonContext(job: JobSnapshot): string {
  return JSON.stringify([
    job.key, job.name, [...new Set(job.needs)].sort(), [...new Set(job.labels)].sort(), job.runnerGroupId ?? null,
  ]);
}

/**
 * Identical skip patterns are a grouping policy, not proof of identical work. A skipped job contributes only its key,
 * name and needs: it has no runner group, and its labels do not affect execution. All-executed keys are unchanged.
 */
export function comparisonKey(snapshot: WorkflowSnapshot): string | undefined {
  if (comparisonProblem(snapshot)) return undefined;
  const jobs = snapshot.jobs.map((job) => job.conclusion === "skipped"
    ? JSON.stringify(["skipped", job.key, job.name, [...new Set(job.needs)].sort()])
    : jobComparisonContext(job)).sort();
  return createHash("sha256").update(JSON.stringify([
    "workload-comparison-v1", snapshot.owner, snapshot.repo, snapshot.workflowId, snapshot.branch, snapshot.event, jobs,
  ])).digest("hex");
}

/** Latest attempts first, eligibility second: a later failure/retry must not resurrect an older first-attempt success. */
export function comparableHistory(history: readonly WorkflowSnapshot[], reference: WorkflowSnapshot): WorkflowSnapshot[] {
  const key = comparisonKey(reference);
  if (!key) return [];
  return priorRuns(history, reference).filter((snapshot) => comparisonKey(snapshot) === key);
}

function priorRuns(history: readonly WorkflowSnapshot[], reference: WorkflowSnapshot): WorkflowSnapshot[] {
  return latestAttempts(history).filter((snapshot) => snapshot.runId !== reference.runId && byCompletion(snapshot, reference) < 0);
}

/** Explains a missing or thin run-level baseline: which prior runs were examined and why each was excluded. */
export function diagnoseBaseline(history: readonly WorkflowSnapshot[], reference: WorkflowSnapshot): BaselineDiagnostic {
  const key = comparisonKey(reference);
  const currentProblem = comparisonExclusion(reference);
  const excluded: Partial<Record<BaselineExclusion, number>> = {};
  const prior = priorRuns(history, reference);
  let eligible = 0;
  let comparable = 0;
  for (const run of prior) {
    const reason = comparisonExclusion(run) ?? (sameContext(run, reference) ? undefined : "context-changed");
    if (reason) {
      excluded[reason] = (excluded[reason] ?? 0) + 1;
      continue;
    }
    eligible += 1;
    if (!key) continue;
    if (comparisonKey(run) === key) comparable += 1;
    else excluded["job-set-changed"] = (excluded["job-set-changed"] ?? 0) + 1;
  }
  return { examined: prior.length, eligible, comparable, excluded, ...(currentProblem ? { currentProblem } : {}) };
}

/**
 * Per-job medians from earlier first attempts of the same workflow, branch and event in which a job with the identical
 * comparison context (id, name, needs, runner labels and group) succeeded. Unlike the run-level baseline this survives
 * unrelated job-set changes, such as adding a new job, and failures elsewhere in the run.
 */
export function jobBaselines(history: readonly WorkflowSnapshot[], reference: WorkflowSnapshot, limit = 20): JobBaseline[] {
  return jobSamples(history, reference, limit).flatMap(({ job, values }) =>
    values.length ? [{ key: job.key, name: job.name, sampleCount: values.length, medianDurationMs: median(values) }] : []);
}

/** Whether some comparable job of the current run has fewer than `minSamples` per-job history samples. */
export function thinJobHistory(history: readonly WorkflowSnapshot[], reference: WorkflowSnapshot, minSamples: number): boolean {
  return jobSamples(history, reference, minSamples).some(({ values }) => values.length < minSamples);
}

/** Whether any job of the run could be compared with its own history at all. */
export function jobHistoryApplies(reference: WorkflowSnapshot): boolean {
  return jobSamples([], reference, 0).length > 0;
}

const GAP_PHRASES: Record<BaselineExclusion, string> = {
  rerun: "were reruns",
  unsuccessful: "did not succeed",
  provenance: "lack supported collection provenance",
  "incomplete-jobs": "have incomplete job evidence",
  "definition-unknown": "have unknown job definitions",
  "no-jobs": "have no executed jobs",
  "job-failed": "had jobs that neither succeeded nor were skipped",
  "labels-missing": "lack runner labels",
  "context-changed": "ran in a different context",
  "job-set-changed": "had a different job set",
};

/** One-line reason a run-level baseline is missing, naming the dominant exclusion instead of "no baseline yet". */
export function summarizeBaselineGap(diagnostic?: BaselineDiagnostic): string {
  if (!diagnostic) return "no baseline yet";
  if (diagnostic.currentProblem) return `no baseline: ${EXCLUSION_DESCRIPTIONS[diagnostic.currentProblem].replace(/\.$/, "").toLowerCase()}`;
  if (diagnostic.examined === 0) return "no baseline yet: no earlier runs in history";
  const [reason, count] = (Object.entries(diagnostic.excluded) as [BaselineExclusion, number][])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
  return reason && count ? `no baseline: ${count} of ${diagnostic.examined} earlier runs ${GAP_PHRASES[reason]}` : "no baseline yet";
}

function jobSamples(history: readonly WorkflowSnapshot[], reference: WorkflowSnapshot, limit: number): { job: JobSnapshot; values: number[] }[] {
  if (!trustedJobs(reference)) return [];
  const prior = priorRuns(history, reference).filter((run) => sameContext(run, reference) && trustedJobs(run)).sort(byCompletion);
  const contexts = reference.jobs.map(jobComparisonContext);
  return reference.jobs.flatMap((job, index) => {
    const context = contexts[index]!;
    if (job.conclusion !== "success" || !hasLabels(job) || contexts.indexOf(context) !== contexts.lastIndexOf(context)) return [];
    const values = prior.flatMap((run) => {
      const matches = run.jobs.filter((other) => jobComparisonContext(other) === context);
      return matches.length === 1 && matches[0]!.conclusion === "success" ? [matches[0]!.durationMs] : [];
    }).slice(-limit);
    return [{ job, values }];
  });
}

function trustedJobs(snapshot: WorkflowSnapshot): boolean {
  const provenance = snapshot.provenance;
  return snapshot.runAttempt === 1 && provenance?.version === 1 && provenance.collector === "github-actions-rest" && provenance.definitionKnown;
}
