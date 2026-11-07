import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_REGISTRY } from "../review/consent.js";
import { escapeInline } from "../review/escape.js";
import { INTAKE_ARTIFACT_MAX_BYTES, parseIntakeArtifact, runIntake, serializeIntakeArtifact } from "../review/intake.js";
import { NAME_PATTERN, PROJECT_FILE, PROJECT_MAX_BYTES, parseProjectText } from "../review/project.js";
import { buildReport, renderJson, renderMarkdown, reportExitCode, upsertReviewComment, type ReviewReport } from "../review/report.js";
import { reviewProject } from "../review/review.js";
import { githubClient, repoFrom, resolvePath, UsageError, writeText, type CliIO } from "./io.js";

export const REVIEW_HELP = `Usage: ci-cd-optimizer review <command> [options]

The project review program (see docs/review-program/README.md): repositories registered under
projects/<name>/project.yaml are linted through the GitHub API after their maintainers consent.

Commands:
  validate <file...>        Validate project.yaml files offline (schema and directory name)
  run <project.yaml>        Review one project: verify consent, lint its default branch, print the report
  intake --pr <n>           Check a submission pull request and review the project it adds or changes
  intake-artifact <file>    Validate the intake record handed from the intake run to the comment run
  scheduled                 Re-review every registered project (public mode) and print a summary

run:              [--public] [--format markdown|json] [--author <login>] [--registry <owner/repo>] [--output <file>]
intake:           --pr <n> [--repo <owner/repo>] [--head-sha <sha>] [--comment] [--artifact <file>] [--output <file>]
intake-artifact:  <file> --expected-sha <sha>     (prints pr_number=… and head_sha=… lines for $GITHUB_OUTPUT)
scheduled:        [--dir projects] [--registry <owner/repo>] [--output <file>]

Without --public, run prints every finding, including security-sensitive ones that public reports withhold.
The registry defaults to $GITHUB_REPOSITORY, then ${DEFAULT_REGISTRY}.
`;

const SHA = /^[0-9a-f]{40}$/;
const SCHEDULED_MAX_BYTES = 900 * 1024;
const SCHEDULED_PROJECT_MAX_BYTES = 30 * 1024;

function registryFrom(value: string | undefined, io: CliIO): string {
  const registry = value ?? io.env.GITHUB_REPOSITORY ?? DEFAULT_REGISTRY;
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(registry)) throw new UsageError(`Invalid registry "${registry}". Use owner/repo.`);
  return registry;
}

async function readProjectFile(io: CliIO, path: string): Promise<{ text: string; directory: string }> {
  if (basename(path) !== PROJECT_FILE) throw new UsageError(`${path}: project files must be named ${PROJECT_FILE}.`);
  const target = resolvePath(io, path);
  let size: number;
  try {
    const info = await lstat(target);
    if (!info.isFile()) throw new UsageError(`${path}: not a regular file.`);
    size = info.size;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Cannot read ${path}: ${(error as Error).message}`);
  }
  const directory = basename(dirname(target));
  // Oversized files are reported by the parser without reading them whole.
  if (size > PROJECT_MAX_BYTES) return { text: "x".repeat(PROJECT_MAX_BYTES + 1), directory };
  return { text: await readFile(target, "utf8"), directory };
}

async function validateCommand(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { help: { type: "boolean", short: "h", default: false } } });
  if (values.help) {
    io.stdout(REVIEW_HELP);
    return 0;
  }
  if (positionals.length === 0) throw new UsageError("review validate needs at least one project.yaml file.");
  let failed = false;
  for (const path of positionals) {
    const { text, directory } = await readProjectFile(io, path);
    const parsed = parseProjectText(text, directory);
    if (parsed.project) {
      io.stdout(`${path}: ok`);
    } else {
      failed = true;
      io.stdout(`${path}: invalid`);
      for (const problem of parsed.problems) io.stdout(`  - ${problem}`);
    }
  }
  return failed ? 1 : 0;
}

async function runCommand(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      public: { type: "boolean", default: false },
      format: { type: "string", short: "f", default: "markdown" },
      author: { type: "string" },
      registry: { type: "string" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(REVIEW_HELP);
    return 0;
  }
  if (values.format !== "markdown" && values.format !== "json") throw new UsageError(`Unknown format "${values.format}". Use markdown or json.`);
  const [path, ...extra] = positionals;
  if (!path || extra.length > 0) throw new UsageError("review run needs exactly one project.yaml file.");
  const registry = registryFrom(values.registry, io);
  const { text, directory } = await readProjectFile(io, path);
  const parsed = parseProjectText(text, directory);
  let report: ReviewReport;
  if (!parsed.project) {
    report = buildReport(
      { project: NAME_PATTERN.test(directory) ? directory : "intake", status: "invalid", problems: parsed.problems, notes: [], diagnostics: [], filesAnalyzed: 0, inventoryComplete: true },
      { public: values.public },
    );
  } else {
    const outcome = await reviewProject(githubClient(io), parsed.project, { registry, ...(values.author !== undefined ? { author: values.author } : {}) });
    report = buildReport(outcome, { public: values.public });
  }
  await writeText(io, values.output, values.format === "json" ? renderJson(report) : renderMarkdown(report));
  return reportExitCode(report);
}

async function intakeCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      pr: { type: "string" },
      repo: { type: "string" },
      "head-sha": { type: "string" },
      registry: { type: "string" },
      comment: { type: "boolean", default: false },
      artifact: { type: "string" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(REVIEW_HELP);
    return 0;
  }
  const pr = Number(values.pr);
  if (!values.pr || !/^[1-9][0-9]{0,9}$/.test(values.pr) || !Number.isSafeInteger(pr)) throw new UsageError("review intake needs --pr <number>.");
  const headSha = values["head-sha"];
  if (headSha !== undefined && !SHA.test(headSha)) throw new UsageError("--head-sha must be a full 40-character lowercase commit SHA.");
  const repo = repoFrom(values.repo, io);
  const registry = registryFrom(values.registry ?? `${repo.owner}/${repo.repo}`, io);
  const client = githubClient(io);
  const result = await runIntake(client, repo, { pr, registry, ...(headSha !== undefined ? { headSha } : {}) });
  if (values.artifact && result.artifact) await writeText(io, values.artifact, serializeIntakeArtifact(result.artifact));
  await writeText(io, values.output, result.markdown);
  if (values.comment && result.report) {
    const { action } = await upsertReviewComment(client, repo, pr, result.name, result.markdown);
    io.stderr(`review comment ${action} on #${pr}`);
  }
  return result.exitCode;
}

