import { parse } from "yaml";
import { readFileAt } from "../github/git.js";
import type { GitHubClient, RepoRef } from "../github/client.js";
import { mapLimit } from "../utils.js";
import type { JobSnapshot, StepSnapshot, WorkflowSnapshot } from "./types.js";
import { byCompletion, validateRunAttempt } from "./history.js";

/** The subset of a `workflow_run` webhook payload / REST object the snapshot needs. */
export interface WorkflowRunPayload {
  id: number;
  name?: string | null;
  path: string;
  workflow_id: number;
  run_attempt?: number;
  head_sha: string;
  head_branch: string | null;
  event: string;
  status?: string | null;
  conclusion: string | null;
  created_at: string;
  run_started_at?: string | null;
  updated_at: string;
  html_url?: string;
}

interface ApiStep {
  number: number;
  name: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface ApiJob {
  id: number;
  name: string;
  conclusion: string | null;
  created_at?: string | null;
  started_at: string | null;
  completed_at: string | null;
  runner_id?: number | null;
  runner_name?: string | null;
  runner_group_id?: number | null;
  labels?: string[];
  steps?: ApiStep[];
  html_url?: string | null;
}

/**
 * The jobs API also lists check runs that other integrations attach to the workflow's check suite (including this
 * App's own telemetry check). They never ran on a runner, so they are not workload: counting them would mark the
 * definition unknown and stretch the run to the check's publication time.
 */
export function isExternalCheckRun(job: ApiJob, key: string | undefined): boolean {
  return key === undefined && !job.runner_id && !job.runner_name && !(job.steps?.length) &&
    typeof job.html_url === "string" && !/\/actions\/runs\/\d+\/job\/\d+/.test(job.html_url);
}

export interface JobDefinition {
  name?: string;
  needs: string[];
}

export type JobDefinitions = ReadonlyMap<string, JobDefinition>;

/** Strips the `@ref` suffix GitHub appends to reusable/dynamic workflow paths. */
export function workflowPath(path: string): string {
  return path.replace(/@.*$/, "");
}

export function parseJobDefinitions(text: string): Map<string, JobDefinition> {
  let document: unknown;
  try {
    document = parse(text);
  } catch {
    return new Map();
  }
  if (!isRecord(document) || !isRecord(document.jobs)) return new Map();
  const definitions = new Map<string, JobDefinition>();
  for (const [key, value] of Object.entries(document.jobs)) {
    if (!isRecord(value)) continue;
    definitions.set(key, { ...(typeof value.name === "string" ? { name: value.name } : {}), needs: parseNeeds(value.needs) });
  }
  return definitions;
}

export async function loadJobDefinitions(client: GitHubClient, repo: RepoRef, path: string, ref: string): Promise<Map<string, JobDefinition>> {
  try {
    const text = await readFileAt(client, repo, workflowPath(path), ref);
    return text === undefined ? new Map() : parseJobDefinitions(text);
  } catch {
    return new Map();
  }
}

export async function listRunJobs(client: GitHubClient, repo: RepoRef, runId: number, runAttempt = 1, maxPages = 5): Promise<{ jobs: ApiJob[]; complete: boolean }> {
  validateRunAttempt(runAttempt);
  const jobs: ApiJob[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs", {
      ...repo,
      run_id: runId,
      attempt_number: runAttempt,
      per_page: 100,
      page,
    });
    const data = response.data as { jobs?: ApiJob[]; total_count?: number };
    if (!Array.isArray(data.jobs)) throw new Error("Actions jobs response did not contain a jobs array");
    const batch = data.jobs;
    jobs.push(...batch);
    if (batch.length < 100 || data.total_count === jobs.length) {
      const unique = [...new Map(jobs.map((job) => [job.id, job])).values()];
      return { jobs: unique, complete: unique.length === jobs.length && (data.total_count === undefined || data.total_count === jobs.length) };
    }
  }
  return { jobs: [...new Map(jobs.map((job) => [job.id, job])).values()], complete: false };
}

