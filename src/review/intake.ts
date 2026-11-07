import { type GitHubClient, httpStatus, paginate, type RepoRef } from "../github/client.js";
import { readCappedFile } from "./consent.js";
import { describeValue } from "./escape.js";
import { isLogin, parseProjectText, PROJECT_MAX_BYTES, type Project, sameLogin } from "./project.js";
import { buildReport, renderMarkdown, reportExitCode, type ReviewReport } from "./report.js";
import { reviewProject } from "./review.js";

/** Registry files under projects/ that are not submissions. Changes to them follow the normal contribution flow. */
export const META_FILES: ReadonlySet<string> = new Set(["projects/schema.json", "projects/README.md"]);
export const SUBMISSION_PATH = /^projects\/([a-z0-9][a-z0-9-]{0,62})\/project\.yaml$/;
export const MAX_OPEN_SUBMISSIONS_PER_AUTHOR = 3;
/** GitHub lists at most 3000 files for a pull request (30 pages of 100). */
const MAX_FILE_PAGES = 30;
const MAX_AUTHOR_PULLS_INSPECTED = 20;
export const INTAKE_ARTIFACT_MAX_BYTES = 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface PullFile {
  filename: string;
  status: string;
  previous_filename?: string;
}

export type FileClassification =
  | { kind: "none" }
  | { kind: "submission"; name: string; path: string; status: "added" | "modified" }
  | { kind: "opt-out"; name: string; path: string }
  | { kind: "invalid"; problems: string[]; name?: string };

/** True for any path the registry treats as project data (case-insensitive so `Projects/` cannot sidestep intake). */
function touchesProjects(path: string | undefined): boolean {
  return path !== undefined && path.toLowerCase().startsWith("projects/") && !META_FILES.has(path);
}

/**
 * Decides what a pull request is from its changed-file list. A submission changes exactly one
 * `projects/<name>/project.yaml` and nothing else; deleting it is an opt-out. Renames, extra files, multiple
 * projects, other files under a project directory, and unusual paths are rejected.
 */
export function classifyPullFiles(files: readonly PullFile[], changedFiles?: number): FileClassification {
  const projectFiles = files.filter((file) => touchesProjects(file.filename) || touchesProjects(file.previous_filename));
  if (projectFiles.length === 0) {
    if (changedFiles !== undefined && changedFiles > files.length) {
      return { kind: "invalid", problems: [`The pull request changes ${changedFiles} files but only ${files.length} could be listed, so intake cannot rule out a submission.`] };
    }
    return { kind: "none" };
  }
  const problems: string[] = [];
  const total = Math.max(files.length, changedFiles ?? 0);
  if (projectFiles.length > 1 || total > 1) {
    problems.push("A submission pull request must change exactly one file, projects/<name>/project.yaml, and nothing else. Split other changes into a separate pull request.");
  }
  const [file] = projectFiles;
  if (!file) return { kind: "invalid", problems };
  const match = SUBMISSION_PATH.exec(file.filename);
  const name = match?.[1];
  if (!match || !name) {
    problems.push(`${describeValue(file.filename, 120)} is not a valid submission path. Use projects/<name>/project.yaml where <name> matches ^[a-z0-9][a-z0-9-]{0,62}$.`);
  }
  if (file.status === "renamed" || file.previous_filename !== undefined) {
    problems.push("Renaming a project is not supported. Remove the old project and submit the new one in separate pull requests.");
  } else if (!["added", "modified", "removed"].includes(file.status)) {
    problems.push(`Unsupported change type ${describeValue(file.status, 20)} for ${describeValue(file.filename, 120)}.`);
  }
  if (problems.length > 0 || !name) return { kind: "invalid", problems, ...(name ? { name } : {}) };
  if (file.status === "removed") return { kind: "opt-out", name, path: file.filename };
  return { kind: "submission", name, path: file.filename, status: file.status === "added" ? "added" : "modified" };
}

export interface IntakeArtifact {
  pr_number: number;
  head_sha: string;
}

/**
 * Parses the record the unprivileged intake run hands to the privileged comment run. The record is attacker
 * controllable (a pull request can change the workflow that writes it), so it must be tiny, canonical JSON with
 * exactly two keys, and must name the commit that the workflow_run event reports.
 */
