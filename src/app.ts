import type { Probot } from "probot";
import { fromOctokit, type GitHubClient, type RepoRef } from "./github/client.js";
import { restClient } from "./github/rest.js";
import { isInventoryPath } from "./lint/inventory.js";
import { CHECK_NAME } from "./service/checks.js";
import { handleIssueComment } from "./service/comments.js";
import { runPullRequestCheck, type PullRequestRef } from "./service/pull-request.js";
import { describeScan, scanRepository } from "./service/scan.js";
import { processWorkflowRun } from "./service/workflow-run.js";
import { RepositoryQueue } from "./service/repository-queue.js";
import type { WorkflowRunPayload } from "./telemetry/snapshot.js";
import { PostgresTelemetryStore } from "./telemetry/postgres-store.js";
import type { TelemetryStore } from "./telemetry/store.js";
import { PostgresKnowledgeStore } from "./knowledge/postgres-store.js";
import type { KnowledgeStore } from "./knowledge/types.js";

export interface AppOptions {
  /** Snapshot store; defaults to Postgres when `DATABASE_URL` is set, otherwise history comes from the Actions API. */
  store?: () => Promise<TelemetryStore | undefined>;
  /** Revision evidence store; defaults to Postgres when DATABASE_URL is set. Configured persistence fails closed. */
  knowledgeStore?: () => Promise<KnowledgeStore | undefined>;
  /** Client for a Copilot-licensed user (`COPILOT_ASSIGN_TOKEN`), so issues can be assigned to the coding agent. */
  copilotClient?: GitHubClient;
  /** Upload scan results to code scanning (`CICD_OPTIMIZER_UPLOAD_SARIF`, default true). */
  uploadSarif?: boolean;
}

export const APP_EVENTS = {
  pullRequest: ["pull_request.opened", "pull_request.synchronize", "pull_request.reopened", "pull_request.ready_for_review"],
  checkRun: "check_run.rerequested",
  push: "push",
  installation: ["installation.created", "installation_repositories.added"],
  workflowRun: "workflow_run.completed",
  comment: "issue_comment.created",
} as const;

export function validateProductionConfiguration(): void {
  if (process.env.NODE_ENV !== "production") return;
  const secret = process.env.WEBHOOK_SECRET?.trim();
  if (!secret || secret === "development" || secret === "replace-me") {
    throw new Error("Production requires a non-placeholder WEBHOOK_SECRET matching the GitHub App's webhook settings.");
  }
}

interface PushPayload {
  ref: string;
  deleted?: boolean;
  commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>;
  repository: { default_branch?: string };
}

/** Push webhooks list at most 20 commits; beyond that the file list is incomplete. */
const PUSH_COMMIT_LIMIT = 20;

/** A push to the default branch that may have changed CI/CD-relevant files (or whose file list is incomplete). */
export function pushNeedsScan(push: PushPayload): boolean {
  if (push.deleted || !push.repository.default_branch || push.ref !== `refs/heads/${push.repository.default_branch}`) return false;
  const commits = push.commits ?? [];
  if (commits.length === 0 || commits.length >= PUSH_COMMIT_LIMIT) return true;
  return commits.some((commit) => [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])].some(isInventoryPath));
}

interface CheckRunPullRequest {
  number: number;
  head: { sha: string };
  base: { ref: string; sha: string };
}

/** The pull request a re-requested "CI/CD Optimizer" check belongs to (only same-repository pull requests are listed). */
export function rerequestedPullRequest(checkRun: { name: string; head_sha: string; pull_requests?: CheckRunPullRequest[] }): PullRequestRef | undefined {
  if (checkRun.name !== CHECK_NAME) return undefined;
  const pr = checkRun.pull_requests?.find((candidate) => candidate.head.sha === checkRun.head_sha) ?? checkRun.pull_requests?.[0];
  return pr ? { number: pr.number, headSha: checkRun.head_sha, baseRef: pr.base.ref, baseSha: pr.base.sha } : undefined;
}

/** `owner/name` strings from installation payloads. */
export function installationRepos(repositories: ReadonlyArray<{ full_name: string }> | undefined): RepoRef[] {
  return (repositories ?? []).flatMap((repository) => {
    const [owner, repo] = repository.full_name.split("/");
    return owner && repo ? [{ owner, repo }] : [];
  });
}

function defaultStore(log: Probot["log"]): () => Promise<TelemetryStore | undefined> {
  let pending: Promise<TelemetryStore | undefined> | undefined;
  return () => {
    pending ??= (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) return undefined;
      const store = new PostgresTelemetryStore(url);
      try {
        await store.initialize();
        return store;
      } catch (error) {
        log.error({ error }, "Telemetry database unavailable; falling back to Actions API history");
        pending = undefined;
        return undefined;
      }
    })();
    return pending;
  };
}

