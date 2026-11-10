import { httpStatus, type GitHubClient, type RepoRef } from "../github/client.js";
import { describeScan, scanRepository } from "../service/scan.js";
import { processWorkflowRun } from "../service/workflow-run.js";
import { calculateCriticalPath } from "../telemetry/report.js";
import type { WorkflowRunPayload } from "../telemetry/snapshot.js";
import type { WorkflowBaseline } from "../telemetry/types.js";
import type { ActiveSeverity } from "../lint/types.js";
import { AgentError, summarizeDiagnostics, type DiagnosticPage } from "./workspace.js";
import { escapeMarkdown, LIMITS, sanitizeMarkdown } from "./safety.js";
export { sanitizeMarkdown } from "./safety.js";

/**
 * Opt-in, read-only GitHub operations for the agent integrations. Every call is a dry run (no check runs, issues,
 * pull requests, SARIF uploads, or database writes) and is limited to an explicit repository allowlist, so a
 * prompt-injected agent cannot point the user's token at another repository.
 */
export interface RemoteAccess {
  client: GitHubClient;
  /** Allowed `owner/repo` names (case-insensitive). */
  allow: readonly string[];
  /** Pins repository identity across operations; hosted deployments configure these IDs explicitly. */
  repositoryIds?: Map<string, number>;
  requirePull?: boolean;
  signal?: AbortSignal;
}

/** Remote access is an explicit process opt-in with a fixed allowlist, never derived from a client-selected workspace. */
export interface RemoteOptions {
  createClient: (signal: AbortSignal) => GitHubClient;
  allow: readonly string[];
  repositoryIds?: Map<string, number>;
  requirePull?: boolean;
}

export interface RemoteRepository {
  repo: RepoRef;
  id: number;
  fullName: string;
}

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const MAX_REPORT_CHARS = 30_000;
const MAX_STEPS = 10;

export function normalizeRepository(value: string): string {
  const name = value.trim().replace(/\.git$/i, "");
  if (!NAME.test(name) || name.endsWith("/.") || name.endsWith("/..")) throw new AgentError(`"${value}" is not an owner/repo name.`);
  return name.toLowerCase();
}

/** Checks the allowlist, then resolves the repository id so later calls are bound to that exact repository. */
export async function resolveRepository(access: RemoteAccess, value: string): Promise<RemoteRepository> {
  access.signal?.throwIfAborted();
  const name = normalizeRepository(value);
  const allowed = new Set(access.allow.map((entry) => entry.toLowerCase()));
  if (!allowed.has(name)) {
    throw new AgentError(`${value} is not in the allowed repositories (${[...allowed].join(", ") || "none"}). Start the server with --repo ${value} to allow it.`);
  }
  const [owner, repo] = name.split("/") as [string, string];
  let data: { id?: unknown; full_name?: unknown; permissions?: { pull?: boolean } };
  try {
    data = (await access.client.request("GET /repos/{owner}/{repo}", { owner, repo })).data as typeof data;
  } catch (error) {
    if ([401, 403, 404].includes(httpStatus(error) ?? 0)) throw new AgentError("Repository unavailable or access denied.");
    throw error;
  }
  if (!Number.isSafeInteger(data.id) || typeof data.id !== "number" || data.id <= 0 || typeof data.full_name !== "string") throw new AgentError(`GitHub returned an unexpected response for ${value}.`);
  if (data.full_name.toLowerCase() !== name) throw new AgentError(`${value} now resolves to ${data.full_name} (renamed or transferred); allow that name instead.`);
  if (access.requirePull && data.permissions?.pull !== true) throw new AgentError("Repository unavailable or access denied.");
  const expected = access.repositoryIds?.get(name);
  if (expected !== undefined && expected !== data.id) throw new AgentError("Repository identity changed; access denied.");
  access.repositoryIds?.set(name, data.id);
  const [canonicalOwner, canonicalRepo] = data.full_name.split("/") as [string, string];
  return { repo: { owner: canonicalOwner, repo: canonicalRepo }, id: data.id, fullName: data.full_name };
}

/** Reauthorize every repository read, not just the first command. Also prevents a future service change from writing. */
export function repositoryReader(access: RemoteAccess, target: RemoteRepository): GitHubClient {
  let requests = 0;
  let bytes = 0;
  return {
    async request(route, parameters = {}) {
      access.signal?.throwIfAborted();
      if (!/^GET \/repos\/\{owner\}\/\{repo\}(?:\/[a-zA-Z0-9_{}/-]+)?$/.test(route) ||
          parameters.owner !== target.repo.owner || parameters.repo !== target.repo.repo) {
        throw new AgentError("Only read-only requests to the authorized repository are permitted.");
      }
      if (++requests > LIMITS.githubRequests / 2) throw new AgentError("GitHub request budget exceeded; narrow the operation.");
      const current = await resolveRepository(access, target.fullName);
      if (current.id !== target.id) throw new AgentError("Repository identity changed; access denied.");
      access.signal?.throwIfAborted();
      const result = await access.client.request(route, parameters);
      const size = Buffer.byteLength(JSON.stringify(result.data) ?? "");
      bytes += size;
      if (size > LIMITS.githubResponseBytes || bytes > LIMITS.githubTotalBytes) throw new AgentError("GitHub response budget exceeded; narrow the operation.");
      access.signal?.throwIfAborted();
      return result;
    },
  };
}

