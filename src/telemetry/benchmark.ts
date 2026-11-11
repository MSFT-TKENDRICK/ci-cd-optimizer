import { createHash } from "node:crypto";
import { z } from "zod";
import { readyQueueMs, type RunAttribution } from "./attribution.js";
import { normalizeLogLines } from "./logs.js";
import type { WorkflowSnapshot } from "./types.js";

const duration = z.number().finite().nonnegative();
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const label = z.string().max(240);
export const BENCHMARK_SCHEMA = "cicd-optimizer/benchmark-v1";
export const BENCHMARK_MARKER = "CICD_OPTIMIZER_BENCHMARK_V1";
export const MAX_BENCHMARK_BYTES = 96 * 1024;
const CHUNK = 4000;

export const benchmarkSchema = z.object({
  schema: z.literal(BENCHMARK_SCHEMA),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  repositoryId: id,
  runId: id,
  runAttempt: id,
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  workflowId: id,
  workflowPath: label,
  conclusion: label.nullable(),
  collectedAt: z.iso.datetime(),
  analysisStatus: z.enum(["complete", "partial", "unavailable"]),
  metrics: z.object({
    elapsedMs: duration.nullable(),
    initialQueueMs: duration.nullable(),
    queueInclusiveMs: duration.nullable(),
    runnerMs: duration.nullable(),
    observedRunnerMs: duration,
  }).nullable(),
  previous: z.object({
    runId: id, runAttempt: id, elapsedMs: duration, runnerMs: duration,
    elapsedDeltaMs: z.number().finite(), runnerDeltaMs: z.number().finite(),
  }).nullable(),
  jobs: z.array(z.object({
    id, key: label, name: label, durationMs: duration,
    observedRunnerSharePct: duration.max(100), readyQueueMs: duration.nullable(),
  })).max(100),
  omittedJobs: z.number().int().nonnegative(),
  findings: z.array(z.object({
    id: label, category: label, jobKey: label, jobName: label,
    observedMs: duration, elapsedSavingsBoundMs: duration, runnerSavingsBoundMs: duration,
    summary: z.string().max(2400), recommendation: z.string().max(2400),
    evidence: z.array(z.string().max(1200)).max(8), omittedEvidence: z.number().int().nonnegative(),
  })).max(30),
  omittedFindings: z.number().int().nonnegative(),
  gaps: z.array(z.string().max(1200)).max(100),
  omittedGaps: z.number().int().nonnegative(),
  rework: z.object({
    observedAttempts: z.number().int().nonnegative(),
    failedAttempts: z.number().int().nonnegative(),
    artifactDriftAttempts: z.number().int().nonnegative(),
    artifactDriftRunnerMs: duration,
    unclassifiedFailedAttempts: z.number().int().nonnegative(),
  }),
}).strict();
export type RunBenchmark = z.infer<typeof benchmarkSchema>;

const runnerMs = (run: WorkflowSnapshot) => run.jobs.reduce((total, job) => total + job.durationMs, 0);
const clip = (text: string, limit = 240) => text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;

/** Counts attempts, not just latest run outcomes. Exposure is deliberately not labelled savings. */
export function reworkSummary(runs: readonly WorkflowSnapshot[]): RunBenchmark["rework"] {
  const distinct = new Map(runs.map((run) => [`${run.owner}/${run.repo}:${run.runId}:${run.runAttempt}`, run]));
  const attempts = [...distinct.values()];
  const failed = attempts.filter((run) => run.conclusion === "failure");
  const drift = failed.filter((run) => run.failureAnalysis?.categories.includes("generated-artifact-drift"));
  return {
    observedAttempts: attempts.length, failedAttempts: failed.length, artifactDriftAttempts: drift.length,
    artifactDriftRunnerMs: drift.reduce((total, run) => total + runnerMs(run), 0),
    unclassifiedFailedAttempts: failed.filter((run) => !run.failureAnalysis ||
      run.failureAnalysis.jobsWithLogs < run.failureAnalysis.jobs).length,
  };
}

