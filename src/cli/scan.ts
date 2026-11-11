import { parseArgs } from "node:util";
import type { FixAction } from "../fixes/plan.js";
import type { IssueAction } from "../issues/plan.js";
import { exceedsThreshold } from "../lint/engine.js";
import type { ActiveSeverity } from "../lint/types.js";
import { describeScan, scanRepository, type ScanResult } from "../service/scan.js";
import { copilotClient, githubClient, repoFrom, UsageError, writeText, type CliIO } from "./io.js";

export const SCAN_HELP = `Usage: ci-cd-optimizer scan [options]

Scans a repository through the GitHub API exactly as the GitHub App does on push: lints the default branch with
its .github/ci-cd-optimizer.yml, optionally uploads SARIF to code scanning, and syncs finding issues and autofix
pull requests when the configuration enables them. Idempotent; schedule it to run without installing the App.

Options:
      --repo <owner/name>   Repository to scan (default: $GITHUB_REPOSITORY)
      --ref <ref>           Branch or commit (default: the default branch; issues and fix PRs only sync there)
      --upload-sarif        Upload findings to code scanning (needs security-events: write)
      --no-issues           Do not open, update, or close finding issues
      --no-fixes            Do not open or update autofix pull requests
      --knowledge           Include revision-linked declaration evidence (use --format json for details; no database writes)
      --dry-run             Plan everything, write nothing
      --fail-on <sev>       Exit 1 when findings reach: info | warn | error | never (default: never)
  -f, --format text|json    Output format (default: text)
  -o, --output <file>       Write the output to a file

Set COPILOT_ASSIGN_TOKEN (a Copilot-licensed user's token) to assign finding issues to the Copilot coding agent.
`;

const FAIL_ON = new Set(["info", "warn", "error", "never"]);

function issueAction(action: IssueAction) {
  if (action.type === "close") return { type: action.type, number: action.number, fingerprint: action.fingerprint };
  return { type: action.type, ...("number" in action ? { number: action.number } : {}), fingerprint: action.desired.fingerprint, title: action.desired.title };
}

function fixAction(action: FixAction) {
  if (action.type === "metadata") return action;
  if (action.type === "close") return { type: action.type, number: action.number, group: action.group };
  return { type: action.type, ...("number" in action ? { number: action.number } : {}), group: action.change.group, rules: action.change.rules };
}

function summary(scan: ScanResult) {
  return {
    repo: scan.repo,
    ref: scan.ref,
    ...(scan.sha ? { sha: scan.sha } : {}),
    status: scan.status,
    ...(scan.configProblems ? { configProblems: scan.configProblems } : {}),
    ...(scan.result ? { diagnostics: scan.result.diagnostics } : {}),
    ...(scan.inventoryComplete !== undefined ? { inventoryComplete: scan.inventoryComplete } : {}),
    ...(scan.sarif ? { sarif: scan.sarif } : {}),
    ...(scan.knowledge ? { knowledge: scan.knowledge } : {}),
    ...(scan.issues
      ? {
          issues: {
            actions: scan.issues.actions.map(issueAction),
            skipped: scan.issues.skipped.length,
            applied: scan.issues.applied.map((item) => ({ type: item.action.type, number: item.number, ...(item.copilot ? { copilot: item.copilot } : {}) })),
            ...(scan.issues.awaitingCopilot ? { awaitingCopilot: scan.issues.awaitingCopilot } : {}),
          },
        }
      : {}),
    ...(scan.fixes
      ? {
          fixes: {
            actions: scan.fixes.actions.map(fixAction),
            skipped: scan.fixes.skipped.length,
            applied: scan.fixes.applied.map((item) => ({ type: item.action.type, number: item.number })),
          },
        }
      : {}),
  };
}

export async function scanCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      repo: { type: "string" },
      ref: { type: "string" },
      "upload-sarif": { type: "boolean", default: false },
      "no-issues": { type: "boolean", default: false },
      "no-fixes": { type: "boolean", default: false },
      knowledge: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "fail-on": { type: "string", default: "never" },
      format: { type: "string", short: "f", default: "text" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(SCAN_HELP);
    return 0;
  }
  if (values.format !== "text" && values.format !== "json") throw new UsageError(`Unknown format "${values.format}". Use text or json.`);
  if (!FAIL_ON.has(values["fail-on"])) throw new UsageError("--fail-on must be info, warn, error, or never.");
  const repo = repoFrom(values.repo, io);
  const copilot = copilotClient(io);
  const scan = await scanRepository(githubClient(io), repo, {
    dryRun: values["dry-run"],
    uploadSarif: values["upload-sarif"],
    issues: !values["no-issues"],
    fixes: !values["no-fixes"],
    knowledge: values.knowledge,
    ...(values.ref ? { ref: values.ref } : {}),
    ...(copilot ? { copilotClient: copilot } : {}),
  });
  await writeText(io, values.output, values.format === "json" ? JSON.stringify(summary(scan), null, 2) : describeScan(scan));
  if (scan.status === "invalid-config") return 2;
  return exceedsThreshold(scan.result?.diagnostics ?? [], values["fail-on"] as ActiveSeverity | "never") ? 1 : 0;
}
