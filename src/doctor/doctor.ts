import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { isMap, parseDocument, visit } from "yaml";
import { z } from "zod";
import { escapeMarkdown } from "../agents/safety.js";
import type { GitHubClient, RepoRef } from "../github/client.js";
import { readFileAt } from "../github/git.js";
import { parseYaml } from "../lint/parsers/yaml.js";
import { fetchJobLog } from "../telemetry/logs.js";
import { listRunJobs } from "../telemetry/snapshot.js";

const integer = z.number().int().positive().safe();
const conclusion = z.enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "startup_failure", "stale"]).nullable();
const runSchema = z.object({
  id: integer, run_attempt: integer, head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.string().max(512), status: z.enum(["completed", "in_progress", "queued", "requested", "waiting", "pending"]).nullable(),
  conclusion, check_suite_id: integer.optional(),
});
const jobSchema = z.object({
  id: integer, run_id: integer, run_attempt: integer, head_sha: z.string(),
  conclusion, status: z.literal("completed"),
  steps: z.array(z.object({ number: integer, conclusion })).max(1000).optional(),
});
type Run = z.infer<typeof runSchema>;
type Diagnosis = "yaml-tab-indentation" | "generated-proof-drift" | "generated-output-drift" | "lockfile-drift" | "test-failure" | "lint-or-typecheck" | "unknown";
export interface DoctorReport {
  schema: "cicd-optimizer/doctor-v1";
  repository: string;
  mode: "observe" | "repair";
  status: "unrepaired" | "repaired-locally" | "no-failed-run" | "collection-failed";
  run?: Run;
  /** Stable suggestion identity; no issue is filed automatically. */
  issueKey?: string;
  jobs: { id: number; conclusion: string | null; failedSteps: number[]; diagnosis: Diagnosis; log: "complete" | "missing" | "truncated" | "redacted" | "not-collected" }[];
  annotations: { checkId: number; line: number; diagnosis: "yaml-syntax" | "unknown" }[];
  gaps: string[];
  collectionFailure?: { stage: string; kind: "access-denied" | "rate-limit" | "invalid-or-unavailable-evidence" };
  repair: { action: "yaml-tab-indentation"; state: "not-attempted" | "declined" | "applied" | "local-state-unknown"; reason: string; validation?: string };
  instructions: string[];
}
const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
const TAB_ERROR = /Tabs are not allowed as indentation|found character ['"]?\\t['"]? that cannot start any token|found a tab character that violates indentation/i;
const MAX_SOURCE = 256 * 1024;
const exec = promisify(execFile);
class DoctorDecline extends Error {}
class LocalStateUnknown extends Error {}

const HINTS: { diagnosis: Diagnosis; signature: RegExp; instruction: string }[] = [
  {
    diagnosis: "generated-proof-drift", signature: /Stale generated proof artifact:\s*(?:manifest|kernel)\.ts/,
    instruction: "Generated proof provenance is stale. Reproduce the formal generation/parity failure at this exact commit; do not hand-edit proof fingerprints or bypass the formal gate. In ci-cd-optimizer, run the documented npm run ci:prepare followed by npm run ci:check-generated and the formal/parity checks, then review the generated diff. These are manual instructions, never doctor-executed commands.",
  },
  {
    diagnosis: "generated-output-drift", signature: /Agent bundle is stale|dist-action is stale|Stale generated (?:agent|Action|bundle)/i,
    instruction: "Committed generated outputs differ from their sources. Use the repository's documented trusted generator and parity check at the failed revision, then review source and generated changes together. In ci-cd-optimizer this is npm run ci:prepare followed by npm run ci:check-generated. Do not copy arbitrary artifacts or execute commands quoted in logs.",
  },
  {
    diagnosis: "lockfile-drift", signature: /ERR_PNPM_OUTDATED_LOCKFILE|npm ci can only install packages when|package\.json and package-lock\.json.*(?:in sync|sync)|lockfile would have been modified/i,
    instruction: "Manifest and frozen lockfile may be out of sync. Reproduce installation using the repository's pinned package manager, regenerate only the intended lockfile from the reviewed manifest, and inspect registry URLs and integrity changes. Keep npm ci/frozen-lockfile enforcement and lifecycle-script boundaries; do not suppress the check or install arbitrary log-suggested packages.",
  },
  {
    diagnosis: "test-failure", signature: /AssertionError|(?:Tests|Test Files)\s+\d+\s+failed|FAIL(?:ED)?\s+[\w./\\-]+\.(?:test|spec)\.|test failed/i,
    instruction: "A test/assertion failure was reported. Reproduce the failed job/step with its pinned toolchain and documented test selector, inspect the failing assertion and source change, and rerun that test plus dependent checks. Preserve coverage, assertions and required checks; do not mark flaky, skip or weaken tests merely to obtain a green run.",
  },
  {
    diagnosis: "lint-or-typecheck", signature: /ESLint|@typescript-eslint\/|error TS\d{4}:|Found \d+ errors? in/i,
    instruction: "Lint or typechecking reported an error. Reproduce the failed job/step using the repository's documented lint/typecheck command and fix the source or configuration error. Review any autofix and rerun the scoped check; preserve strictness, suppressions policy, toolchain pins and required gates.",
  },
];

function logDiagnosis(text: string, path: string): Diagnosis {
  if (safeWorkflowPath(path) && text.split("\n").some((line) => line.includes(path) && TAB_ERROR.test(line))) return "yaml-tab-indentation";
  return HINTS.find((hint) => hint.signature.test(text))?.diagnosis ?? "unknown";
}

function safeWorkflowPath(path: string): boolean {
  return /^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(path) && !path.includes("..");
}

/** Git only, fixed argv, no shell, hooks, external diff, or repository scripts. */
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 15_000, windowsHide: true,
  });
  return result.stdout.trimEnd();
}

