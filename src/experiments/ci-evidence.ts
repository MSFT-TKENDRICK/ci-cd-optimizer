import { exactKeys, integer, object, string, type Json } from "../formal/json.js";
import type { MetricSpec } from "./config.js";

export const CI_EVIDENCE_SCHEMA = "cicd-optimizer/ci-evidence-v1";

export interface CiJobSample {
  id: number;
  name: string;
  startedAt: string;
  completedAt: string;
  conclusion: string;
}

/** GitHub-reported metadata, not an attestation of the code a workflow actually checked out or executed. */
export interface CiSample {
  runId: number;
  attempt: number;
  workflowId: number;
  workflowPath: string;
  event: string;
  status: string;
  conclusion: string;
  headSha: string;
  branch: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  seconds: number;
  job?: CiJobSample;
}

export interface CiEvidence {
  schema: typeof CI_EVIDENCE_SCHEMA;
  repository: string;
  workflow: string;
  samples: CiSample[];
}

export interface CiContext {
  branch: string;
  headSha?: string;
  since: string;
}

export function ciProjection(measured: { ci?: Record<string, number[]> }, id: string): number[] {
  return measured.ci && Object.hasOwn(measured.ci, id) ? measured.ci[id] ?? [] : [];
}

export const fullGitHubSha = (value: string | undefined): boolean => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const positiveId = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const time = (value: string): number => typeof value === "string" ? Date.parse(value) : NaN;
export const durationSeconds = (start: string, end: string): number | undefined => {
  const duration = (time(end) - time(start)) / 1000;
  return Number.isFinite(duration) && duration >= 0 && duration <= 1_000_000_000_000 ? duration : undefined;
};

function workflowMatches(sample: CiSample, workflow: string | undefined): boolean {
  if (!workflow || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(sample.workflowPath)) return false;
  if (/^[1-9]\d*$/.test(workflow)) return String(sample.workflowId) === workflow;
  return sample.workflowPath === (workflow.startsWith(".github/workflows/") ? workflow : `.github/workflows/${workflow}`);
}

/** The supported observation contract deliberately excludes PR merge refs, retries and missing context. */
export function supportedCiSample(sample: CiSample, spec: MetricSpec, context: CiContext): boolean {
  if (!sample || !positiveId(sample.runId) || !positiveId(sample.workflowId) ||
    sample.event !== "workflow_dispatch" || sample.attempt !== 1 || sample.status !== "completed" || sample.conclusion !== "success" ||
    !fullGitHubSha(context.headSha) || sample.headSha !== context.headSha || sample.branch !== context.branch ||
    !workflowMatches(sample, spec.workflow)) return false;
  const created = time(sample.createdAt);
  const started = time(sample.startedAt);
  const updated = time(sample.updatedAt);
  const since = time(context.since);
  if (![created, started, updated, since].every(Number.isFinite) || created < since || started < created || updated < started) return false;
  let seconds: number | undefined;
  if (spec.job) {
    const job = sample.job;
    if (!job || !positiveId(job.id) || job.name !== spec.job || job.conclusion !== "success" ||
      time(job.startedAt) < started || time(job.completedAt) > updated) return false;
    seconds = durationSeconds(job.startedAt, job.completedAt);
  } else {
    if (sample.job !== undefined) return false;
    seconds = durationSeconds(sample.startedAt, sample.updatedAt);
  }
  return seconds !== undefined && sample.seconds === seconds;
}