export function parseIntakeArtifact(text: string, expectedSha: string): { artifact?: IntakeArtifact; problems: string[] } {
  if (Buffer.byteLength(text, "utf8") > INTAKE_ARTIFACT_MAX_BYTES) return { problems: [`The intake record is larger than ${INTAKE_ARTIFACT_MAX_BYTES} bytes.`] };
  if (!SHA_PATTERN.test(expectedSha)) return { problems: ["The expected head SHA must be 40 lowercase hex characters."] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problems: ["The intake record is not valid JSON."] };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { problems: ["The intake record must be a JSON object."] };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const problems: string[] = [];
  if (keys.length !== 2 || !keys.includes("pr_number") || !keys.includes("head_sha")) problems.push("The intake record must contain exactly pr_number and head_sha.");
  const prNumber = record.pr_number;
  if (typeof prNumber !== "number" || !Number.isSafeInteger(prNumber) || prNumber <= 0) problems.push("pr_number must be a positive integer.");
  const headSha = record.head_sha;
  if (typeof headSha !== "string" || !SHA_PATTERN.test(headSha)) problems.push("head_sha must be 40 lowercase hex characters.");
  if (problems.length > 0) return { problems };
  const artifact = { pr_number: prNumber as number, head_sha: headSha as string };
  if (JSON.stringify(artifact) !== text.trim()) return { problems: ["The intake record is not in canonical form."] };
  if (artifact.head_sha !== expectedSha) return { problems: ["The intake record names a different commit than the workflow run."] };
  return { artifact, problems: [] };
}

export function serializeIntakeArtifact(artifact: IntakeArtifact): string {
  return JSON.stringify({ pr_number: artifact.pr_number, head_sha: artifact.head_sha });
}

interface PullRequestData {
  number?: unknown;
  state?: unknown;
  changed_files?: unknown;
  user?: { login?: unknown; type?: unknown } | null;
  head?: { sha?: unknown; repo?: { name?: unknown; owner?: { login?: unknown } | null } | null } | null;
  base?: { sha?: unknown } | null;
}

export interface IntakeOptions {
  pr: number;
  /** When set, the pull request head must still be this commit. */
  headSha?: string;
  /** `owner/repo` the consent files must name. */
  registry: string;
  maxOpenPerAuthor?: number;
}

export interface IntakeResult {
  kind: FileClassification["kind"];
  /** Name used for the comment marker. */
  name: string;
  headSha: string;
  author?: string;
  report?: ReviewReport;
  markdown: string;
  exitCode: number;
  artifact?: IntakeArtifact;
}

async function readProjectAt(client: GitHubClient, repo: RepoRef, fallback: RepoRef | undefined, path: string, sha: string) {
  const file = await readCappedFile(client, repo, path, sha, PROJECT_MAX_BYTES);
  if (file.kind !== "missing" || !fallback) return file;
  return readCappedFile(client, fallback, path, sha, PROJECT_MAX_BYTES);
}