async function selectedRun(client: GitHubClient, repo: RepoRef, id: number, attempt?: number): Promise<Run> {
  const route = attempt === undefined ? "GET /repos/{owner}/{repo}/actions/runs/{run_id}"
    : "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}";
  const parsed = runSchema.safeParse((await client.request(route, {
    ...repo, run_id: id, ...(attempt === undefined ? {} : { attempt_number: attempt }),
  })).data);
  if (!parsed.success || parsed.data.id !== id || (attempt !== undefined && parsed.data.run_attempt !== attempt)) {
    throw new Error("Run/attempt response has invalid or mismatched identity.");
  }
  return parsed.data;
}

function sameRun(a: Run, b: Run): boolean {
  return a.id === b.id && a.run_attempt === b.run_attempt && a.head_sha === b.head_sha &&
    a.path === b.path && a.status === b.status && a.conclusion === b.conclusion && a.check_suite_id === b.check_suite_id;
}

async function latestFailure(client: GitHubClient, repo: RepoRef, workflow?: string): Promise<number | undefined> {
  const route = workflow ? "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs" : "GET /repos/{owner}/{repo}/actions/runs";
  const seen = new Set<number>();
  let total: number | undefined;
  for (let page = 1; page <= 5; page++) {
    const data = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(runSchema).max(100) }).parse(
      (await client.request(route, { ...repo, status: "completed", per_page: 100, page,
        ...(workflow ? { workflow_id: workflow } : {}) })).data,
    );
    if (total !== undefined && total !== data.total_count) throw new Error("Run list changed during pagination.");
    total = data.total_count;
    for (const run of data.workflow_runs) {
      if (seen.has(run.id) || run.status !== "completed") throw new Error("Run listing is inconsistent.");
      seen.add(run.id);
      if (FAILED.has(run.conclusion ?? "")) return run.id;
    }
    if (seen.size === total) return undefined;
    if (data.workflow_runs.length < 100 || seen.size > total) throw new Error("Incomplete run listing.");
  }
  throw new Error("Latest failure search exceeded the 500-run budget. Select --run-id.");
}