export function benchmarkRun(
  snapshot: WorkflowSnapshot,
  attribution: RunAttribution | undefined,
  previous: WorkflowSnapshot | undefined,
  history: readonly WorkflowSnapshot[],
): Omit<RunBenchmark, "schema" | "repositoryId" | "collectedAt"> {
  const complete = snapshot.provenance?.jobsComplete === true;
  const total = runnerMs(snapshot);
  const gaps = attribution?.gaps.map((gap) => gap.detail) ?? ["Log attribution is unavailable."];
  if (!complete) gaps.unshift("The job inventory is incomplete; whole-run metrics are withheld.");
  if (!snapshot.provenance?.definitionKnown) gaps.unshift("Workflow job definitions are incomplete.");
  const findings = attribution?.bottlenecks ?? [];
  const omittedJobs = Math.max(0, snapshot.jobs.length - 100);
  const omittedFindings = Math.max(0, findings.length - 30);
  if (omittedJobs || omittedFindings) gaps.push("Benchmark is a bounded summary; retrieve all workflow_run_report pages before claiming convergence.");
  const elapsed = complete ? snapshot.durationMs : null;
  const result: Omit<RunBenchmark, "schema" | "repositoryId" | "collectedAt"> = {
    repository: `${snapshot.owner}/${snapshot.repo}`, runId: snapshot.runId, runAttempt: snapshot.runAttempt,
    headSha: snapshot.headSha, workflowId: snapshot.workflowId, workflowPath: clip(snapshot.path ?? ""),
    conclusion: snapshot.conclusion,
    analysisStatus: !attribution ? "unavailable" : gaps.length ? "partial" : "complete",
    metrics: {
      elapsedMs: elapsed, initialQueueMs: snapshot.queueMs,
      queueInclusiveMs: elapsed !== null && snapshot.queueMs !== null ? elapsed + snapshot.queueMs : null,
      runnerMs: complete ? total : null, observedRunnerMs: total,
    },
    previous: previous && elapsed !== null ? {
      runId: previous.runId, runAttempt: previous.runAttempt, elapsedMs: previous.durationMs, runnerMs: runnerMs(previous),
      elapsedDeltaMs: elapsed - previous.durationMs, runnerDeltaMs: total - runnerMs(previous),
    } : null,
    jobs: snapshot.jobs.slice().sort((a, b) => b.durationMs - a.durationMs || a.id - b.id).slice(0, 100).map((job) => ({
      id: job.id, key: clip(job.key), name: clip(job.name), durationMs: job.durationMs,
      observedRunnerSharePct: total ? Math.round(job.durationMs / total * 10_000) / 100 : 0,
      readyQueueMs: snapshot.provenance?.definitionKnown ? readyQueueMs(job, snapshot.jobs) ?? null : null,
    })),
    omittedJobs,
    findings: findings.slice(0, 30).map((finding) => ({
      id: clip(finding.id), category: finding.category, jobKey: clip(finding.jobKey), jobName: clip(finding.jobName),
      observedMs: finding.observedMs, elapsedSavingsBoundMs: finding.elapsedSavingsBoundMs, runnerSavingsBoundMs: finding.runnerSavingsBoundMs,
      summary: clip(finding.summary, 2400), recommendation: clip(finding.recommendation, 2400),
      evidence: finding.evidence.slice(0, 8).map((line) => clip(line, 1200)), omittedEvidence: Math.max(0, finding.evidence.length - 8),
    })),
    omittedFindings, gaps: gaps.slice(0, 100).map((gap) => clip(gap, 1200)), omittedGaps: Math.max(0, gaps.length - 100),
    rework: reworkSummary([...history, snapshot]),
  };
  let reduced = false;
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_BENCHMARK_BYTES - 1024) {
    reduced = true;
    if (result.gaps.length > 5) { result.gaps.pop(); result.omittedGaps++; }
    else if (result.jobs.length > 20) { result.jobs.pop(); result.omittedJobs++; }
    else if (result.findings.length > 1) { result.findings.pop(); result.omittedFindings++; }
    else throw new Error("Benchmark cannot fit within the publication budget.");
  }
  if (reduced) {
    result.gaps.push("Publication size limit: additional evidence was omitted. Retrieve the paginated exact-run report before claiming convergence.");
    if (result.analysisStatus === "complete") result.analysisStatus = "partial";
  }
  return result;
}

export function encodeBenchmark(input: RunBenchmark): string {
  const value = benchmarkSchema.parse(input);
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_BENCHMARK_BYTES) throw new Error("Benchmark exceeds the bounded broadcast size; no partial event was emitted.");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const data = bytes.toString("base64");
  const count = Math.ceil(data.length / CHUNK);
  return Array.from({ length: count }, (_, index) =>
    `${BENCHMARK_MARKER} ${digest} ${index + 1}/${count} ${data.slice(index * CHUNK, (index + 1) * CHUNK)}`).join("\n");
}

/** Integrity framing is not authentication: callers must separately verify the producer and source identities. */
export function decodeBenchmark(log: string): RunBenchmark {
  const parts = new Map<number, string>();
  let digest: string | undefined;
  let count = 0;
  for (const { text } of normalizeLogLines(log)) {
    if (!text.startsWith(`${BENCHMARK_MARKER} `)) continue;
    const match = new RegExp(`^${BENCHMARK_MARKER} ([a-f0-9]{64}) ([1-9]\\d*)/([1-9]\\d*) ([A-Za-z0-9+/=]+)$`).exec(text);
    if (!match) throw new Error("Malformed benchmark frame.");
    const index = Number(match[2]);
    const total = Number(match[3]);
    if (total > Math.ceil(MAX_BENCHMARK_BYTES * 4 / 3 / CHUNK) || index > total || (digest && (digest !== match[1] || count !== total)) ||
      parts.has(index) || (match[4]?.length ?? 0) > CHUNK) throw new Error("Inconsistent or oversized benchmark frames.");
    digest = match[1];
    count = total;
    parts.set(index, match[4]!);
  }
  if (!digest || parts.size !== count) throw new Error("Benchmark frames are missing or incomplete.");
  const encoded = Array.from({ length: count }, (_, index) => parts.get(index + 1)).join("");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_BENCHMARK_BYTES || bytes.toString("base64") !== encoded ||
    createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("Benchmark frame integrity check failed.");
  return benchmarkSchema.parse(JSON.parse(bytes.toString("utf8")));
}
