import { load } from "js-yaml";
import type { Context } from "probot";
import type { JobSnapshot, WorkflowSnapshot } from "../types.js";

type WorkflowRunContext = Context<"workflow_run.completed">;

interface WorkflowJobDefinition {
  name?: unknown;
  needs?: unknown;
}

interface WorkflowJob {
  id: number;
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export async function createWorkflowSnapshot(
  context: WorkflowRunContext,
): Promise<WorkflowSnapshot> {
  const run = context.payload.workflow_run;
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  const jobs = (await context.octokit.paginate(
    "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
    {
      owner,
      repo,
      run_id: run.id,
      per_page: 100,
      filter: "latest",
    },
  )) as WorkflowJob[];
  const definitions = await loadJobDefinitions(context, owner, repo, run.path, run.head_sha);

  const snapshots = jobs
    .filter((job) => job.started_at && job.completed_at)
    .map((job): JobSnapshot => {
      const key = matchJobKey(job.name, definitions);
      const definition = key ? definitions.get(key) : undefined;
      const startedAt = job.started_at as string;
      const completedAt = job.completed_at as string;
      return {
        id: job.id,
        key: key ?? job.name,
        name: job.name,
        conclusion: job.conclusion,
        startedAt,
        completedAt,
        durationMs: elapsed(startedAt, completedAt),
        needs: parseNeeds(definition?.needs),
      };
    });

  const startedAt = run.run_started_at ?? run.created_at;
  const completedAt = run.updated_at;
  return {
    owner,
    repo,
    workflowId: run.workflow_id,
    workflowName: run.name ?? run.path,
    runId: run.id,
    runAttempt: run.run_attempt ?? 1,
    headSha: run.head_sha,
    branch: run.head_branch,
    event: run.event,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    startedAt,
    completedAt,
    queueMs: elapsed(run.created_at, startedAt),
    durationMs: elapsed(startedAt, completedAt),
    jobs: snapshots,
  };
}

async function loadJobDefinitions(
  context: WorkflowRunContext,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<Map<string, WorkflowJobDefinition>> {
  try {
    const response = await context.octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner, repo, path, ref },
    );
    const data = response.data as
      | { type: "file"; content: string }
      | Array<{ type: string }>;
    if (Array.isArray(data) || data.type !== "file") {
      return new Map();
    }
    const document: unknown = load(Buffer.from(data.content, "base64").toString("utf8"));
    if (!isRecord(document) || !isRecord(document.jobs)) return new Map();
    return new Map(
      Object.entries(document.jobs)
        .filter((entry): entry is [string, WorkflowJobDefinition] => isRecord(entry[1]))
        .map(([key, definition]) => [key, definition]),
    );
  } catch {
    return new Map();
  }
}

function matchJobKey(
  jobName: string,
  definitions: ReadonlyMap<string, WorkflowJobDefinition>,
): string | undefined {
  for (const [key, definition] of definitions) {
    const configuredName = typeof definition.name === "string" ? definition.name : undefined;
    if (jobName === key || jobName === configuredName) return key;
    if (jobName.startsWith(`${key} (`) || (configuredName && jobName.startsWith(`${configuredName} (`))) {
      return key;
    }
  }
  return undefined;
}

function parseNeeds(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function elapsed(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
