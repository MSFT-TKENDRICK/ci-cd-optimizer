import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { httpStatus } from "../github/client.js";
import { processWorkflowRun, type WorkflowRunResult } from "../service/workflow-run.js";
import { describeRunKnowledge } from "../service/run-knowledge.js";
import type { WorkflowRunPayload } from "../telemetry/snapshot.js";
import { FileTelemetryStore } from "../telemetry/store.js";
import { BENCHMARK_SCHEMA, benchmarkRun, encodeBenchmark, type RunBenchmark } from "../telemetry/benchmark.js";
import { copilotClient, githubClient, repoFrom, resolvePath, UsageError, writeText, type CliIO } from "./io.js";

export const TELEMETRY_HELP = `Usage: ci-cd-optimizer telemetry --run-id <id> [options]

Snapshots a completed workflow run (jobs, steps, runner queue time), compares it with prior runs of the same
workflow and branch, renders the report (Gantt timeline, job dependency graph, critical path, slowest steps, jobs
slower than baseline, log-backed bottleneck candidates, and evidence coverage gaps), and opens, updates, or resolves
duration alert issues for statistically significant spikes and sustained regressions. Savings are upper bounds, not
predictions, and findings may overlap. Run it from a workflow triggered by \`workflow_run: types: [completed]\`.

Options:
      --repo <owner/name>   Repository (default: $GITHUB_REPOSITORY)
      --run-id <id>         The completed workflow run to analyze (e.g. github.event.workflow_run.id)
      --run-attempt <n>     Pin the triggering attempt, even if a newer retry has already started
      --store <file>        JSON Lines snapshot store kept between runs (persist it with actions/cache);
                            without one, history is rebuilt from the Actions API on every run
      --summary <file>      Append the markdown report (default: $GITHUB_STEP_SUMMARY when set; "-" to disable)
      --check               Also publish the report as a neutral check run on the run's head commit
      --no-alerts           Do not open or update duration alert issues
      --knowledge           Include source context and configured duration budgets (preview only; no durable history)
      --broadcast           Emit integrity-framed benchmark data for the opted-in MCP feedback feed
      --dry-run             Analyze and report, but write nothing to GitHub or the store
  -f, --format markdown|json  Output format (default: markdown)
  -o, --output <file>       Write the output to a file

Needs actions: read, and issues: write for alerts (checks: write with --check; contents: read with --knowledge).
`;

function runSummary(result: WorkflowRunResult, repo: string) {
  return {
    repo,
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.snapshot ? { snapshot: result.snapshot } : {}),
    ...(result.baseline ? { baseline: result.baseline } : {}),
    ...(result.samples !== undefined ? { samples: result.samples } : {}),
    ...(result.benchmark ? { benchmark: result.benchmark } : {}),
    ...(result.attribution
      ? {
          attribution: {
            elapsedMs: result.attribution.elapsedMs,
            criticalSlackMs: result.attribution.criticalSlackMs,
            coverage: result.attribution.coverage,
            bottlenecks: result.attribution.bottlenecks,
            omittedBottlenecks: 0,
            gaps: result.attribution.gaps,
            omittedGaps: 0,
          },
        }
      : {}),
    ...(result.attributionUnavailable ? { attributionUnavailable: result.attributionUnavailable } : {}),
    ...(result.knowledge ? { knowledge: result.knowledge } : {}),
    ...(result.knowledgeSkipped ? { knowledgeSkipped: result.knowledgeSkipped } : {}),
    ...(result.alerts
      ? {
          alerts: {
            detected: result.alerts.detected,
            actions: result.alerts.actions.map((action) => ({ type: action.type, ...("number" in action ? { number: action.number } : {}) })),
            applied: result.alerts.applied.map((item) => ({ type: item.action.type, number: item.number })),
          },
        }
      : {}),
    ...(result.checkRunId !== undefined ? { checkRunId: result.checkRunId } : {}),
  };
}

