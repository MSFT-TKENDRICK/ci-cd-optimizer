import type { GitHubClient, RepoRef } from "../github/client.js";
import type { Diagnostic } from "../lint/types.js";

export const CHECK_NAME = "CI/CD Optimizer";
export const TELEMETRY_CHECK_PREFIX = "CI/CD Telemetry";

export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required";

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
  annotation_level: "notice" | "warning" | "failure";
  title: string;
  message: string;
  raw_details?: string;
}

export interface CheckOutput {
  title: string;
  summary: string;
  text?: string;
  annotations?: CheckAnnotation[];
}

/** GitHub limits: 65535 characters per output field, 50 annotations per request. */
export const MAX_OUTPUT_LENGTH = 65_535;
export const ANNOTATIONS_PER_REQUEST = 50;
export const MAX_ANNOTATIONS = 500;

const LEVEL: Record<Diagnostic["severity"], CheckAnnotation["annotation_level"]> = {
  error: "failure",
  warn: "warning",
  info: "notice",
};

export function annotationsFor(diagnostics: readonly Diagnostic[]): CheckAnnotation[] {
  return diagnostics.slice(0, MAX_ANNOTATIONS).map((diagnostic) => {
    const line = Math.max(1, diagnostic.line);
    return {
      path: diagnostic.path,
      start_line: line,
      end_line: line,
      // Columns are only allowed on single-line annotations.
      ...(diagnostic.column > 0 ? { start_column: diagnostic.column, end_column: diagnostic.column } : {}),
      annotation_level: LEVEL[diagnostic.severity],
      title: diagnostic.ruleId,
      message: truncate(`${diagnostic.message}${diagnostic.suggestion ? `\n\nFix: ${diagnostic.suggestion}` : ""}`, 64_000),
      raw_details: `${diagnostic.docsUrl}\nimpact: ${diagnostic.impact}, confidence: ${diagnostic.confidence}`,
    };
  });
}

export function truncate(text: string, max = MAX_OUTPUT_LENGTH): string {
  if (text.length <= max) return text;
  const note = "\n\n_…truncated._";
  return `${text.slice(0, max - note.length)}${note}`;
}

function output(value: CheckOutput, annotations: readonly CheckAnnotation[]): Record<string, unknown> {
  return {
    title: truncate(value.title, 255),
    summary: truncate(value.summary),
    ...(value.text ? { text: truncate(value.text) } : {}),
    ...(annotations.length > 0 ? { annotations } : {}),
  };
}

/** Starts an in-progress check run so the pull request shows activity while analysis runs. */
export async function startCheck(client: GitHubClient, repo: RepoRef, options: { name: string; headSha: string; detailsUrl?: string }): Promise<number> {
  const response = await client.request("POST /repos/{owner}/{repo}/check-runs", {
    ...repo,
    name: options.name,
    head_sha: options.headSha,
    status: "in_progress",
    started_at: new Date().toISOString(),
    ...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
  });
  return (response.data as { id: number }).id;
}

/** Completes a check run; annotations beyond the first 50 are appended by follow-up updates. */
export async function completeCheck(client: GitHubClient, repo: RepoRef, id: number, conclusion: CheckConclusion, value: CheckOutput): Promise<void> {
  const annotations = (value.annotations ?? []).slice(0, MAX_ANNOTATIONS);
  const batches = chunk(annotations, ANNOTATIONS_PER_REQUEST);
  await client.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
    ...repo,
    check_run_id: id,
    status: "completed",
    conclusion,
    completed_at: new Date().toISOString(),
    output: output(value, batches[0] ?? []),
  });
  for (const batch of batches.slice(1)) {
    await client.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", { ...repo, check_run_id: id, output: output(value, batch) });
  }
}

/** Creates an already-completed check run (for results that are ready immediately, such as telemetry reports). */
export async function publishCheck(
  client: GitHubClient,
  repo: RepoRef,
  options: { name: string; headSha: string; conclusion: CheckConclusion; detailsUrl?: string } & CheckOutput,
): Promise<number> {
  const annotations = (options.annotations ?? []).slice(0, MAX_ANNOTATIONS);
  const batches = chunk(annotations, ANNOTATIONS_PER_REQUEST);
  const response = await client.request("POST /repos/{owner}/{repo}/check-runs", {
    ...repo,
    name: options.name,
    head_sha: options.headSha,
    status: "completed",
    conclusion: options.conclusion,
    completed_at: new Date().toISOString(),
    ...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
    output: output(options, batches[0] ?? []),
  });
  const id = (response.data as { id: number }).id;
  for (const batch of batches.slice(1)) {
    await client.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", { ...repo, check_run_id: id, output: output(options, batch) });
  }
  return id;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}