/** Counts the author's other open pull requests that change project data. */
async function openSubmissionsBy(client: GitHubClient, repo: RepoRef, author: string, current: number): Promise<number> {
  const pulls = await paginate<PullRequestData>(client, "GET /repos/{owner}/{repo}/pulls", { ...repo, state: "open" }, 3);
  const mine = pulls.filter((pull) => pull.number !== current && typeof pull.user?.login === "string" && sameLogin(pull.user.login, author));
  let count = 0;
  for (const pull of mine.slice(0, MAX_AUTHOR_PULLS_INSPECTED)) {
    const files = await paginate<PullFile>(client, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", { ...repo, pull_number: pull.number }, 1);
    if (files.some((file) => touchesProjects(file.filename) || touchesProjects(file.previous_filename))) count += 1;
  }
  return count;
}

function contactsOf(project: Project): string[] {
  return [project.primaryContact, ...project.autoCcs];
}

function intakeReport(name: string, status: ReviewReport["status"], problems: string[], notes: string[] = []): ReviewReport {
  return {
    schemaVersion: 1,
    project: name,
    status,
    problems,
    notes,
    findings: [],
    redacted: { count: 0, rules: [] },
    summary: { filesAnalyzed: 0, error: 0, warn: 0, info: 0, inventoryComplete: true },
  };
}

const NOTHING_TO_REVIEW = "This pull request does not change any project under projects/, so there is nothing to review.\n";

type PullSnapshot =
  | { ok: true; data: PullRequestData; headSha: string; baseSha: string; classification: FileClassification }
  | { ok: false; result: IntakeResult };

/**
 * Reads a pull request and classifies its changed files, making sure the head did not move while the file list was
 * fetched (the list always describes the current head).
 */
async function snapshotPull(client: GitHubClient, repo: RepoRef, pr: number, expectedHead: string | undefined): Promise<PullSnapshot> {
  const { data } = (await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: pr })) as { data: PullRequestData };
  const headSha = typeof data.head?.sha === "string" ? data.head.sha : "";
  const baseSha = typeof data.base?.sha === "string" ? data.base.sha : "";
  if (!SHA_PATTERN.test(headSha) || !SHA_PATTERN.test(baseSha)) {
    return { ok: false, result: { kind: "invalid", name: "intake", headSha, markdown: "Pull request metadata is incomplete.\n", exitCode: 1 } };
  }
  const stale = (current: string): PullSnapshot => ({
    ok: false,
    result: {
      kind: "invalid",
      name: "intake",
      headSha: current,
      markdown: `Pull request #${pr} moved to ${current.slice(0, 12)} while it was being checked; the newer commit is reviewed by its own run.\n`,
      exitCode: 1,
    },
  });
  if (expectedHead !== undefined && expectedHead !== headSha) return stale(headSha);
  const files = await paginate<PullFile>(client, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files", { ...repo, pull_number: pr }, MAX_FILE_PAGES);
  const { data: again } = (await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repo, pull_number: pr })) as { data: PullRequestData };
  const headAgain = typeof again.head?.sha === "string" ? again.head.sha : "";
  if (headAgain !== headSha) return stale(SHA_PATTERN.test(headAgain) ? headAgain : "unknown");
  const changedFiles = typeof again.changed_files === "number" ? again.changed_files : undefined;
  return { ok: true, data, headSha, baseSha, classification: classifyPullFiles(files, changedFiles) };
}

/**
 * Validates and reviews a submission pull request without checking it out: the PR file list and the project.yaml
 * blob at the exact head commit are fetched through the API and treated purely as data.
 */
