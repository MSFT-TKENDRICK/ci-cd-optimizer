import type { Probot } from "probot";
import { analyze, shouldFail } from "./analyzer.js";
import { loadRepositoryFiles } from "./github.js";
import { createAnnotations, createSummary } from "./report.js";
import { createTelemetryReport } from "./telemetry/report.js";
import { createWorkflowSnapshot } from "./telemetry/snapshot.js";
import { PostgresTelemetryStore, type TelemetryStore } from "./telemetry/store.js";

const checkName = "CI/CD Optimizer";

export default function app(probot: Probot): void {
  const telemetryStore = createTelemetryStore(probot);

  probot.on(
    [
      "pull_request.opened",
      "pull_request.synchronize",
      "pull_request.reopened",
      "pull_request.ready_for_review",
    ],
    async (context) => {
      const pullRequest = context.payload.pull_request;
      if (pullRequest.draft) return;

      const owner = context.payload.repository.owner.login;
      const repo = context.payload.repository.name;
      const headSha = pullRequest.head.sha;

      const check = await context.octokit.request("POST /repos/{owner}/{repo}/check-runs", {
        owner,
        repo,
        name: checkName,
        head_sha: headSha,
        status: "in_progress",
        started_at: new Date().toISOString(),
        output: {
          title: "Analyzing build and release configuration",
          summary: "Scanning relevant workflows, manifests, and container definitions.",
        },
      });

      try {
        const snapshot = await loadRepositoryFiles(context, owner, repo, headSha);
        const findings = analyze(snapshot.files, snapshot.config);
        const failure = shouldFail(findings, snapshot.config.failOnSeverity);

        await context.octokit.request(
          "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
          {
          owner,
          repo,
          check_run_id: check.data.id,
          status: "completed",
          completed_at: new Date().toISOString(),
          conclusion: failure ? "failure" : findings.length > 0 ? "neutral" : "success",
          output: {
            title:
              findings.length > 0
                ? `${findings.length} optimization ${findings.length === 1 ? "opportunity" : "opportunities"}`
                : "No optimization findings",
            summary: createSummary(findings, snapshot.truncated),
            annotations: createAnnotations(findings),
          },
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.log.error({ error }, "CI/CD analysis failed");
        await context.octokit.request(
          "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
          {
          owner,
          repo,
          check_run_id: check.data.id,
          status: "completed",
          completed_at: new Date().toISOString(),
          conclusion: "action_required",
          output: {
            title: "Analysis could not complete",
            summary: `The app encountered an error while analyzing this commit: ${message}`,
          },
          },
        );
      }
    },
  );

  probot.on("workflow_run.completed", async (context) => {
    const store = await telemetryStore;
    if (!store) {
      context.log.warn(
        "DATABASE_URL is not configured; workflow telemetry snapshots are disabled",
      );
      return;
    }

    const snapshot = await createWorkflowSnapshot(context);
    const baseline = await store.baseline(snapshot);
    await store.save(snapshot);

    const check = await context.octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner: snapshot.owner,
      repo: snapshot.repo,
      name: "CI/CD Telemetry",
      head_sha: snapshot.headSha,
      status: "completed",
      completed_at: new Date().toISOString(),
      conclusion: "neutral",
      details_url: context.payload.workflow_run.html_url,
      output: {
        title: `${snapshot.workflowName}: ${formatDuration(snapshot.durationMs)}`,
        summary: createTelemetryReport(snapshot, baseline),
      },
    });
    context.log.info(
      { checkRunId: check.data.id, workflowRunId: snapshot.runId },
      "Published workflow telemetry report",
    );
  });
}

async function createTelemetryStore(probot: Probot): Promise<TelemetryStore | undefined> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return undefined;
  const store = new PostgresTelemetryStore(databaseUrl);
  try {
    await store.initialize();
  } catch (error: unknown) {
    probot.log.error({ error }, "Failed to initialize telemetry database");
    return undefined;
  }
  return store;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
