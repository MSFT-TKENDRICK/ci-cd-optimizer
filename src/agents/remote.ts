import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { httpStatus, type GitHubClient, type RepoRef } from "../github/client.js";
import { describeScan, scanRepository } from "../service/scan.js";
import { processWorkflowRun } from "../service/workflow-run.js";
import { calculateCriticalPath } from "../telemetry/report.js";
import type { WorkflowRunPayload } from "../telemetry/snapshot.js";
import type { WorkflowBaseline } from "../telemetry/types.js";
import type { ActiveSeverity } from "../lint/types.js";
import { AgentError, summarizeDiagnostics, type DiagnosticPage } from "./workspace.js";

/**
 * Opt-in, read-only GitHub operations for the agent integrations. Every call is a dry run (no check runs, issues,
 * pull requests, SARIF uploads, or database writes) and is limited to an explicit repository allowlist, so a
 * prompt-injected agent cannot point the user's token at another repository.
 */
export interface RemoteAccess {
  client: GitHubClient;
  /** Allowed `owner/repo` names (case-insensitive). */
  allow: readonly string[];
}

/** Remote access as configured at startup: without `allow`, only the resolved workspace's `origin` repository is allowed. */
export interface RemoteOptions {
  client: GitHubClient;
  allow?: readonly string[];
  /** GitHub server URL used to recognize the origin remote (default https://github.com). */
  serverUrl?: string;
}

export interface RemoteRepository {
  repo: RepoRef;
  id: number;
  fullName: string;
}

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const MAX_REPORT_CHARS = 60_000;
const MAX_STEPS = 10;

export function normalizeRepository(value: string): string {
  const name = value.trim().replace(/\.git$/i, "");
  if (!NAME.test(name) || name.endsWith("/.") || name.endsWith("/..")) throw new AgentError(`"${value}" is not an owner/repo name.`);
  return name.toLowerCase();
}

/** The GitHub `owner/repo` of the workspace's `origin` remote, if it points at GitHub. */
export async function originRepository(root: string, serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com"): Promise<string | undefined> {
  const url = await promisify(execFile)("git", ["-C", root, "remote", "get-url", "origin"], { timeout: 5_000, windowsHide: true })
    .then(({ stdout }) => stdout.trim(), () => "");
  return parseRemoteUrl(url, serverUrl);
}

export function parseRemoteUrl(url: string, serverUrl = "https://github.com"): string | undefined {
  const host = new URL(serverUrl).host.toLowerCase();
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url);
  let candidateHost: string;
  let path: string;
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    candidateHost = scp[1] as string;
    path = scp[2] as string;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    candidateHost = parsed.host;
    path = parsed.pathname;
  }
  if (candidateHost.toLowerCase() !== host) return undefined;
  try {
    return normalizeRepository(path.replace(/^\/+|\/+$/g, ""));
  } catch {
    return undefined;
  }
}

/** Checks the allowlist, then resolves the repository id so later calls are bound to that exact repository. */
export async function resolveRepository(access: RemoteAccess, value: string): Promise<RemoteRepository> {
  const name = normalizeRepository(value);
  const allowed = new Set(access.allow.map((entry) => entry.toLowerCase()));
  if (!allowed.has(name)) {
    throw new AgentError(`${value} is not in the allowed repositories (${[...allowed].join(", ") || "none"}). Start the server with --repo ${value} to allow it.`);
  }
  const [owner, repo] = name.split("/") as [string, string];
  let data: { id?: unknown; full_name?: unknown };
  try {
    data = (await access.client.request("GET /repos/{owner}/{repo}", { owner, repo })).data as typeof data;
  } catch (error) {
    if (httpStatus(error) === 404) throw new AgentError(`Repository ${value} was not found, or the token cannot read it.`);
    throw error;
  }
  if (typeof data.id !== "number" || typeof data.full_name !== "string") throw new AgentError(`GitHub returned an unexpected response for ${value}.`);
  if (data.full_name.toLowerCase() !== name) throw new AgentError(`${value} now resolves to ${data.full_name} (renamed or transferred); allow that name instead.`);
  const [canonicalOwner, canonicalRepo] = data.full_name.split("/") as [string, string];
  return { repo: { owner: canonicalOwner, repo: canonicalRepo }, id: data.id, fullName: data.full_name };
}

