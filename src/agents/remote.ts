import { httpStatus, type GitHubClient, type RepoRef } from "../github/client.js";
import { describeScan, scanRepository } from "../service/scan.js";
import { processWorkflowRun } from "../service/workflow-run.js";
import type { RunAttribution } from "../telemetry/attribution.js";
import { calculateCriticalPath } from "../telemetry/report.js";
import type { WorkflowRunPayload } from "../telemetry/snapshot.js";
import type { WorkflowBaseline, WorkflowSnapshot } from "../telemetry/types.js";
import type { ActiveSeverity, ParseProblem } from "../lint/types.js";
import { AgentError, summarizeDiagnostics, type DiagnosticPage } from "./workspace.js";
import { escapeMarkdown, LIMITS, ownWork, sanitizeMarkdown } from "./safety.js";
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

export function operationAccess(options: RemoteOptions, signal: AbortSignal): RemoteAccess {
  let client: GitHubClient | undefined;
  return {
    ...options,
    signal,
    client: {
      request: (route, parameters) => ownWork(signal, (readSignal) => {
        client ??= options.createClient(readSignal);
        return client.request(route, parameters);
      }, (error) => !(route === "GET /repos/{owner}/{repo}/contents/{path}" && httpStatus(error) === 404)),
    },
  };
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
  status: "scanned" | "partial" | "disabled" | "invalid-config";
  /** False for parse failures, incomplete inventories, and scans that did not run. */
  analysisComplete: boolean;
  summary: string;
  configProblems?: string[];
  omittedConfigProblems?: number;
  omittedConfigProblemCharacters?: number;
  omittedSummaryCharacters?: number;
  inventoryComplete?: boolean;
  parseProblems?: (ParseProblem & { omittedCharacters: number })[];
  parseProblemCount?: number;
  omittedParseProblems?: number;
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
  const parseProblemCount = scan.result?.parseProblems.length ?? 0;
  const analysisComplete = Boolean(scan.result && scan.inventoryComplete && parseProblemCount === 0);
  const partial = scan.status === "scanned" && !analysisComplete;
  const summary = sanitizeMarkdown([
    ...(partial ? [`Partial analysis: ${parseProblemCount} parse problem(s)${scan.inventoryComplete ? "" : "; inventory incomplete"}.`] : []),
    describeScan(scan),
  ].join(" "), 4096);
  const problems = scan.configProblems?.slice(0, 100).map((problem) => sanitizeMarkdown(problem, 2048));
  return {
    repo: scan.repo,
    ref: scan.ref,
    ...(scan.sha ? { sha: scan.sha } : {}),
    status: partial ? "partial" : scan.status,
    analysisComplete,
    summary: summary.text,
    omittedSummaryCharacters: summary.omittedCharacters,
    ...(problems ? {
      configProblems: problems.map((problem) => problem.text),
      omittedConfigProblems: Math.max(0, (scan.configProblems?.length ?? 0) - 100),
      omittedConfigProblemCharacters: problems.reduce((total, problem) => total + problem.omittedCharacters, 0),
    } : {}),
    ...(scan.inventoryComplete !== undefined ? { inventoryComplete: scan.inventoryComplete } : {}),
    ...(scan.result ? {
      ...summarizeDiagnostics(scan.result.diagnostics, request.minSeverity, request.limit),
      parseProblemCount,
      omittedParseProblems: Math.max(0, parseProblemCount - 100),
      parseProblems: scan.result.parseProblems.slice(0, 100).map((problem) => {
        const path = sanitizeMarkdown(problem.path, 1024);
        const message = sanitizeMarkdown(problem.message, 2048);
        return { path: path.text, line: problem.line, message: message.text, omittedCharacters: path.omittedCharacters + message.omittedCharacters };
      }),
    } : {}),
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
  /** Absent when a complete, definition-backed critical path cannot be computed. */
  onCriticalPath?: boolean;
  /** Median duration of this job over comparable earlier runs, when known. */
  baselineMs?: number;
}

export interface RunReport {
  repo: string;
  status: "processed" | "disabled" | "skipped";
  reason?: string;
  analysisStatus?: "complete" | "partial";
  provenance?: WorkflowSnapshot["provenance"];
  warnings?: string[];
  run?: {
    id: number;
    attempt: number;
    workflow: string;
    path?: string;
    event: string;
    branch: string | null;
    headSha: string;
    conclusion: string | null;
    /** Null when incomplete collected job telemetry cannot establish the run's duration. */
    durationMs: number | null;
    queueMs: number | null;
    url?: string;
  };
  criticalPath?: { durationMs: number; jobKeys: string[]; omittedJobKeys: number };
  jobs?: RunJob[];
  /** Consistent upstream total_count, or null when absent, inconsistent, or invalid. */
  jobsTotal?: number | null;
  jobsFetched?: number;
  jobsAnalyzed?: number;
  jobsNotFetched?: number | null;
  jobPagesFetched?: number;
  /** Fetched/analyzed jobs omitted only from this response, not jobs missing from collection. */
  omittedJobs?: number;
  slowestSteps?: { job: string; step: string; durationMs: number }[];
  omittedSteps?: number;
  attribution?: {
    criticalSlackMs: number;
    coverage: RunAttribution["coverage"];
    bottlenecks: Pick<RunAttribution["bottlenecks"][number], "category" | "jobKey" | "jobName" | "observedMs" | "elapsedSavingsBoundMs" | "runnerSavingsBoundMs" | "summary" | "recommendation" | "evidence">[];
    omittedBottlenecks: number;
    gaps: Pick<RunAttribution["gaps"][number], "kind" | "jobKey" | "jobName" | "ms" | "detail">[];
    omittedGaps: number;
  };
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
  const reader = repositoryReader(access, target);
  let run: WorkflowRunPayload;
  try {
    run = (await reader.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", { ...target.repo, run_id: request.runId })).data as WorkflowRunPayload;
  } catch (error) {
    if (httpStatus(error) === 404) throw new AgentError(`Workflow run ${request.runId} was not found in ${target.fullName}.`);
    throw error;
  }
  if (run.id !== request.runId) throw new AgentError("Workflow run identity does not match the request.");
  const runRepo = (run as WorkflowRunPayload & { repository?: { id?: unknown } }).repository;
  if (runRepo && runRepo.id !== target.id) throw new AgentError("Workflow run repository identity does not match.");
  const fetchedJobs = new Set<number>();
  let pages = 0;
  let reportedTotal: number | undefined;
  let totalKnown = true;
  let totalsConsistent = true;
  let validJobs = true;
  // Capture the current attempt's API totals without changing the shared snapshot/evidence schema.
  const client: GitHubClient = {
    async request(route, parameters = {}) {
      const response = await reader.request(route, parameters);
      if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs" &&
          parameters.run_id === run.id && parameters.attempt_number === (run.run_attempt ?? 1)) {
        pages += 1;
        const data = response.data as { jobs?: { id?: unknown }[]; total_count?: unknown };
        const total = data.total_count;
        if (total === undefined) totalKnown = false;
        else if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || (reportedTotal !== undefined && reportedTotal !== total)) {
          totalKnown = false;
          totalsConsistent = false;
        }
        else reportedTotal = total;
        for (const job of data.jobs ?? []) {
          if (typeof job.id !== "number" || !Number.isSafeInteger(job.id) || job.id <= 0) validJobs = false;
          else fetchedJobs.add(job.id);
        }
      }
      return response;
    },
  };
  const result = await processWorkflowRun(client, target.repo, run, { dryRun: true, check: false, alerts: false, expectedRepositoryId: target.id });
  const report: RunReport = { repo: target.fullName, status: result.status, ...(result.reason ? { reason: result.reason } : {}), dryRun: true };
  const snapshot = result.snapshot;
  if (!snapshot) return report;
  const jobsTotal = totalKnown && reportedTotal !== undefined && reportedTotal >= fetchedJobs.size ? reportedTotal : null;
  const jobsComplete = snapshot.provenance?.jobsComplete === true && validJobs && totalsConsistent &&
    snapshot.jobs.length + (snapshot.provenance.externalChecks?.length ?? 0) === fetchedJobs.size &&
    (jobsTotal === null || jobsTotal === fetchedJobs.size);
  const definitionKnown = snapshot.provenance?.definitionKnown === true;
  const critical = jobsComplete && definitionKnown ? calculateCriticalPath(snapshot.jobs) : undefined;
  const onPath = new Set(critical?.jobKeys);
  report.analysisStatus = jobsComplete && definitionKnown ? "complete" : "partial";
  if (snapshot.provenance) report.provenance = { ...snapshot.provenance };
  report.warnings = [
    ...(!jobsComplete ? ["Incomplete job telemetry: run duration, critical path, and baseline comparison are unavailable. Job/step metrics describe collected telemetry only."] : []),
    ...(!totalsConsistent ? ["The upstream job total changed or was invalid during collection; authoritative totals are unknown."] : []),
    ...(!definitionKnown ? ["Workflow job definitions are incomplete or unresolved; no critical path is reported."] : []),
  ];
  const attribution = jobsComplete && definitionKnown ? result.attribution : undefined;
  if (attribution) {
    const text = (value: string) => sanitizeMarkdown(value, 1024).text;
    report.attribution = {
      criticalSlackMs: attribution.criticalSlackMs,
      coverage: attribution.coverage,
      bottlenecks: attribution.bottlenecks.slice(0, 10).map((finding) => ({
        category: finding.category,
        jobKey: text(finding.jobKey),
        jobName: text(finding.jobName),
        observedMs: finding.observedMs,
        elapsedSavingsBoundMs: finding.elapsedSavingsBoundMs,
        runnerSavingsBoundMs: finding.runnerSavingsBoundMs,
        summary: text(finding.summary),
        recommendation: text(finding.recommendation),
        evidence: finding.evidence.slice(0, 3).map(text),
      })),
      omittedBottlenecks: Math.max(0, attribution.bottlenecks.length - 10),
      gaps: attribution.gaps.slice(0, 20).map((gap) => ({
        kind: gap.kind,
        jobKey: text(gap.jobKey),
        ...(gap.jobName ? { jobName: text(gap.jobName) } : {}),
        ...(gap.ms !== undefined ? { ms: gap.ms } : {}),
        detail: text(gap.detail),
      })),
      omittedGaps: Math.max(0, attribution.gaps.length - 20),
    };
  }
  report.run = {
    id: snapshot.runId,
    attempt: snapshot.runAttempt,
    workflow: snapshot.workflowName,
    ...(snapshot.path ? { path: snapshot.path } : {}),
    event: snapshot.event,
    branch: snapshot.branch,
    headSha: snapshot.headSha,
    conclusion: snapshot.conclusion,
    durationMs: jobsComplete ? snapshot.durationMs : null,
    queueMs: snapshot.queueMs,
    ...(snapshot.htmlUrl ? { url: snapshot.htmlUrl } : {}),
  };
  if (critical) report.criticalPath = { ...critical, jobKeys: critical.jobKeys.slice(0, 100), omittedJobKeys: Math.max(0, critical.jobKeys.length - 100) };
  report.jobsTotal = jobsTotal;
  report.jobsFetched = fetchedJobs.size;
  report.jobsAnalyzed = snapshot.jobs.length;
  report.jobsNotFetched = jobsTotal === null ? null : jobsTotal - fetchedJobs.size;
  report.jobPagesFetched = pages;
  report.omittedJobs = Math.max(0, snapshot.jobs.length - 100);
  report.jobs = snapshot.jobs.slice(0, 100).map((job) => {
    const baselineMs = jobsComplete ? result.baseline?.jobs?.[job.key] : undefined;
    return {
      key: job.key,
      name: job.name,
      conclusion: job.conclusion,
      durationMs: job.durationMs,
      ...(job.queueMs !== undefined ? { queueMs: job.queueMs } : {}),
      needs: job.needs.slice(0, 100),
      omittedNeeds: Math.max(0, job.needs.length - 100),
      ...(critical ? { onCriticalPath: onPath.has(job.key) } : {}),
      ...(baselineMs !== undefined ? { baselineMs } : {}),
    };
  });
  const steps = snapshot.jobs.flatMap((job) => (job.steps ?? []).map((step) => ({ job: job.key, step: step.name, durationMs: step.durationMs })));
  report.omittedSteps = Math.max(0, steps.length - MAX_STEPS);
  report.slowestSteps = steps
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, MAX_STEPS);
  if (jobsComplete && result.baseline) {
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
      `Run ${snapshot.runId}, attempt ${snapshot.runAttempt}; duration ${jobsComplete ? `${snapshot.durationMs} ms` : "unavailable (incomplete job telemetry)"}; queue ${snapshot.queueMs ?? "unavailable"} ms.`,
      ...report.warnings.map((warning) => `**Warning:** ${warning}`),
      `Collector: ${escapeMarkdown(snapshot.provenance?.collector ?? "unknown")}; collected at ${escapeMarkdown(snapshot.provenance?.collectedAt ?? "unknown")}; ` +
        `job inventory ${snapshot.provenance?.jobsComplete === true ? "complete" : "incomplete or unknown"}; workflow definitions ${definitionKnown ? "known" : "incomplete or unknown"}.`,
      `Fetched ${report.jobsFetched} jobs across ${pages} page(s); upstream total: ${jobsTotal ?? "unknown"}. ` +
        `${report.jobsNotFetched === null ? "The number of unfetched jobs is unknown." : `${report.jobsNotFetched} upstream job(s) not fetched.`}`,
      `Showing ${report.jobs.length} of ${report.jobsAnalyzed} analyzed job(s); ${report.omittedJobs} fetched job(s) omitted from this response.`,
      critical && report.criticalPath ? `Estimated critical path: ${critical.durationMs} ms — ${report.criticalPath.jobKeys.map(escapeMarkdown).join(" → ")}.` : "Critical path unavailable.",
      report.baseline ? `Baseline: ${report.baseline.medianDurationMs} ms (${report.baseline.sampleCount} comparable samples).` : "No comparable baseline reported.",
      ...(report.attribution
        ? [
            "",
            "### Bottleneck evidence",
            `Parsed logs for ${report.attribution.coverage.jobsWithLogs}/${report.attribution.coverage.jobs} timed job(s); ${report.attribution.coverage.unexplainedMs} ms of runner time is unexplained or unobserved.`,
            "Savings are observed upper bounds, not predictions; findings may overlap and must not be added.",
            ...report.attribution.bottlenecks.map((finding) =>
              `- ${escapeMarkdown(finding.summary)} Next: ${escapeMarkdown(finding.recommendation)} Evidence: ${finding.evidence.map(escapeMarkdown).join("; ")}`,
            ),
            ...(report.attribution.omittedBottlenecks ? [`${report.attribution.omittedBottlenecks} additional bottleneck candidate(s) omitted.`] : []),
            ...(report.attribution.gaps.length
              ? ["", "#### Evidence coverage gaps", ...report.attribution.gaps.map((gap) =>
                  `- ${escapeMarkdown(gap.jobName ?? gap.jobKey)} (${escapeMarkdown(gap.kind)}): ${escapeMarkdown(gap.detail)}`,
                )]
              : []),
            ...(report.attribution.omittedGaps ? [`${report.attribution.omittedGaps} additional coverage gap(s) omitted.`] : []),
          ]
        : []),
      "", "| Job | Duration (ms) | Conclusion |", "|---|---:|---|",
      ...report.jobs.map((job) => `| ${escapeMarkdown(job.name)} | ${job.durationMs} | ${escapeMarkdown(job.conclusion ?? "unknown")} |`),
      "", "```mermaid", "gantt", `    title ${mermaidLabel(snapshot.workflowName)}`,
      "    dateFormat YYYY-MM-DDTHH:mm:ss", "    section Jobs",
      ...snapshot.jobs.slice(0, 100).map((job, index) => `    ${mermaidLabel(job.name)} :j${index}, ${timestamp(job.startedAt)}, ${timestamp(job.completedAt)}`),
      "```",
    ].join("\n"), MAX_REPORT_CHARS);
    report.markdown = markdown.text;
    report.markdownTruncated = markdown.truncated;
    report.markdownOmittedCharacters = markdown.omittedCharacters;
  }
  return report;
}