export async function runIntake(client: GitHubClient, repo: RepoRef, options: IntakeOptions): Promise<IntakeResult> {
  const snapshot = await snapshotPull(client, repo, options.pr, options.headSha);
  if (!snapshot.ok) return snapshot.result;
  const { data, headSha, baseSha, classification } = snapshot;
  const finish = (kind: IntakeResult["kind"], name: string, report: ReviewReport, extra: { statusText?: string; author?: string } = {}): IntakeResult => {
    const markdown = renderMarkdown(report, extra.statusText ? { statusText: extra.statusText } : {});
    return {
      kind,
      name,
      headSha,
      ...(extra.author ? { author: extra.author } : {}),
      report,
      markdown,
      exitCode: reportExitCode(report),
      ...(SHA_PATTERN.test(headSha) ? { artifact: { pr_number: options.pr, head_sha: headSha } } : {}),
    };
  };
  if (classification.kind === "none") {
    return { kind: "none", name: "intake", headSha, markdown: NOTHING_TO_REVIEW, exitCode: 0, artifact: { pr_number: options.pr, head_sha: headSha } };
  }
  if (classification.kind === "invalid") {
    const name = classification.name ?? "intake";
    return finish("invalid", name, intakeReport(name, "invalid", classification.problems));
  }
  const { name, path } = classification;
  const author = typeof data.user?.login === "string" ? data.user.login : "";
  const notes = data.state === "open" ? [] : [`Pull request #${options.pr} is not open.`];
  if (!isLogin(author) || data.user?.type !== "User") {
    return finish(classification.kind, name, intakeReport(name, "invalid", ["Submissions must be opened by a GitHub user account listed in the project's consent file."], notes));
  }
  const headRepo = data.head?.repo;
  const fallback =
    typeof headRepo?.owner?.login === "string" && typeof headRepo.name === "string" ? { owner: headRepo.owner.login, repo: headRepo.name } : undefined;

  const baseFile = await readCappedFile(client, repo, path, baseSha, PROJECT_MAX_BYTES);
  const existing = baseFile.kind === "file" ? parseProjectText(baseFile.text, name).project : undefined;
  if (baseFile.kind !== "missing" && !existing) {
    // Without a valid base copy there is no trustworthy contact list or repository_id to check this change against.
    return finish(classification.kind, name, intakeReport(name, "invalid", [
      `The existing ${path} on the base branch could not be validated, so this change cannot be checked automatically. A registry maintainer must review it manually.`,
    ], notes), { author });
  }
  if (classification.kind === "opt-out") {
    if (existing && !contactsOf(existing).some((contact) => sameLogin(contact, author))) {
      return finish("opt-out", name, intakeReport(name, "invalid", [
        `Only the project's primary_contact or auto_ccs may remove it. Maintainers can also opt out at any time by deleting .github/ci-cd-optimizer-review.yml from their repository.`,
      ], notes), { author });
    }
    return finish("opt-out", name, intakeReport(name, "ok", [], [...notes, `This pull request removes ${path}, which opts the project out of reviews once merged.`]), {
      statusText: "Opt-out request",
      author,
    });
  }

  const others = await openSubmissionsBy(client, repo, author, options.pr);
  const limit = options.maxOpenPerAuthor ?? MAX_OPEN_SUBMISSIONS_PER_AUTHOR;
  if (others >= limit) {
    return finish("submission", name, intakeReport(name, "invalid", [`${describeValue(author)} already has ${others} other open submission pull requests; the limit is ${limit}. Close or finish those first.`], notes), { author });
  }

  let file;
  try {
    file = await readProjectAt(client, repo, fallback, path, headSha);
  } catch (error) {
    const status = httpStatus(error);
    if (status === undefined) throw error;
    file = { kind: "rejected" as const, reason: `${path} could not be read at the pull request head (HTTP ${status}).` };
  }
  if (file.kind !== "file") {
    const reason = file.kind === "missing" ? `${path} was not found at the pull request head.` : file.reason;
    return finish("submission", name, intakeReport(name, "invalid", [reason], notes), { author });
  }
  const parsed = parseProjectText(file.text, name);
  if (!parsed.project) return finish("submission", name, intakeReport(name, "invalid", parsed.problems, notes), { author });
  const project = parsed.project;
  if (existing) {
    const problems: string[] = [];
    if (existing.repositoryId !== project.repositoryId) problems.push("repository_id is immutable. Remove the project and submit a new one to point it at a different repository.");
    if (!contactsOf(existing).some((contact) => sameLogin(contact, author))) problems.push("Only the project's current primary_contact or auto_ccs may change an existing project.");
    if (problems.length > 0) return finish("submission", name, intakeReport(name, "invalid", problems, notes), { author });
  }

  const outcome = await reviewProject(client, project, { registry: options.registry, author });
  outcome.notes.unshift(...notes);
  return finish("submission", name, buildReport(outcome, { public: true }), { author });
}

/** Commit status the trusted workflow_run job publishes; branch protection requires it instead of the pull_request job. */
export const TRUSTED_STATUS_CONTEXT = "review-intake/trusted";
const MAX_OPEN_PULL_PAGES = 10;
const STATUS_DESCRIPTION_MAX = 140;

/** What the trusted job found when it looked for the record left by the unprivileged intake run. */
export type IntakeRecordState = "present" | "missing" | "invalid";

export interface TrustedIntakeOptions {
  /** The commit the workflow_run event reports; every pull request evaluated must still point at it. */
  headSha: string;
  /** Pull request named by a validated intake record. */
  pr?: number;
  record: IntakeRecordState;
  registry: string;
}

export interface TrustedIntakeEntry {
  pr: number;
  result: IntakeResult;
}