export interface RemoteScanSummary extends Partial<DiagnosticPage> {
  repo: string;
  ref: string;
  sha?: string;
  status: "scanned" | "disabled" | "invalid-config";
  summary: string;
  configProblems?: string[];
  omittedConfigProblems?: number;
  omittedConfigProblemCharacters?: number;
  omittedSummaryCharacters?: number;
  inventoryComplete?: boolean;
  /** Always true: the scan computed findings without writing anything to GitHub. */
  dryRun: true;
}

/** Lints a repository's default branch (or a ref) through the GitHub API, exactly as the App would, without writing. */
export async function remoteScan(
  access: RemoteAccess,
  request: { repo: string; ref?: string; minSeverity?: ActiveSeverity; limit?: number },
): Promise<RemoteScanSummary> {
  const target = await resolveRepository(access, request.repo);
  const scan = await scanRepository(repositoryReader(access, target), target.repo, {
    dryRun: true,
    uploadSarif: false,
    issues: false,
    fixes: false,
    expectedRepositoryId: target.id,
    ...(request.ref ? { ref: request.ref } : {}),
  });
  const summary = sanitizeMarkdown(describeScan(scan), 4096);
  const problems = scan.configProblems?.slice(0, 100).map((problem) => sanitizeMarkdown(problem, 2048));
  return {
    repo: scan.repo,
    ref: scan.ref,
    ...(scan.sha ? { sha: scan.sha } : {}),
    status: scan.status,
    summary: summary.text,
    omittedSummaryCharacters: summary.omittedCharacters,
    ...(problems ? {
      configProblems: problems.map((problem) => problem.text),
      omittedConfigProblems: Math.max(0, (scan.configProblems?.length ?? 0) - 100),
      omittedConfigProblemCharacters: problems.reduce((total, problem) => total + problem.omittedCharacters, 0),
    } : {}),
    ...(scan.inventoryComplete !== undefined ? { inventoryComplete: scan.inventoryComplete } : {}),
    ...(scan.result ? summarizeDiagnostics(scan.result.diagnostics, request.minSeverity, request.limit) : {}),
    dryRun: true,
  };
}

export interface RunJob {
  key: string;
  name: string;
  conclusion: string | null;
  durationMs: number;
  queueMs?: number;
  needs: string[];
  omittedNeeds: number;
  onCriticalPath: boolean;
  /** Median duration of this job over comparable earlier runs, when known. */
  baselineMs?: number;
}

export interface RunReport {
  repo: string;
  status: "processed" | "disabled" | "skipped";
  reason?: string;
  run?: {
    id: number;
    attempt: number;
    workflow: string;
    path?: string;
    event: string;
    branch: string | null;
    headSha: string;
    conclusion: string | null;
    durationMs: number;
    queueMs: number | null;
    url?: string;
  };
  criticalPath?: { durationMs: number; jobKeys: string[]; omittedJobKeys: number };
  jobs?: RunJob[];
  jobsTotal?: number;
  omittedJobs?: number;
  slowestSteps?: { job: string; step: string; durationMs: number }[];
  omittedSteps?: number;
  baseline?: WorkflowBaseline;
  samples?: number;
  /** Escaped agent-specific Markdown and Gantt chart; repository-derived content remains untrusted data. */
  markdown?: string;
  markdownTruncated?: boolean;
  markdownOmittedCharacters?: number;
  omittedBaselineJobs?: number;
  dryRun: true;
}

