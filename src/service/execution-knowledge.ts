import type { GitHubClient, RepoRef } from "../github/client.js";
import { createExecutionObservation, parseExecutionReport, validateExecutionObservation } from "../knowledge/execution.js";
import type { ExecutionObservation, KnowledgeStore, RunObservation } from "../knowledge/types.js";
import { authorizedRunKnowledge } from "./mitigation-knowledge.js";

const limitations = [
  "Operator-supplied report; GitHub access verifies run association, not report origin, attestation, or claim truth.",
  "Single-command coverage; project paths and installed tools/cache outcomes are reported, not inferred from declarations.",
  "Reports are not used automatically as duration samples, verified project attribution, cache savings, or causal mitigation evidence.",
];

async function authorizeJob(client: GitHubClient, repo: RepoRef, execution: ExecutionObservation, observation: RunObservation): Promise<void> {
  validateExecutionObservation(execution, observation);
  const response = await client.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}", { ...repo, job_id: execution.jobId });
  const data = response.data as { id?: number; run_id?: number; run_attempt?: number; head_sha?: string } | undefined;
  if (data?.id !== execution.jobId || data.run_id !== observation.run.runId ||
      data.run_attempt !== observation.run.runAttempt || data.head_sha !== observation.run.headSha) {
    throw new Error("Actions job does not match the execution report's exact run attempt");
  }
}

export async function importExecutionKnowledge(
  client: GitHubClient, repo: RepoRef, factory: () => Promise<KnowledgeStore>, runObservationId: string,
  jobId: number, input: unknown, now?: Date,
) {
  const report = parseExecutionReport(input);
  const context = await authorizedRunKnowledge(client, repo, factory, runObservationId);
  const execution = createExecutionObservation(report, runObservationId, jobId, now);
  await authorizeJob(client, repo, execution, context.observation);
  await context.access.revision(report.checkoutSha);
  await context.store.saveExecutionObservation(execution);
  return { execution, limitations };
}

export async function listExecutionKnowledge(
  client: GitHubClient, repo: RepoRef, factory: () => Promise<KnowledgeStore>, runObservationId: string, limit = 20,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Execution result limit must be between 1 and 100");
  const context = await authorizedRunKnowledge(client, repo, factory, runObservationId);
  const executions = await context.store.listExecutionObservations(context.identity, runObservationId, limit);
  const jobs = new Set<number>();
  for (const execution of executions) {
    validateExecutionObservation(execution, context.observation);
    if (!jobs.has(execution.jobId)) {
      await authorizeJob(client, repo, execution, context.observation);
      jobs.add(execution.jobId);
    }
    await context.access.revision(execution.report.checkoutSha);
  }
  return { executions, coverage: "bounded" as const, limit, limitations };
}
