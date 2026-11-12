import { type GitHubClient, paginate, type RepoRef } from "../github/client.js";
import type { ActiveSeverity, Diagnostic } from "../lint/types.js";
import { capComment, escapeInline } from "./escape.js";
import { NAME_PATTERN } from "./project.js";
import type { ReviewOutcome, ReviewStatus } from "./review.js";

/**
 * Rules whose findings point at exploitable weaknesses (unpinned third-party code, untrusted input reaching
 * privileged workflows). Public reports show only how many there are; maintainers get details privately.
 */
export const SENSITIVE_RULES: ReadonlySet<string> = new Set([
  "hermeticity/actions-lock",
  "hermeticity/pin-actions",
  "hermeticity/pin-container-images",
  "hermeticity/docker-base-digest",
  "affected/trusted-change-detection",
]);
export const SENSITIVE_TEXT = /pull_request_target|permissions|secret|token|injection|untrusted/i;
export const MAX_REPORT_FINDINGS = 500;
export const MAX_MARKDOWN_FINDINGS = 100;
export const REVIEW_BOT_LOGIN = "github-actions[bot]";

export interface ReportFinding {
  ruleId: string;
  severity: ActiveSeverity;
  path: string;
  line: number;
  column: number;
  message: string;
  suggestion?: string;
  docsUrl: string;
}

export interface ReviewReport {
  schemaVersion: 1;
  project: string;
  repository?: { fullName: string; id: number; sha: string };
  status: ReviewStatus;
  problems: string[];
  notes: string[];
  findings: ReportFinding[];
  redacted: { count: number; rules: string[] };
  summary: { filesAnalyzed: number; error: number; warn: number; info: number; inventoryComplete: boolean };
}

export function isSensitive(diagnostic: Pick<Diagnostic, "ruleId" | "message" | "suggestion">): boolean {
  return SENSITIVE_RULES.has(diagnostic.ruleId) || SENSITIVE_TEXT.test(diagnostic.message) || SENSITIVE_TEXT.test(diagnostic.suggestion ?? "");
}

const SEVERITY_ORDER: Record<ActiveSeverity, number> = { error: 0, warn: 1, info: 2 };

function finding(diagnostic: Diagnostic): ReportFinding {
  return {
    ruleId: diagnostic.ruleId,
    severity: diagnostic.severity,
    path: diagnostic.path,
    line: diagnostic.line,
    column: diagnostic.column,
    message: diagnostic.message,
    ...(diagnostic.suggestion ? { suggestion: diagnostic.suggestion } : {}),
    docsUrl: diagnostic.docsUrl,
  };
}

/**
 * Builds the report. In public mode security-sensitive findings are reduced to counts, and nothing at all about the
 * target's files is reported unless consent was verified.
 */
export function buildReport(outcome: ReviewOutcome, options: { public: boolean }): ReviewReport {
  const diagnostics = outcome.status === "ok" ? outcome.diagnostics : [];
  const shown: Diagnostic[] = [];
  const hidden: Diagnostic[] = [];
  for (const diagnostic of diagnostics) (options.public && isSensitive(diagnostic) ? hidden : shown).push(diagnostic);
  shown.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.path.localeCompare(b.path) || a.line - b.line || a.ruleId.localeCompare(b.ruleId));
  const count = (severity: ActiveSeverity) => diagnostics.filter((diagnostic) => diagnostic.severity === severity).length;
  const repository = outcome.repository;
  return {
    schemaVersion: 1,
    project: outcome.project,
    ...(repository ? { repository: { fullName: repository.fullName, id: repository.id, sha: repository.sha } } : {}),
    status: outcome.status,
    problems: [...outcome.problems],
    notes: [...outcome.notes],
    findings: shown.slice(0, MAX_REPORT_FINDINGS).map(finding),
    redacted: { count: hidden.length, rules: [...new Set(hidden.map((diagnostic) => diagnostic.ruleId))].sort() },
    summary: { filesAnalyzed: outcome.status === "ok" ? outcome.filesAnalyzed : 0, error: count("error"), warn: count("warn"), info: count("info"), inventoryComplete: outcome.inventoryComplete },
  };
}

/** Process exit code for a report: blocking statuses fail, `ok` and `paused` pass regardless of findings. */
export function reportExitCode(report: Pick<ReviewReport, "status">): number {
  return report.status === "ok" || report.status === "paused" ? 0 : 1;
}

const safeName = (name: string) => (NAME_PATTERN.test(name) ? name : "intake");

export function reviewMarker(name: string): string {
  return `<!-- ci-cd-optimizer-review:${safeName(name)} -->`;
}