/** Open pull requests whose head is `sha`. Commit statuses are per commit, so all of them share the trusted result. */
async function openPullsAt(client: GitHubClient, repo: RepoRef, sha: string): Promise<number[]> {
  const pulls = await paginate<PullRequestData>(client, "GET /repos/{owner}/{repo}/pulls", { ...repo, state: "open" }, MAX_OPEN_PULL_PAGES);
  return pulls
    .filter((pull) => pull.head?.sha === sha)
    .map((pull) => pull.number)
    .filter((number): number is number => typeof number === "number" && Number.isSafeInteger(number) && number > 0);
}

/** Intake for a pull request whose unprivileged run left no usable record: anything touching projects/ fails closed. */
async function unrecordedIntake(client: GitHubClient, repo: RepoRef, pr: number, headSha: string, record: "missing" | "invalid"): Promise<IntakeResult> {
  const snapshot = await snapshotPull(client, repo, pr, headSha);
  if (!snapshot.ok) return snapshot.result;
  const { classification } = snapshot;
  if (classification.kind === "none") return { kind: "none", name: "intake", headSha, markdown: NOTHING_TO_REVIEW, exitCode: 0 };
  const name = classification.name ?? "intake";
  const problem =
    record === "missing"
      ? "The Review intake run for this commit left no intake record, so the submission could not be verified."
      : "The Review intake run for this commit left an invalid intake record, so the submission could not be verified.";
  const report = intakeReport(name, "invalid", [
    `${problem} A registry maintainer must re-run Review intake. Pull requests that change the intake workflow cannot be accepted as submissions.`,
  ]);
  return { kind: classification.kind, name, headSha, report, markdown: renderMarkdown(report), exitCode: 1 };
}

/**
 * Re-runs intake from trusted code for every open pull request at `headSha`, plus the one a valid record names. The
 * unprivileged run only decides which path is taken; it can never make a submission pass.
 */
export async function runTrustedIntake(client: GitHubClient, repo: RepoRef, options: TrustedIntakeOptions): Promise<TrustedIntakeEntry[]> {
  if (!SHA_PATTERN.test(options.headSha)) throw new Error("The head SHA must be 40 lowercase hex characters.");
  const candidates = new Set(await openPullsAt(client, repo, options.headSha));
  if (options.record === "present" && options.pr !== undefined) candidates.add(options.pr);
  const entries: TrustedIntakeEntry[] = [];
  for (const pr of [...candidates].sort((a, b) => a - b)) {
    const result =
      options.record === "present"
        ? await runIntake(client, repo, { pr, headSha: options.headSha, registry: options.registry })
        : await unrecordedIntake(client, repo, pr, options.headSha, options.record);
    entries.push({ pr, result });
  }
  return entries;
}

export interface IntakeCommitStatus {
  state: "success" | "failure";
  description: string;
}

function failureReason(result: IntakeResult): string {
  switch (result.report?.status) {
    case "invalid":
      return "submission is invalid; see the review comment.";
    case "consent-failed":
      return "consent could not be verified; see the review comment.";
    case "error":
      return "the review failed; see the review comment.";
    case undefined:
      return "the pull request moved to a newer commit or has incomplete metadata.";
    default:
      return "intake failed.";
  }
}

/** Decides the trusted commit status: every pull request at the commit must pass, and at least one must exist. */
export function intakeCommitStatus(entries: readonly TrustedIntakeEntry[]): IntakeCommitStatus {
  const status = (state: IntakeCommitStatus["state"], description: string): IntakeCommitStatus => ({ state, description: description.slice(0, STATUS_DESCRIPTION_MAX) });
  if (entries.length === 0) return status("failure", "No open pull request points at this commit.");
  const failed = entries.filter((entry) => entry.result.exitCode !== 0);
  const [first] = failed;
  if (failed.length > 1) return status("failure", `${failed.length} pull requests at this commit failed intake.`);
  if (first) return status("failure", `#${first.pr}: ${failureReason(first.result)}`);
  if (entries.every((entry) => entry.result.kind === "none")) return status("success", "No project changes to review.");
  return status("success", "Intake checks passed.");
}