function defaultKnowledgeStore(log: Probot["log"]): () => Promise<KnowledgeStore | undefined> {
  let pending: Promise<KnowledgeStore | undefined> | undefined;
  return () => {
    pending ??= (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) return undefined;
      const store = new PostgresKnowledgeStore(url);
      try {
        await store.initialize();
        return store;
      } catch (error) {
        try { await store.close(); }
        catch (closeError) { log.error({ error: closeError }, "Failed to close knowledge database after initialization failure"); }
        throw error;
      }
    })().catch((error: unknown) => {
      pending = undefined;
      log.error({ error }, "Knowledge database unavailable; repository scan failed and can be retried");
      throw error;
    });
    return pending;
  };
}

export function createApp(options: AppOptions = {}): (probot: Probot) => void {
  return (probot) => {
    validateProductionConfiguration();
    const store = options.store ?? defaultStore(probot.log);
    const knowledgeStore = options.knowledgeStore ?? defaultKnowledgeStore(probot.log);
    const copilotToken = process.env.COPILOT_ASSIGN_TOKEN;
    const copilotClient = options.copilotClient ?? (copilotToken ? restClient({ token: copilotToken }) : undefined);
    const uploadSarif = options.uploadSarif ?? process.env.CICD_OPTIMIZER_UPLOAD_SARIF !== "false";
    const shared = { ...(copilotClient ? { copilotClient } : {}) };
    const repositoryQueue = new RepositoryQueue();

    const scan = (client: GitHubClient, repo: RepoRef, log: Probot["log"], expectedRepositoryId?: number) => repositoryQueue.run(repo, async () => {
      const result = await scanRepository(client, repo, { uploadSarif, knowledgeStore, ...shared, ...(expectedRepositoryId !== undefined ? { expectedRepositoryId } : {}) });
      log.info({ repo: `${repo.owner}/${repo.repo}`, status: result.status }, describeScan(result));
    });

    probot.on([...APP_EVENTS.pullRequest], async (context) => {
      const pr = context.payload.pull_request;
      const result = await runPullRequestCheck(fromOctokit(context.octokit), context.repo(), {
        number: pr.number,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
      });
      context.log.info({ pr: pr.number, conclusion: result.conclusion, introduced: result.introduced.length }, "Pull request check completed");
    });

    probot.on(APP_EVENTS.checkRun, async (context) => {
      const pr = rerequestedPullRequest(context.payload.check_run);
      if (pr) await runPullRequestCheck(fromOctokit(context.octokit), context.repo(), pr);
    });

    probot.on(APP_EVENTS.push, async (context) => {
      if (pushNeedsScan(context.payload)) await scan(fromOctokit(context.octokit), context.repo(), context.log, context.payload.repository.id);
    });

    probot.on([...APP_EVENTS.installation], async (context) => {
      const payload = context.payload;
      const repositories = "repositories_added" in payload ? payload.repositories_added : payload.repositories;
      const client = fromOctokit(context.octokit);
      const errors: unknown[] = [];
      for (const repo of installationRepos(repositories)) {
        try {
          const repository = repositories?.find((candidate) => candidate.full_name === `${repo.owner}/${repo.repo}`);
          await scan(client, repo, context.log, repository?.id);
        } catch (error) {
          context.log.error({ error, repo: `${repo.owner}/${repo.repo}` }, "Initial scan failed");
          errors.push(new Error(`Initial scan failed for ${repo.owner}/${repo.repo}`, { cause: error }));
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "One or more initial repository scans failed");
    });

    probot.on(APP_EVENTS.workflowRun, (context) => repositoryQueue.run(context.repo(), async () => {
      const result = await processWorkflowRun(fromOctokit(context.octokit), context.repo(), context.payload.workflow_run as WorkflowRunPayload, {
        ...shared,
        knowledgeStore,
        expectedRepositoryId: context.payload.repository.id,
        ...(await store().then((value) => (value ? { store: value } : {}))),
      });
      context.log.info(
        {
          runId: context.payload.workflow_run.id, status: result.status, alerts: result.alerts?.detected.length ?? 0,
          knowledge: result.knowledge?.persistence, projectContext: result.knowledge?.observation.source.status, knowledgeSkipped: result.knowledgeSkipped,
        },
        result.reason ?? "Workflow run telemetry processed",
      );
    }));

    probot.on(APP_EVENTS.comment, (context) => repositoryQueue.run(context.repo(), async () => {
      const result = await handleIssueComment(fromOctokit(context.octokit), context.repo(), { issue: context.payload.issue, comment: context.payload.comment });
      if (result.status !== "ignored") context.log.info({ issue: context.payload.issue.number, status: result.status }, "Handled comment command");
    }));
  };
}

export default createApp();