export async function buildWorkflowSnapshot(
  client: GitHubClient,
  repo: RepoRef,
  run: WorkflowRunPayload,
  options: { definitions?: JobDefinitions } = {},
): Promise<WorkflowSnapshot> {
  const [jobs, definitions] = await Promise.all([
    listRunJobs(client, repo, run.id, run.run_attempt ?? 1),
    options.definitions ? Promise.resolve(options.definitions) : loadJobDefinitions(client, repo, run.path, run.head_sha),
  ]);
  return snapshotFromRun(repo, run, jobs.jobs, definitions, jobs.complete);
}

export function snapshotFromRun(repo: RepoRef, run: WorkflowRunPayload, apiJobs: readonly ApiJob[], definitions: JobDefinitions, jobsComplete = false): WorkflowSnapshot {
  const classified = apiJobs.map((job) => ({ job, key: matchJobKey(job.name, definitions) }));
  const external = classified.filter(({ job, key }) => isExternalCheckRun(job, key)).map(({ job }) => ({ id: job.id, name: job.name }));
  const mapped = classified.filter(({ job, key }) => job.started_at && job.completed_at && !isExternalCheckRun(job, key));
  const jobs = mapped.map(({ job, key }) => jobSnapshot(job, definitions, key));
  const startedAt = run.run_started_at ?? run.created_at;
  const lastJob = jobs.map((job) => job.completedAt).sort().at(-1);
  const completedAt = lastJob && Date.parse(lastJob) > Date.parse(startedAt) ? lastJob : run.updated_at;
  return {
    owner: repo.owner,
    repo: repo.repo,
    workflowId: run.workflow_id,
    workflowName: run.name ?? workflowPath(run.path),
    path: workflowPath(run.path),
    runId: run.id,
    runAttempt: run.run_attempt ?? 1,
    headSha: run.head_sha,
    branch: run.head_branch,
    event: run.event,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    startedAt,
    completedAt,
    queueMs: (run.run_attempt ?? 1) === 1 ? elapsed(run.created_at, startedAt) : null,
    durationMs: elapsed(startedAt, completedAt),
    ...(run.html_url ? { htmlUrl: run.html_url } : {}),
    jobs,
    provenance: {
      version: 1,
      collector: "github-actions-rest",
      collectedAt: new Date().toISOString(),
      jobsComplete,
      definitionKnown: definitions.size > 0 && mapped.every(({ key }) => key !== undefined),
      ...(external.length > 0 ? { externalChecks: external } : {}),
    },
  };
}

function jobSnapshot(job: ApiJob, definitions: JobDefinitions, key: string | undefined): JobSnapshot {
  const startedAt = job.started_at as string;
  const completedAt = job.completed_at as string;
  const steps = (job.steps ?? [])
    .filter((step) => step.started_at && step.completed_at)
    .map(
      (step): StepSnapshot => ({
        number: step.number,
        name: step.name,
        conclusion: step.conclusion,
        startedAt: step.started_at as string,
        completedAt: step.completed_at as string,
        durationMs: elapsed(step.started_at as string, step.completed_at as string),
      }),
    );
  return {
    id: job.id,
    key: key ?? job.name,
    name: job.name,
    conclusion: job.conclusion,
    startedAt,
    completedAt,
    durationMs: elapsed(startedAt, completedAt),
    needs: key ? (definitions.get(key)?.needs ?? []) : [],
    ...(job.created_at ? { queuedAt: job.created_at, queueMs: elapsed(job.created_at, startedAt) } : {}),
    ...(job.runner_name ? { runnerName: job.runner_name } : {}),
    ...(typeof job.runner_group_id === "number" ? { runnerGroupId: job.runner_group_id } : {}),
    ...(job.labels && job.labels.length > 0 ? { labels: job.labels } : {}),
    ...(steps.length > 0 ? { steps } : {}),
  };
}

