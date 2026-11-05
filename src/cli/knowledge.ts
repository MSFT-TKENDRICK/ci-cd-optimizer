import { parseArgs } from "node:util";
import {
  evaluateMitigationKnowledge, inspectMitigationKnowledge, listMitigationKnowledge, listRunKnowledge, refreshMitigationKnowledge,
} from "../service/mitigation-knowledge.js";
import { githubClient, repoFrom, UsageError, type CliIO } from "./io.js";
import { usingKnowledgeStore } from "./knowledge-store.js";

export const KNOWLEDGE_HELP = `Usage: ci-cd-optimizer knowledge <command> --repo <owner/name> [options]

Repository-authorized mitigation evidence in DATABASE_URL (JSON output).
Every operation checks current GitHub contents access; measured evidence also needs actions: read.

Commands:
  applications    List a bounded window of target applications (--limit 1-100, default 20)
  runs            List immutable observation IDs (--limit 1-100, optional --run-id <Actions run number>)
  inspect         Read an application, latest lifecycle events and evaluations (--application <id>, --limit)
  refresh         Append the current GitHub state of a pinned PR or adaptation issue (--application <id>)
  evaluate        Persist an exploratory comparison (--application <id> --control <observation-ids> --treatment <observation-ids>)

IDs in --control / --treatment are comma-separated immutable observation IDs, not Actions run numbers.
evaluate uses workflow duration unless --job <job-context-key> is supplied. Distinct first attempts, matching
contexts and runs bracketing the recorded application are required; results do not establish causal benefit.
refresh and evaluate write to the database, never to GitHub. Missing permissions fail closed.
`;

export async function knowledgeCommand(args: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || rest.includes("--help") || rest.includes("-h")) {
    io.stdout(KNOWLEDGE_HELP);
    return 0;
  }
  if (!["applications", "runs", "inspect", "refresh", "evaluate"].includes(command)) throw new UsageError(`Unknown knowledge command "${command}".`);
  const { values } = parseArgs({
    args: rest, strict: true,
    options: {
      repo: { type: "string" }, application: { type: "string" }, limit: { type: "string", default: "20" },
      control: { type: "string" }, treatment: { type: "string" }, job: { type: "string" },
      "run-id": { type: "string" },
    },
  });
  const repo = repoFrom(values.repo, io);
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new UsageError("--limit must be an integer between 1 and 100.");
  if (!["applications", "runs"].includes(command) && !/^[a-f0-9]{64}$/.test(values.application ?? "")) throw new UsageError("--application requires an immutable SHA-256 application ID.");
  const runId = values["run-id"] === undefined ? undefined : Number(values["run-id"]);
  if (runId !== undefined && (!Number.isSafeInteger(runId) || runId < 1)) throw new UsageError("--run-id must be a positive safe integer.");
  if (command === "evaluate" && (!values.control || !values.treatment)) throw new UsageError("evaluate requires --control and --treatment observation IDs.");
  const result = await usingKnowledgeStore(io, true, async (factory) => {
    const client = githubClient(io);
    if (command === "applications") return listMitigationKnowledge(client, repo, factory!, limit);
    if (command === "runs") return listRunKnowledge(client, repo, factory!, limit, runId);
    if (command === "inspect") return inspectMitigationKnowledge(client, repo, factory!, values.application!, limit);
    if (command === "refresh") return refreshMitigationKnowledge(client, repo, factory!, values.application!);
    return evaluateMitigationKnowledge(client, repo, factory!, values.application!, {
      control: values.control!.split(",").map((id) => id.trim()),
      treatment: values.treatment!.split(",").map((id) => id.trim()),
      ...(values.job ? { job: values.job } : {}), ...(io.now ? { now: io.now() } : {}),
    });
  });
  io.stdout(JSON.stringify(result, null, 2));
  return 0;
}