export async function telemetryCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      repo: { type: "string" },
      "run-id": { type: "string" },
      "run-attempt": { type: "string" },
      store: { type: "string" },
      summary: { type: "string" },
      check: { type: "boolean", default: false },
      "no-alerts": { type: "boolean", default: false },
      knowledge: { type: "boolean", default: false },
      broadcast: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      format: { type: "string", short: "f", default: "markdown" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(TELEMETRY_HELP);
    return 0;
  }
  if (values.format !== "markdown" && values.format !== "json") throw new UsageError(`Unknown format "${values.format}". Use markdown or json.`);
  const runId = Number(values["run-id"]);
  if (!values["run-id"] || !Number.isSafeInteger(runId) || runId <= 0) throw new UsageError("--run-id <id> is required (a positive workflow run id).");
  const attempt = values["run-attempt"] === undefined ? undefined : Number(values["run-attempt"]);
  if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt <= 0)) throw new UsageError("--run-attempt must be a positive integer.");
  const repo = repoFrom(values.repo, io);
  const client = githubClient(io);
  let repositoryId: number | undefined;
  if (values.broadcast) {
    const metadata = (await client.request("GET /repos/{owner}/{repo}", { ...repo })).data as { id?: number };
    if (!Number.isSafeInteger(metadata.id) || (metadata.id ?? 0) <= 0) throw new UsageError("Broadcast requires a verified numeric repository identity.");
    repositoryId = metadata.id;
  }

  let run: WorkflowRunPayload;
  try {
    run = (await client.request(attempt === undefined
      ? "GET /repos/{owner}/{repo}/actions/runs/{run_id}"
      : "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}", {
      ...repo, run_id: runId, ...(attempt === undefined ? {} : { attempt_number: attempt }),
    })).data as WorkflowRunPayload;
  } catch (error) {
    if (httpStatus(error) === 404) throw new UsageError(`Workflow run ${runId} not found in ${repo.owner}/${repo.repo}.`);
    throw error;
  }
  if (run.id !== runId || (attempt !== undefined && run.run_attempt !== attempt)) throw new UsageError("Workflow run/attempt identity does not match the request.");

  const store = values.store ? new FileTelemetryStore(resolvePath(io, values.store)) : undefined;
  await store?.initialize();
  const copilot = copilotClient(io);
  const result = await processWorkflowRun(client, repo, run, {
    dryRun: values["dry-run"],
    check: values.check,
    alerts: !values["no-alerts"],
    knowledge: values.knowledge,
    ...(repositoryId !== undefined ? { expectedRepositoryId: repositoryId } : {}),
    ...(store ? { store } : {}),
    ...(copilot ? { copilotClient: copilot } : {}),
    ...(io.now ? { now: io.now() } : {}),
  });

  const name = `${repo.owner}/${repo.repo}`;
  const markdown = result.report ?? `Telemetry ${result.status} for run ${runId}${result.reason ? `: ${result.reason}` : "."}` +
    (result.knowledge ? describeRunKnowledge(result.knowledge) : "");
  const summaryPath = values.summary ?? io.env.GITHUB_STEP_SUMMARY;
  if (summaryPath && summaryPath !== "-" && result.report) {
    const target = resolvePath(io, summaryPath);
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, `${result.report}\n`, "utf8");
  }
  await writeText(io, values.output, values.format === "json" ? JSON.stringify(runSummary(result, name), null, 2) : markdown);
  if (values.broadcast && repositoryId !== undefined) {
    const benchmark: RunBenchmark = {
      schema: BENCHMARK_SCHEMA, repositoryId, collectedAt: (io.now?.() ?? new Date()).toISOString(),
      ...(result.benchmark ?? (result.snapshot ? benchmarkRun(result.snapshot, undefined, undefined, []) : {
        repository: name, runId: run.id, runAttempt: run.run_attempt ?? 1, headSha: run.head_sha,
        workflowId: run.workflow_id, workflowPath: run.path, conclusion: run.conclusion,
        analysisStatus: "unavailable", metrics: null, previous: null, jobs: [], omittedJobs: 0, findings: [], omittedFindings: 0,
        gaps: [`Telemetry ${result.status}: ${result.reason ?? "analysis disabled by repository configuration"}`], omittedGaps: 0,
        rework: { observedAttempts: 0, failedAttempts: 0, artifactDriftAttempts: 0, artifactDriftRunnerMs: 0, unclassifiedFailedAttempts: 0 },
      })),
    };
    io.stdout(`${encodeBenchmark(benchmark)}\n`);
  }
  return 0;
}