const STATUS_TEXT: Record<ReviewStatus, string> = {
  ok: "Reviewed",
  invalid: "Submission is invalid",
  "consent-failed": "Consent could not be verified",
  paused: "Paused",
  error: "Review failed",
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function bullets(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return ["", `**${title}**`, "", ...items.slice(0, 50).map((item) => `- ${escapeInline(item)}`), ...(items.length > 50 ? [`- …and ${items.length - 50} more`] : [])];
}

export interface MarkdownOptions {
  /** Heading level; scheduled summaries nest project reports one level deeper. */
  heading?: string;
  /** Replaces the status label (for example for opt-out pull requests that are not reviewed). */
  statusText?: string;
}

/** Renders the report as Markdown. Every value that came from a submitter or target repository is escaped. */
export function renderMarkdown(report: ReviewReport, options: MarkdownOptions = {}): string {
  const name = safeName(report.project);
  const lines = [reviewMarker(report.project), `${options.heading ?? "###"} CI/CD optimizer review: ${escapeInline(report.project, 63)}`, ""];
  const status = `**Status:** ${options.statusText ?? STATUS_TEXT[report.status]}`;
  const repository = report.repository;
  if (repository && /^[0-9a-f]{40}$/.test(repository.sha)) {
    lines.push(`${status} · ${escapeInline(repository.fullName, 140)} (repository id ${repository.id}) at commit \`${repository.sha.slice(0, 12)}\``);
  } else {
    lines.push(status);
  }
  lines.push(...bullets("Problems", report.problems));
  if (report.status === "ok" && repository) {
    const { summary } = report;
    lines.push("", `Analyzed ${plural(summary.filesAnalyzed, "file")}: ${summary.error} error, ${summary.warn} warn, ${summary.info} info${summary.inventoryComplete ? "" : " (partial inventory)"}.`);
    if (report.findings.length > 0) {
      lines.push("", "| Severity | Rule | Location | Finding |", "| --- | --- | --- | --- |");
      for (const item of report.findings.slice(0, MAX_MARKDOWN_FINDINGS)) {
        const message = item.suggestion ? `${item.message} Suggestion: ${item.suggestion}` : item.message;
        lines.push(`| ${item.severity} | ${escapeInline(item.ruleId, 80)} | ${escapeInline(`${item.path}:${item.line}`, 160)} | ${escapeInline(message)} |`);
      }
      const omitted = summary.error + summary.warn + summary.info - report.redacted.count - Math.min(report.findings.length, MAX_MARKDOWN_FINDINGS);
      if (omitted > 0) lines.push("", `_${plural(omitted, "more finding")} not shown._`);
    }
    if (report.redacted.count > 0) {
      lines.push("", `${plural(report.redacted.count, "security-sensitive finding")} from ${plural(report.redacted.rules.length, "rule")} withheld from this public report.`);
    }
  }
  lines.push(...bullets("Notes", report.notes));
  lines.push(
    "",
    "<sub>Static analysis through the GitHub API only; no repository code was executed. Maintainers can see every finding, including withheld ones, by running " +
      `\`npm run cli -- review run projects/${name}/project.yaml\` in a checkout of the registry, or can ask for details through private vulnerability reporting.</sub>`,
  );
  return capComment(`${lines.join("\n")}\n`);
}

export function renderJson(report: ReviewReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

interface IssueComment {
  id: number;
  body?: string | null;
  user?: { login?: string; type?: string } | null;
}

/**
 * Creates or updates the single review comment for `name`. Only comments carrying the exact marker on their first
 * line AND authored by the program's bot are candidates, so a marker planted in a user's comment is never edited.
 */
export async function upsertReviewComment(
  client: GitHubClient,
  repo: RepoRef,
  issue: number,
  name: string,
  body: string,
  bot = REVIEW_BOT_LOGIN,
): Promise<{ action: "created" | "updated"; id?: number }> {
  const marker = reviewMarker(name);
  const comments = await paginate<IssueComment>(client, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: issue }, 3);
  const existing = comments.find((comment) => comment.user?.login === bot && comment.user.type === "Bot" && (comment.body ?? "").split("\n", 1)[0] === marker);
  const text = body.startsWith(`${marker}\n`) ? body : `${marker}\n${body}`;
  if (existing) {
    await client.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", { ...repo, comment_id: existing.id, body: text });
    return { action: "updated", id: existing.id };
  }
  const response = await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repo, issue_number: issue, body: text });
  const id = (response.data as { id?: unknown } | null)?.id;
  return typeof id === "number" ? { action: "created", id } : { action: "created" };
}