async function startupAnnotations(client: GitHubClient, repo: RepoRef, run: Run): Promise<DoctorReport["annotations"]> {
  if (!run.check_suite_id || !safeWorkflowPath(run.path)) return [];
  // Check-suite annotations do not carry attempt numbers; never attribute rerun annotations to an older attempt.
  if (run.run_attempt !== 1 || !sameRun(run, await selectedRun(client, repo, run.id))) return [];
  const checks: number[] = [];
  const seen = new Set<number>();
  let total: number | undefined;
  for (let page = 1; page <= 5; page++) {
    const data = z.object({
      total_count: z.number().int().nonnegative(),
      check_runs: z.array(z.object({
        id: integer, head_sha: z.string(), check_suite: z.object({ id: integer }),
        app: z.object({ slug: z.string() }), status: z.string(), conclusion,
      })).max(100),
    }).parse((await client.request("GET /repos/{owner}/{repo}/check-suites/{check_suite_id}/check-runs", {
      ...repo, check_suite_id: run.check_suite_id, filter: "all", per_page: 100, page,
    })).data);
    if (total !== undefined && total !== data.total_count) throw new Error("Check list changed.");
    total = data.total_count;
    for (const check of data.check_runs) {
      if (seen.has(check.id)) throw new Error("Duplicate check identity.");
      seen.add(check.id);
      if (check.head_sha !== run.head_sha || check.check_suite.id !== run.check_suite_id ||
        check.app.slug !== "github-actions" || check.status !== "completed") throw new Error("Check identity is inconsistent.");
      if (FAILED.has(check.conclusion ?? "")) checks.push(check.id);
    }
    if (data.check_runs.length < 100) {
      if ((page - 1) * 100 + data.check_runs.length !== total) throw new Error("Incomplete check listing.");
      break;
    }
    if (page * 100 === total) break;
    if (page === 5) throw new Error("Check list exceeds the collection budget.");
  }
  if (new Set(checks).size !== checks.length || checks.length > 5) throw new Error("Ambiguous or oversized failed check list.");
  const result: DoctorReport["annotations"] = [];
  for (const id of checks) {
    for (let page = 1; page <= 5; page++) {
      const annotations = z.array(z.object({
        path: z.string().max(512), start_line: integer,
        annotation_level: z.enum(["notice", "warning", "failure"]), message: z.string().max(64 * 1024),
      })).max(100).parse((await client.request("GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations", {
        ...repo, check_run_id: id, per_page: 100, page,
      })).data);
      for (const annotation of annotations.filter((item) => item.annotation_level === "failure")) {
        result.push({
          checkId: id, line: annotation.start_line,
          diagnosis: annotation.path === run.path && (TAB_ERROR.test(annotation.message) || /error in your yaml syntax/i.test(annotation.message))
            ? "yaml-syntax" : "unknown",
        });
      }
      if (annotations.length < 100) break;
      if (page === 5) throw new Error("Annotations exceed the collection budget.");
    }
  }
  if (!sameRun(run, await selectedRun(client, repo, run.id))) throw new Error("Run was retried while collecting annotations.");
  return result;
}