/**
 * Maps a job's display name back to its `jobs.<key>`: exact key or `name:`, matrix legs (`key (a, b)`),
 * reusable-workflow callers (`key / inner`), and `name:` templates with `${{ }}` expressions.
 */
export function matchJobKey(jobName: string, definitions: JobDefinitions): string | undefined {
  // Templates without literal text (e.g. `${{ matrix.name }}`) match anything, so they are only a fallback.
  const tiers: Array<(candidate: string) => boolean> = [
    (candidate) => jobName === candidate || jobName.startsWith(`${candidate} (`) || jobName.startsWith(`${candidate} / `) ||
      (candidate.includes("${{") && hasTemplateLiteral(candidate) && matchesNameTemplate(candidate, jobName)),
    (candidate) => candidate.includes("${{") && !hasTemplateLiteral(candidate) && matchesNameTemplate(candidate, jobName),
  ];
  for (const matchesTier of tiers) {
    const matches = new Set<string>();
    for (const [key, definition] of definitions) {
      if ([key, definition.name].some((candidate) => candidate && matchesTier(candidate))) matches.add(key);
    }
    if (matches.size > 1) return undefined;
    if (matches.size === 1) return [...matches][0];
  }
  return undefined;
}

function hasTemplateLiteral(template: string): boolean {
  for (let cursor = 0; cursor < template.length;) {
    const opening = template.indexOf("${{", cursor);
    if (opening === -1) return template.slice(cursor).trim().length > 0;
    if (template.slice(cursor, opening).trim()) return true;
    const closing = template.indexOf("}}", opening + 3);
    if (closing === -1) return true;
    cursor = closing + 2;
  }
  return false;
}

function matchesNameTemplate(template: string, name: string): boolean {
  if (["\r", "\n", "\u2028", "\u2029"].some((character) => name.includes(character))) return false;
  const parts: string[] = [];
  let cursor: number;
  let literal = 0;
  let closing = -1;
  for (let opening = template.indexOf("${{"); opening !== -1; opening = template.indexOf("${{", cursor)) {
    if (closing < opening + 3) closing = template.indexOf("}", opening + 3);
    if (closing === -1) break;
    if (template[closing + 1] === "}") {
      parts.push(template.slice(literal, opening));
      cursor = closing + 2;
      literal = cursor;
    } else cursor = opening + 3;
  }
  parts.push(template.slice(literal));
  if (parts.length < 2 || !name.startsWith(parts[0]!)) return false;
  let position = parts[0]!.length;
  for (const part of parts.slice(1, -1)) {
    const found = name.indexOf(part, position);
    if (found === -1) return false;
    position = found + part.length;
  }
  const suffix = parts.at(-1)!;
  return (name.endsWith(suffix) && name.length - suffix.length >= position) ||
    name.indexOf(`${suffix} / `, position) !== -1 ||
    (name.endsWith(")") && name.indexOf(`${suffix} (`, position) !== -1);
}

export interface RunHistoryOptions {
  workflowId: number;
  /** `null` lists every branch. */
  branch: string | null;
  limit: number;
  excludeRunId?: number;
  concurrency?: number;
}

/** Backfills recent completed runs from the Actions API, oldest first. Used when no store is configured or it is still cold. */
export async function loadRunHistory(client: GitHubClient, repo: RepoRef, options: RunHistoryOptions): Promise<WorkflowSnapshot[]> {
  const response = await client.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
    ...repo,
    workflow_id: options.workflowId,
    status: "completed",
    per_page: Math.min(100, options.limit + 1),
    ...(options.branch ? { branch: options.branch } : {}),
  });
  const runs = ((response.data as { workflow_runs?: WorkflowRunPayload[] }).workflow_runs ?? [])
    .filter((run) => run.id !== options.excludeRunId)
    .slice(0, options.limit);
  const snapshots = await mapLimit(runs, options.concurrency ?? 4, async (run) =>
    buildWorkflowSnapshot(client, repo, run),
  );
  return snapshots.sort(byCompletion);
}

function parseNeeds(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function elapsed(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
