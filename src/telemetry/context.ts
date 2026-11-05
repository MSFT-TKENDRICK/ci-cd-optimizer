import { createHash } from "node:crypto";
import { latestAttempts } from "./history.js";
import type { WorkflowSnapshot } from "./types.js";

/** A comparison policy, not a claim that labels identify hardware or that a change caused an improvement. */
export function comparisonProblem(snapshot: WorkflowSnapshot): string | undefined {
  if (snapshot.runAttempt !== 1) return "Reruns may execute only part of the workload or reuse warmed state.";
  if (snapshot.conclusion !== "success") return "The workflow did not complete successfully.";
  const provenance = snapshot.provenance;
  if (provenance?.version !== 1 || provenance.collector !== "github-actions-rest") return "Collection provenance is unavailable or unsupported.";
  if (!provenance.jobsComplete) return "Job collection is incomplete.";
  if (!provenance.definitionKnown) return "The workflow job definitions are unavailable.";
  if (snapshot.jobs.length === 0) return "No completed jobs were observed.";
  if (snapshot.jobs.some((job) => job.conclusion !== "success")) return "Some observed jobs did not complete successfully.";
  if (snapshot.jobs.some((job) => !job.labels?.length || job.labels.some((label) => !label.trim()))) return "Runner routing labels are unavailable.";
  return undefined;
}

export function comparisonKey(snapshot: WorkflowSnapshot): string | undefined {
  if (comparisonProblem(snapshot)) return undefined;
  const jobs = snapshot.jobs.map((job) => JSON.stringify([
    job.key, job.name, [...new Set(job.needs)].sort(), [...new Set(job.labels)].sort(), job.runnerGroupId ?? null,
  ])).sort();
  return createHash("sha256").update(JSON.stringify([
    "workload-comparison-v1", snapshot.owner, snapshot.repo, snapshot.workflowId, snapshot.branch, snapshot.event, jobs,
  ])).digest("hex");
}

/** Latest attempt first, eligibility second: a later failure/retry must not resurrect an older first-attempt success. */
export function comparableHistory(history: readonly WorkflowSnapshot[], reference: WorkflowSnapshot): WorkflowSnapshot[] {
  const key = comparisonKey(reference);
  if (!key) return [];
  return latestAttempts(history).filter((snapshot) =>
    snapshot.runId !== reference.runId && comparisonKey(snapshot) === key,
  );
}