/** Builds the timeline, critical path, and baseline comparison for one completed workflow run, without writing. */
export async function remoteRunReport(access: RemoteAccess, request: { repo: string; runId: number; markdown?: boolean }): Promise<RunReport> {
  if (!Number.isSafeInteger(request.runId) || request.runId <= 0) throw new AgentError("runId must be a positive integer.");
  const target = await resolveRepository(access, request.repo);
  const client = repositoryReader(access, target);
  let run: WorkflowRunPayload;
  try {
    run = (await client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", { ...target.repo, run_id: request.runId })).data as WorkflowRunPayload;
  } catch (error) {
    if (httpStatus(error) === 404) throw new AgentError(`Workflow run ${request.runId} was not found in ${target.fullName}.`);
    throw error;
  }
  if (run.id !== request.runId) throw new AgentError("Workflow run identity does not match the request.");
  const runRepo = (run as WorkflowRunPayload & { repository?: { id?: unknown } }).repository;
  if (runRepo && runRepo.id !== target.id) throw new AgentError("Workflow run repository identity does not match.");
  const result = await processWorkflowRun(client, target.repo, run, { dryRun: true, check: false, alerts: false, expectedRepositoryId: target.id });
  const report: RunReport = { repo: target.fullName, status: result.status, ...(result.reason ? { reason: result.reason } : {}), dryRun: true };
  const snapshot = result.snapshot;
  if (!snapshot) return report;
  const critical = calculateCriticalPath(snapshot.jobs);
  const onPath = new Set(critical.jobKeys);
  report.run = {
    id: snapshot.runId,
    attempt: snapshot.runAttempt,
    workflow: snapshot.workflowName,
    ...(snapshot.path ? { path: snapshot.path } : {}),
    event: snapshot.event,
    branch: snapshot.branch,
    headSha: snapshot.headSha,
    conclusion: snapshot.conclusion,
    durationMs: snapshot.durationMs,
    queueMs: snapshot.queueMs,
    ...(snapshot.htmlUrl ? { url: snapshot.htmlUrl } : {}),
  };
  report.criticalPath = { ...critical, jobKeys: critical.jobKeys.slice(0, 100), omittedJobKeys: Math.max(0, critical.jobKeys.length - 100) };
  report.jobsTotal = snapshot.jobs.length;
  report.omittedJobs = Math.max(0, snapshot.jobs.length - 100);
  report.jobs = snapshot.jobs.slice(0, 100).map((job) => {
    const baselineMs = result.baseline?.jobs?.[job.key];
    return {
      key: job.key,
      name: job.name,
      conclusion: job.conclusion,
      durationMs: job.durationMs,
      ...(job.queueMs !== undefined ? { queueMs: job.queueMs } : {}),
      needs: job.needs.slice(0, 100),
      omittedNeeds: Math.max(0, job.needs.length - 100),
      onCriticalPath: onPath.has(job.key),
      ...(baselineMs !== undefined ? { baselineMs } : {}),
    };
  });
  const steps = snapshot.jobs.flatMap((job) => (job.steps ?? []).map((step) => ({ job: job.key, step: step.name, durationMs: step.durationMs })));
  report.omittedSteps = Math.max(0, steps.length - MAX_STEPS);
  report.slowestSteps = steps
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, MAX_STEPS);
  if (result.baseline) {
    const jobs = Object.entries(result.baseline.jobs ?? {});
    report.baseline = { ...result.baseline, jobs: Object.fromEntries(jobs.slice(0, 100)) };
    report.omittedBaselineJobs = Math.max(0, jobs.length - 100);
  }
  if (result.samples !== undefined) report.samples = result.samples;
  if (request.markdown) {
    // Render trusted layout with escaped repository strings; never forward the App's raw repository-derived Markdown.
    const mermaidLabel = (value: string) => value.replace(/[^a-zA-Z0-9 _.-]/g, " ").slice(0, 80);
    const timestamp = (value: string) => new Date(value).toISOString().replace(/\.\d{3}Z$/, "");
    const markdown = sanitizeMarkdown([
      `## ${escapeMarkdown(snapshot.workflowName)} performance snapshot`,
      `Run ${snapshot.runId}, attempt ${snapshot.runAttempt}; ${snapshot.durationMs} ms; queue ${snapshot.queueMs ?? "unavailable"} ms.`,
      `Estimated critical path: ${critical.durationMs} ms — ${report.criticalPath.jobKeys.map(escapeMarkdown).join(" → ")}.`,
      result.baseline ? `Baseline: ${result.baseline.medianDurationMs} ms (${result.baseline.sampleCount} comparable samples).` : "No comparable baseline.",
      "", "| Job | Duration (ms) | Conclusion |", "|---|---:|---|",
      ...report.jobs.map((job) => `| ${escapeMarkdown(job.name)} | ${job.durationMs} | ${escapeMarkdown(job.conclusion ?? "unknown")} |`),
      "", "```mermaid", "gantt", `    title ${mermaidLabel(snapshot.workflowName)}`,
      "    dateFormat YYYY-MM-DDTHH:mm:ss", "    section Jobs",
      ...snapshot.jobs.slice(0, 100).map((job, index) => `    ${mermaidLabel(job.name)} :j${index}, ${timestamp(job.startedAt)}, ${timestamp(job.completedAt)}`),
      "```", ...(report.omittedJobs ? [`${report.omittedJobs} jobs omitted from this output.`] : []),
    ].join("\n"), MAX_REPORT_CHARS);
    report.markdown = markdown.text;
    report.markdownTruncated = markdown.truncated;
    report.markdownOmittedCharacters = markdown.omittedCharacters;
  }
  return report;
}