export function validatedCiSeries(
  spec: MetricSpec,
  measured: { headSha?: string; ci?: Record<string, number[]>; ciEvidence?: Record<string, CiEvidence> },
  context: Omit<CiContext, "headSha">,
): { values: number[]; runIds: number[]; cohort?: string; issue?: string } {
  const unavailable = (issue: string) => ({ values: [], runIds: [], issue });
  const evidence = measured.ciEvidence && Object.hasOwn(measured.ciEvidence, spec.id) ? measured.ciEvidence[spec.id] : undefined;
  if (!evidence) return unavailable(`${spec.id} requires provenance-backed first-attempt workflow_dispatch samples; recollect legacy evidence`);
  if (evidence.schema !== CI_EVIDENCE_SCHEMA || typeof evidence.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(evidence.repository) || evidence.workflow !== spec.workflow ||
    !Array.isArray(evidence.samples) || evidence.samples.length > 10_000) {
    return unavailable(`${spec.id} has unsupported CI evidence metadata`);
  }
  const samples = Array.from(evidence.samples);
  if (!samples.every((sample) => supportedCiSample(sample, spec, { ...context, ...(measured.headSha ? { headSha: measured.headSha } : {}) }))) {
    return unavailable(`${spec.id} has unsupported, stale-head, PR, retry or inconsistent CI observations`);
  }
  const runIds = samples.map((sample) => sample.runId);
  if (new Set(runIds).size !== samples.length) return unavailable(`${spec.id} repeats a CI run instead of providing distinct observations`);
  const values = samples.map((sample) => sample.seconds);
  const projection = ciProjection(measured, spec.id);
  if (projection.length !== values.length || !values.every((value, index) => value === projection[index])) {
    return unavailable(`${spec.id} duration values do not match their recorded run provenance`);
  }
  const cohorts = new Set(samples.map((sample) => `${evidence.repository.toLowerCase()}\0${sample.workflowId}\0${sample.workflowPath}`));
  if (cohorts.size > 1) return unavailable(`${spec.id} mixes workflow identities`);
  const cohort = cohorts.values().next().value;
  return { values, runIds, ...(cohort === undefined ? {} : { cohort }) };
}

export function decodeCiEvidence(value: Json | undefined): Record<string, CiEvidence> {
  const series = object(value, "ciEvidence");
  if (Object.keys(series).length > 128) throw new Error("At most 128 CI evidence series.");
  return Object.fromEntries(Object.entries(series).map(([id, input]) => {
    const record = object(input, `ciEvidence.${id}`);
    exactKeys(record, ["schema", "repository", "workflow", "samples"], "CI evidence");
    if (record.schema !== CI_EVIDENCE_SCHEMA) throw new Error("Unsupported CI evidence schema.");
    if (!Array.isArray(record.samples) || record.samples.length > 10_000) throw new Error("At most 10000 CI observations per series.");
    const evidence: CiEvidence = {
      schema: CI_EVIDENCE_SCHEMA, repository: string(record.repository, "repository"), workflow: string(record.workflow, "workflow"),
      samples: record.samples.map((input) => {
        const row = object(input, "CI observation");
        exactKeys(row, ["runId", "attempt", "workflowId", "workflowPath", "event", "status", "conclusion", "headSha", "branch", "createdAt", "startedAt", "updatedAt", "seconds", "job"], "CI observation");
        if (typeof row.seconds !== "number" || !Number.isFinite(row.seconds) || row.seconds < 0 || row.seconds > 1_000_000_000_000) throw new Error("Invalid CI observation duration.");
        const sample: CiSample = {
          runId: integer(row.runId, "runId", 1), attempt: integer(row.attempt, "attempt", 1), workflowId: integer(row.workflowId, "workflowId", 1),
          workflowPath: string(row.workflowPath, "workflowPath"), event: string(row.event, "event"), status: string(row.status, "status"), conclusion: string(row.conclusion, "conclusion"),
          headSha: string(row.headSha, "headSha"), branch: string(row.branch, "branch"), createdAt: string(row.createdAt, "createdAt"),
          startedAt: string(row.startedAt, "startedAt"), updatedAt: string(row.updatedAt, "updatedAt"), seconds: row.seconds,
        };
        if (row.job !== undefined) {
          const job = object(row.job, "CI job");
          exactKeys(job, ["id", "name", "startedAt", "completedAt", "conclusion"], "CI job");
          sample.job = {
            id: integer(job.id, "job.id", 1), name: string(job.name, "job.name"), startedAt: string(job.startedAt, "job.startedAt"),
            completedAt: string(job.completedAt, "job.completedAt"), conclusion: string(job.conclusion, "job.conclusion"),
          };
        }
        return sample;
      }),
    };
    return [id, evidence];
  }));
}