async function intakeArtifactCommand(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { "expected-sha": { type: "string" }, help: { type: "boolean", short: "h", default: false } },
  });
  if (values.help) {
    io.stdout(REVIEW_HELP);
    return 0;
  }
  const [path, ...extra] = positionals;
  if (!path || extra.length > 0) throw new UsageError("review intake-artifact needs exactly one file.");
  const expected = values["expected-sha"];
  if (!expected) throw new UsageError("review intake-artifact needs --expected-sha <sha>.");
  const target = resolvePath(io, path);
  const info = await lstat(target).catch(() => undefined);
  if (!info?.isFile()) {
    io.stderr(`${path}: the intake record is missing or is not a regular file.`);
    return 1;
  }
  if (info.size > INTAKE_ARTIFACT_MAX_BYTES) {
    io.stderr(`${path}: the intake record is larger than ${INTAKE_ARTIFACT_MAX_BYTES} bytes.`);
    return 1;
  }
  const parsed = parseIntakeArtifact(await readFile(target, "utf8"), expected);
  if (!parsed.artifact) {
    for (const problem of parsed.problems) io.stderr(`${path}: ${problem}`);
    return 1;
  }
  io.stdout(`pr_number=${parsed.artifact.pr_number}\nhead_sha=${parsed.artifact.head_sha}`);
  return 0;
}

async function scheduledCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      dir: { type: "string", default: "projects" },
      registry: { type: "string" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(REVIEW_HELP);
    return 0;
  }
  const registry = registryFrom(values.registry, io);
  const root = resolvePath(io, values.dir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new UsageError(`Cannot read ${values.dir}: ${(error as Error).message}`);
  }
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const client = githubClient(io);
  const rows: string[] = [];
  const details: string[] = [];
  let failed = false;
  for (const directory of names) {
    let report: ReviewReport;
    const file = join(root, directory, PROJECT_FILE);
    const exists = await lstat(file).then((info) => info.isFile(), () => false);
    if (!exists) continue;
    const { text } = await readProjectFile(io, file);
    const parsed = parseProjectText(text, directory);
    if (!parsed.project) {
      report = buildReport({ project: NAME_PATTERN.test(directory) ? directory : "intake", status: "invalid", problems: parsed.problems, notes: [], diagnostics: [], filesAnalyzed: 0, inventoryComplete: true }, { public: true });
    } else {
      report = buildReport(await reviewProject(client, parsed.project, { registry }), { public: true });
    }
    if (report.status === "invalid" || report.status === "error") failed = true;
    const { summary } = report;
    rows.push(`| ${escapeInline(report.project, 63)} | ${report.status} | ${summary.filesAnalyzed} | ${summary.error} | ${summary.warn} | ${summary.info} | ${report.redacted.count} |`);
    const body = renderMarkdown(report, { heading: "####" });
    details.push("<details>", `<summary>${escapeInline(report.project, 63)}: ${report.status}</summary>`, "", body.length > SCHEDULED_PROJECT_MAX_BYTES ? `${body.slice(0, SCHEDULED_PROJECT_MAX_BYTES)}\n\n_Report truncated._` : body, "</details>", "");
  }
  const lines = ["### Scheduled project reviews", "", `${rows.length === 0 ? "No" : rows.length} registered project${rows.length === 1 ? "" : "s"} reviewed.`, ""];
  if (rows.length > 0) lines.push("| Project | Status | Files | Error | Warn | Info | Withheld |", "| --- | --- | --- | --- | --- | --- | --- |", ...rows, "", ...details);
  let text = lines.join("\n");
  if (text.length > SCHEDULED_MAX_BYTES) text = `${text.slice(0, SCHEDULED_MAX_BYTES)}\n\n_Summary truncated._\n`;
  await writeText(io, values.output, text);
  return failed ? 1 : 0;
}

const COMMANDS: Record<string, (args: string[], io: CliIO) => Promise<number>> = {
  validate: validateCommand,
  run: runCommand,
  intake: intakeCommand,
  "intake-artifact": intakeArtifactCommand,
  scheduled: scheduledCommand,
};

export async function reviewCommand(args: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    io.stdout(REVIEW_HELP);
    return 0;
  }
  const handler = COMMANDS[command];
  if (!handler) throw new UsageError(`Unknown review command "${command}". Commands: ${Object.keys(COMMANDS).join(", ")}.`);
  return handler(rest, io);
}