/** Only indentation is changed; scalar scripts, aliases and multiline values are deliberately unsupported. */
export function tabIndentRepair(source: string): string | undefined {
  if (Buffer.byteLength(source) > MAX_SOURCE) return undefined;
  const before = parseDocument(source);
  if (!before.errors.some((error) => error.code === "TAB_AS_INDENT") ||
    /[|>][+-]?\d?[+-]?(?:\s+#.*)?\s*$/m.test(source) || /[&*]|^\s*<<:/m.test(source)) return undefined;
  // A uniform tab-only hierarchy avoids guessing the width of mixed space/tab indentation.
  if (source.split(/\r?\n/).some((line) => /^ +\S|^[ \t]* [ \t]*\t|^\t+ +\S/.test(line))) return undefined;
  const candidate = source.replace(/^[ \t]*\t[ \t]*(?=\S)/gm, (indent) => indent.replace(/\t/g, "  "));
  if (candidate === source) return undefined;
  const after = parseDocument(candidate);
  const lint = parseYaml(".github/workflows/doctor.yml", candidate);
  if (after.errors.length || after.warnings.length || lint.doc.errors.length ||
    !isMap(after.contents) || !isMap(after.get("jobs", true)) || !after.has("on")) return undefined;
  let multiline = false;
  visit(after, { Scalar(_key, node) {
    if (node.range && /[\r\n]/.test(candidate.slice(node.range[0], node.range[1]))) multiline = true;
  } });
  if (multiline) return undefined;
  const step = z.object({
    id: z.unknown().optional(), if: z.unknown().optional(), name: z.unknown().optional(),
    uses: z.string().optional(), run: z.string().optional(), "working-directory": z.unknown().optional(),
    shell: z.unknown().optional(), with: z.unknown().optional(), env: z.unknown().optional(),
    "continue-on-error": z.unknown().optional(), "timeout-minutes": z.unknown().optional(),
  }).strict().refine((value) => (value.uses !== undefined) !== (value.run !== undefined));
  const job = z.object({
    name: z.unknown().optional(), "runs-on": z.unknown().optional(), needs: z.unknown().optional(),
    if: z.unknown().optional(), permissions: z.unknown().optional(), environment: z.unknown().optional(),
    concurrency: z.unknown().optional(), outputs: z.unknown().optional(), env: z.unknown().optional(),
    defaults: z.unknown().optional(), steps: z.array(step).min(1).optional(),
    "timeout-minutes": z.unknown().optional(), "continue-on-error": z.unknown().optional(),
    strategy: z.unknown().optional(), container: z.unknown().optional(), services: z.unknown().optional(),
    uses: z.string().optional(), with: z.unknown().optional(), secrets: z.unknown().optional(),
  }).strict().refine((value) => value.uses !== undefined ? value.steps === undefined : value.steps !== undefined && value["runs-on"] !== undefined);
  const jobs = after.get("jobs", true);
  if (!isMap(jobs) || !z.record(z.string(), job).safeParse(jobs.toJSON()).success) return undefined;
  // Changing indentation must not admit nested scripts with multiline string continuations.
  if (source.split(/\r?\n/).some((line) => /^[ \t]*\t/.test(line) &&
    !/^[ \t]*(?:[A-Za-z_][\w-]*:|-\s+(?:name|run|uses|if|env|with):)/.test(line))) return undefined;
  return candidate;
}

async function checkoutGuard(cwd: string, repo: RepoRef, run: Run, apiHost: string): Promise<string> {
  const root = await realpath(cwd);
  if (resolve(await git(root, ["rev-parse", "--show-toplevel"])).toLowerCase() !== root.toLowerCase()) {
    throw new DoctorDecline("Repair requires the repository root, not a subdirectory.");
  }
  if (await git(root, ["rev-parse", "HEAD"]) !== run.head_sha) throw new DoctorDecline("Checkout HEAD does not match the failed run.");
  if (await git(root, ["status", "--porcelain", "--untracked-files=all"])) throw new DoctorDecline("Checkout is dirty; no files were overwritten.");
  const remote = await git(root, ["remote", "get-url", "origin"]);
  const normalized = remote.replace(/^git@([^:]+):/, "https://$1/");
  let url: URL;
  try { url = new URL(normalized); } catch { throw new DoctorDecline("Origin is not a supported GitHub URL."); }
  if (!["https:", "ssh:"].includes(url.protocol) || url.hostname.toLowerCase() !== apiHost.toLowerCase() ||
    url.pathname.replace(/^\//, "").replace(/\.git$/, "").toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()) {
    throw new DoctorDecline("Checkout origin does not match the selected GitHub repository.");
  }
  let path = root;
  for (const part of run.path.split("/")) {
    path = join(path, part);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new DoctorDecline("Workflow path contains a symlink; repair declined.");
  }
  const mode = await git(root, ["ls-files", "--stage", "--", run.path]);
  if (!/^100644 [a-f0-9]+ 0\t/.test(mode)) throw new DoctorDecline("Workflow must be a tracked regular non-executable file.");
  return path;
}

async function repair(client: GitHubClient, repo: RepoRef, run: Run, cwd: string, apiHost: string): Promise<string> {
  if (!safeWorkflowPath(run.path)) throw new DoctorDecline("External or unsafe workflow path; no repair attempted.");
  const path = await checkoutGuard(cwd, repo, run, apiHost);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SOURCE) throw new DoctorDecline("Workflow is oversized, hard-linked, or not a regular file.");
  const file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  let mutationStarted = false;
  try {
    const opened = await file.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new DoctorDecline("Workflow changed while opening; repair declined.");
    const raw = await file.readFile();
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    const upstream = await readFileAt(client, repo, run.path, run.head_sha);
    if (upstream !== source) throw new DoctorDecline("Local workflow differs from the exact failed revision.");
    const candidate = tabIndentRepair(source);
    if (!candidate) throw new DoctorDecline("No unambiguous YAML-only tab repair validates; review indentation manually.");
    if (!sameRun(run, await selectedRun(client, repo, run.id))) throw new DoctorDecline("Run changed or was rerun during diagnosis; repair declined.");
    await checkoutGuard(cwd, repo, run, apiHost);
    const current = await lstat(path);
    const bytes = Buffer.alloc(Buffer.byteLength(source) + 1);
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (current.ino !== opened.ino || current.dev !== opened.dev || bytes.subarray(0, read.bytesRead).toString("utf8") !== source) {
      throw new DoctorDecline("Workflow changed before writing; no repair applied.");
    }
    const content = Buffer.from(candidate);
    let offset = 0;
    mutationStarted = true;
    while (offset < content.length) {
      const written = await file.write(content, offset, content.length - offset, offset);
      if (!written.bytesWritten) throw new Error("Workflow write made no progress; inspect local changes.");
      offset += written.bytesWritten;
    }
    await file.truncate(content.length);
    await file.sync();
    const final = await lstat(path);
    const result = Buffer.alloc(content.length + 1);
    const actual = await file.read(result, 0, result.length, 0);
    if (final.ino !== opened.ino || final.dev !== opened.dev || actual.bytesRead !== content.length ||
      !result.subarray(0, actual.bytesRead).equals(content) || parseYaml(run.path, candidate).doc.errors.length ||
      await git(cwd, ["rev-parse", "HEAD"]) !== run.head_sha) {
      throw new Error("Post-write validation failed; inspect local changes. No remote action was taken.");
    }
    return "Strict YAML parse and repository workflow parser passed after rereading the exact repaired bytes; full CI has not run.";
  } catch (error) {
    if (mutationStarted) throw new LocalStateUnknown("Local write or post-write validation failed; checkout may be modified. Inspect git diff before proceeding. No remote action was taken.");
    throw error;
  } finally { await closeWorkflow(file, mutationStarted); }
}

async function closeWorkflow(file: FileHandle, mutationStarted: boolean): Promise<void> {
  try { await file.close(); } catch {
    if (mutationStarted) throw new LocalStateUnknown("Closing the repaired file failed; inspect local changes and filesystem health.");
    throw new DoctorDecline("Closing the workflow failed; repair was not applied.");
  }
}

export async function diagnoseWorkflow(client: GitHubClient, repo: RepoRef, options: {
  cwd: string; observe: boolean; runId?: number; attempt?: number; workflow?: string; apiHost?: string;
}): Promise<DoctorReport> {
  const report: DoctorReport = {
    schema: "cicd-optimizer/doctor-v1", repository: `${repo.owner}/${repo.repo}`, mode: options.observe ? "observe" : "repair",
    status: "unrepaired", jobs: [], annotations: [], gaps: [],
    repair: { action: "yaml-tab-indentation", state: "not-attempted", reason: "No supported evidence-backed repair identified." },
    instructions: [
      "This is a historical failed attempt, not a claim about current branch health; check for superseding successful runs before filing an issue.",
      "Review the exact run attempt and failed step numbers below. Missing logs are not proof of a clean workflow.",
      "Repair the root cause without disabling tests, assertions, required checks, permissions boundaries, toolchain pins or formal/parity gates.",
      "Validate the resulting diff with the repository's documented scoped checks; commit/push/rerun only with separate authorization.",
      "Before filing an issue, search for the stable issueKey below to avoid duplicate reports. Doctor never files issues.",
    ],
  };
  let stage = "run-selection";
  try {
    let id = options.runId;
    if (id === undefined) {
      id = await latestFailure(client, repo, options.workflow);
      if (id === undefined) {
        report.status = "no-failed-run";
        report.instructions = ["GitHub returned no matching failed runs; this is not an attestation that queued, cancelled, or other workflows are healthy."];
        return report;
      }
    }
    const run = await selectedRun(client, repo, id, options.attempt);
    report.run = { ...run, path: safeWorkflowPath(run.path) ? run.path : "[unsupported workflow path]" };
    report.issueKey = `doctor:${repo.owner}/${repo.repo}:${run.id}:${run.run_attempt}`;
    if (run.status !== "completed" || !FAILED.has(run.conclusion ?? "")) {
      report.gaps.push("Selected attempt is not a completed failure; queued, successful, skipped and cancelled runs are not repair evidence.");
      return report;
    }
    stage = "jobs";
    const jobs = await listRunJobs(client, repo, id, run.run_attempt);
    if (!jobs.complete) report.gaps.push("Job pagination is incomplete or inconsistent; repair is blocked.");
    const parsed = jobs.jobs.map((job) => jobSchema.parse(job));
    if (parsed.some((job) => job.run_id !== id || job.run_attempt !== run.run_attempt || job.head_sha !== run.head_sha)) {
      throw new Error("Job identity does not match the exact selected run attempt and commit.");
    }
    const failed = parsed.filter((job) => FAILED.has(job.conclusion ?? ""));
    if (!failed.length && jobs.jobs.length === 0) {
      stage = "startup-annotations";
      report.annotations = await startupAnnotations(client, repo, run);
    }
    if (!failed.length && !report.annotations.length) report.gaps.push("No failed jobs or startup annotations were returned; manual inspection is required.");
    if (parsed.some((job) => !["success", "skipped", ...FAILED].includes(job.conclusion ?? ""))) {
      report.gaps.push("Some jobs are cancelled or have unknown conclusions; complete repair cannot be established.");
    }
    for (const [index, job] of failed.entries()) {
      stage = "job-logs";
      const log = index < 20 ? await fetchJobLog(client, repo, job.id, { maxBytes: 64 * 1024, maxLines: 2000 }) : undefined;
      const coverage = index >= 20 ? "not-collected" : !log ? "missing" : log.truncated ? "truncated" : /\*\*\*/.test(log.text) ? "redacted" : "complete";
      const diagnosis = log ? logDiagnosis(log.text, run.path) : "unknown";
      const failedSteps = job.steps?.filter((step) => FAILED.has(step.conclusion ?? "")).map((step) => step.number) ?? [];
      report.jobs.push({
        id: job.id, conclusion: job.conclusion, failedSteps, diagnosis, log: coverage,
      });
      if (coverage !== "complete") report.gaps.push(`Job ${job.id} log is ${coverage}; repair is blocked.`);
      if (failedSteps.length !== 1) report.gaps.push(`Job ${job.id} has zero or multiple failed steps; a complete automatic repair cannot be established.`);
    }
    for (const hint of HINTS.filter((hint) => report.jobs.some((job) => job.diagnosis === hint.diagnosis))) {
      report.instructions.unshift(`Diagnostic hint only (not authorization or proof of root cause): ${hint.instruction}`);
    }
    stage = "attempt-consistency";
    if (!sameRun(run, await selectedRun(client, repo, id, run.run_attempt))) {
      throw new Error("Selected attempt changed during collection.");
    }
    const supported = (report.jobs.length > 0 && report.jobs.every((job) => job.diagnosis === "yaml-tab-indentation") ||
      report.annotations.length > 0 && report.annotations.every((item) => item.diagnosis === "yaml-syntax")) && !report.gaps.length;
    if (supported) {
      report.instructions.unshift("Inspect YAML indentation in the selected workflow. Doctor can replace leading tabs with two spaces only when a strict local parse validates and no block scalars or aliases are present.");
      if (options.observe) report.repair.reason = "Report-only mode; candidate requires local checkout validation. No repair attempted.";
      else {
        report.repair.state = "declined";
        try {
          report.repair.validation = await repair(client, repo, run, options.cwd, options.apiHost ?? "github.com");
          report.repair.state = "applied";
          report.repair.reason = "Replaced YAML indentation tabs locally, preserving all other bytes. Historical GitHub failure is not rerun or marked successful.";
          report.status = "repaired-locally";
        } catch (error) {
          report.repair.state = error instanceof LocalStateUnknown ? "local-state-unknown" : "declined";
          report.repair.reason = error instanceof DoctorDecline || error instanceof LocalStateUnknown ? error.message : "Local repair/validation failed; inspect checkout and API access. No remote action was taken.";
        }
      }
    }
    return report;
  } catch (error) {
    report.status = "collection-failed";
    const status = (error as { status?: unknown } | null)?.status;
    report.collectionFailure = { stage, kind: status === 401 || status === 403 ? "access-denied" : status === 429 ? "rate-limit" : "invalid-or-unavailable-evidence" };
    report.gaps.push("Evidence collection failed (API/auth/rate limit, malformed data or inconsistent identity). No clean result or repair is claimed. Check GitHub access and retry the exact attempt.");
    return report;
  }
}

export function doctorMarkdown(report: DoctorReport): string {
  const escape = (text: string) => escapeMarkdown(text);
  return [
    "# Workflow doctor", "", `Status: **${report.status}** (${report.mode}).`,
    `Repository: ${escape(report.repository)}`,
    ...(report.run ? [`Run: ${report.run.id}; attempt: ${report.run.run_attempt}; commit: ${report.run.head_sha}.`,
      `Workflow: ${safeWorkflowPath(report.run.path) ? escape(report.run.path) : "[external or unsafe path withheld]"}.`] : []),
    ...(report.issueKey ? [`Issue key: ${escape(report.issueKey)}`] : []),
    "", "## Evidence",
    ...report.jobs.map((job) => `- Job ${job.id}; failed steps: ${job.failedSteps.join(", ") || "unavailable"}; log: ${job.log}; diagnosis: ${job.diagnosis}.`),
    ...report.annotations.map((annotation) => `- Startup check ${annotation.checkId}; line ${annotation.line}; diagnosis: ${annotation.diagnosis}.`),
    ...report.gaps.map((gap) => `- ${escape(gap)}`),
    "", "## Local remediation", `${report.repair.state}: ${escape(report.repair.reason)}`,
    ...(report.repair.validation ? [escape(report.repair.validation)] : []),
    "", "## Repair instructions", ...report.instructions.map((instruction) => `- ${escape(instruction)}`),
    "", "Raw logs and untrusted commands are intentionally omitted. No issue, push, remote rerun or model call was made.",
  ].join("\n");
}