export interface RemoteScanSummary extends Partial<DiagnosticPage> {
  repo: string;
  ref: string;
  sha?: string;
  status: "scanned" | "disabled" | "invalid-config";
  summary: string;
  configProblems?: string[];
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
  const scan = await scanRepository(access.client, target.repo, {
    dryRun: true,
    uploadSarif: false,
    issues: false,
    fixes: false,
    expectedRepositoryId: target.id,
    ...(request.ref ? { ref: request.ref } : {}),
  });
  return {
    repo: scan.repo,
    ref: scan.ref,
    ...(scan.sha ? { sha: scan.sha } : {}),
    status: scan.status,
    summary: describeScan(scan),
    ...(scan.configProblems ? { configProblems: scan.configProblems } : {}),
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
  criticalPath?: { durationMs: number; jobKeys: string[] };
  jobs?: RunJob[];
  slowestSteps?: { job: string; step: string; durationMs: number }[];
  baseline?: WorkflowBaseline;
  samples?: number;
  /** The App's Markdown report (Gantt chart and dependency graph); untrusted text from the repository. */
  markdown?: string;
  markdownTruncated?: boolean;
  dryRun: true;
}

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

/** Strips control and bidirectional-override characters and caps the length of repository-derived Markdown. */
export function sanitizeMarkdown(text: string, max = MAX_REPORT_CHARS): { text: string; truncated: boolean } {
  const clean = text.replace(CONTROL, "");
  return clean.length > max ? { text: `${clean.slice(0, max)}\n\n… (truncated)`, truncated: true } : { text: clean, truncated: false };
}

/** Builds the timeline, critical path, and baseline comparison for one completed workflow run, without writing. */
export async function remoteRunReport(access: RemoteAccess, request: { repo: string; runId: number; markdown?: boolean }): Promise<RunReport> {
  if (!Number.isSafeInteger(request.runId) || request.runId <= 0) throw new AgentError("runId must be a positive integer.");
  const target = await resolveRepository(access, request.repo);
  let run: WorkflowRunPayload;
  try {
    run = (await access.client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", { ...target.repo, run_id: request.runId })).data as WorkflowRunPayload;
  } catch (error) {
    if (httpStatus(error) === 404) throw new AgentError(`Workflow run ${request.runId} was not found in ${target.fullName}.`);
    throw error;
  }
  const result = await processWorkflowRun(access.client, target.repo, run, { dryRun: true, check: false, alerts: false, expectedRepositoryId: target.id });
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
  report.criticalPath = critical;
  report.jobs = snapshot.jobs.map((job) => {
    const baselineMs = result.baseline?.jobs?.[job.key];
    return {
      key: job.key,
      name: job.name,
      conclusion: job.conclusion,
      durationMs: job.durationMs,
      ...(job.queueMs !== undefined ? { queueMs: job.queueMs } : {}),
      needs: job.needs,
      onCriticalPath: onPath.has(job.key),
      ...(baselineMs !== undefined ? { baselineMs } : {}),
    };
  });
  report.slowestSteps = snapshot.jobs
    .flatMap((job) => (job.steps ?? []).map((step) => ({ job: job.key, step: step.name, durationMs: step.durationMs })))
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, MAX_STEPS);
  if (result.baseline) report.baseline = result.baseline;
  if (result.samples !== undefined) report.samples = result.samples;
  if (request.markdown && result.report) {
    const markdown = sanitizeMarkdown(result.report);
    report.markdown = markdown.text;
    report.markdownTruncated = markdown.truncated;
  }
  return report;
}
