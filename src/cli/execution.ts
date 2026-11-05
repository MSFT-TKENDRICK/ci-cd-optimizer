import { parseArgs } from "node:util";
import { captureExecution, readExecutionJson } from "../telemetry/execution-capture.js";
import { importExecutionKnowledge, listExecutionKnowledge } from "../service/execution-knowledge.js";
import { githubClient, repoFrom, resolvePath, UsageError, type CliIO } from "./io.js";
import { usingKnowledgeStore } from "./knowledge-store.js";

export const EXECUTION_HELP = `Usage: ci-cd-optimizer execution <capture|import|list> [options]

capture --project <relative-directory> --task <label> --output <new-json-file> [--observations <json>] -- <executable> [args...]
  Runs one explicitly requested command from a repository root on an Actions runner. Requires GITHUB_SERVER_URL,
  GITHUB_REPOSITORY_ID, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SHA and GITHUB_JOB. Records actual checkout SHA,
  elapsed time, exit/signal and recorder Node version. Optional tools/cache observations remain workflow-reported.
  Never captures command arguments, output, environment variables, cache keys or credentials. Propagates child exit code.

import --repo <owner/repo> --observation <run-observation-id> --job-id <Actions-job-id> --file <json>
list   --repo <owner/repo> --observation <run-observation-id> [--limit 1-100]
  Uses DATABASE_URL and fresh Contents/Actions authorization. Import never runs the captured command.
  Association with a real run/attempt/job does not authenticate a local report's origin or establish causality.
`;

export async function executionCommand(args: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") { io.stdout(EXECUTION_HELP); return 0; }
  if (command === "capture") {
    const separator = rest.indexOf("--");
    const { values } = parseArgs({
      args: separator < 0 ? rest : rest.slice(0, separator), strict: true, options: {
        project: { type: "string" }, task: { type: "string" }, output: { type: "string" },
        observations: { type: "string" }, help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) { io.stdout(EXECUTION_HELP); return 0; }
    if (!values.project || !values.task || !values.output || separator < 0) throw new UsageError("Capture requires --project, --task, --output and -- <executable>.");
    const report = await captureExecution(io, {
      project: values.project, task: values.task, output: values.output,
      ...(values.observations ? { observations: values.observations } : {}),
    }, rest.slice(separator + 1));
    io.stdout(JSON.stringify({ output: values.output, exitCode: report.exitCode, signal: report.signal, coverage: report.coverage }));
    return report.exitCode ?? 1;
  }
  if (command !== "import" && command !== "list") throw new UsageError("Execution requires capture, import or list.");
  const { values } = parseArgs({
    args: rest, strict: true, options: {
      repo: { type: "string" }, observation: { type: "string" }, "job-id": { type: "string" },
      file: { type: "string" }, limit: { type: "string", default: "20" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) { io.stdout(EXECUTION_HELP); return 0; }
  if (!/^[a-f0-9]{64}$/.test(values.observation ?? "")) throw new UsageError("--observation requires an immutable SHA-256 run observation ID.");
  const jobId = Number(values["job-id"]);
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new UsageError("--limit must be between 1 and 100.");
  if (command === "import" && (!values.file || !Number.isSafeInteger(jobId) || jobId < 1)) throw new UsageError("Import requires --file and a positive --job-id.");
  const repo = repoFrom(values.repo, io);
  const client = githubClient(io);
  const result = await usingKnowledgeStore(io, true, async (factory) => command === "list"
    ? listExecutionKnowledge(client, repo, factory!, values.observation!, limit)
    : importExecutionKnowledge(client, repo, factory!, values.observation!, jobId, await readExecutionJson(resolvePath(io, values.file!)), io.now?.()));
  io.stdout(JSON.stringify(result, null, 2));
  return 0;
}
