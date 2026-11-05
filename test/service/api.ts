import { fakeClient, httpError } from "../experiments/fixtures.js";

const base64 = (text: string) => Buffer.from(text).toString("base64");

export interface FakePull {
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  labels: string[];
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string };
  requested_reviewers: Array<{ login: string }>;
  requested_teams: Array<{ slug: string }>;
}

export interface FakeApiState {
  repositoryMetadata?: Record<string, unknown>;
  commitSha?: string;
  defaultBranch?: string;
  /** Repository files per ref (branch name or commit sha). */
  refs?: Record<string, Record<string, string>>;
  /** `.github/ci-cd-optimizer.yml`, served on every ref. */
  config?: string;
  issues?: unknown[];
  /** Supply an array to persist PR creation, labels and reviewer requests across scans. */
  pulls?: FakePull[];
  pullHeads?: Record<number, { sha: string; ref: string }>;
  branchHeads?: Record<string, string>;
  pullFiles?: Array<{ filename: string; previous_filename?: string }>;
  /** Jobs per workflow run id. */
  jobs?: Record<number, unknown[]>;
  workflowRuns?: unknown[];
  /** Workflow runs by id (GET /actions/runs/{run_id}). */
  runs?: Record<number, unknown>;
  sarifStatus?: number;
  collaboratorPermission?: string;
  failOn?: (route: string) => boolean;
}

/** A fake GitHub REST API for one repository with per-ref trees, routing every endpoint the services use. */
export function fakeApi(state: FakeApiState = {}) {
  const branch = state.defaultBranch ?? "main";
  const refs = state.refs ?? {};
  const blobs = new Map<string, string>();
  const edits = new Map<number, Record<string, unknown>>();
  const branchHeads = state.branchHeads ?? {};
  if (!state.branchHeads) {
    for (const issue of state.issues ?? []) {
      if (typeof issue !== "object" || issue === null || !("pull_request" in issue) || !("number" in issue)) continue;
      const head = state.pullHeads?.[Number(issue.number)] ?? { sha: "pr-head", ref: "cicd-optimizer/workflow" };
      branchHeads[head.ref] = head.sha;
    }
    for (const pull of state.pulls ?? []) branchHeads[pull.head.ref] = pull.head.sha;
  }
  const filesAt = (ref: string) => refs[ref] ?? refs[ref.replace(/-sha$/, "")] ?? {};
  let nextId = 100;
  return fakeClient((route, parameters) => {
    if (state.failOn?.(route)) throw httpError(500);
    switch (route) {
      case "GET /repos/{owner}/{repo}":
        return { default_branch: branch, node_id: "repository-node", ...state.repositoryMetadata };
      case "GET /repos/{owner}/{repo}/collaborators/{username}/permission":
        return { permission: state.collaboratorPermission ?? "write" };
      case "GET /repos/{owner}/{repo}/contents/{path}": {
        const path = String(parameters.path);
        const ref = String(parameters.ref ?? branch);
        const content = filesAt(ref)[path] ?? (path === ".github/ci-cd-optimizer.yml" ? state.config : undefined);
        if (content === undefined) throw httpError(404);
        return { content: base64(content), encoding: "base64" };
      }
      case "GET /repos/{owner}/{repo}/commits/{ref}": {
        const ref = String(parameters.ref);
        return { sha: state.commitSha ?? (refs[ref] && ref === branch ? `${ref}-sha` : ref), commit: { tree: { sha: `tree:${ref}` } } };
      }
      case "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": {
        const ref = String(parameters.tree_sha).slice("tree:".length);
        const files = filesAt(ref);
        return {
          tree: Object.entries(files).map(([path, content]) => {
            const sha = `blob:${ref}:${path}`;
            blobs.set(sha, content);
            return { path, type: "blob", sha, size: content.length };
          }),
          truncated: false,
        };
      }
      case "GET /repos/{owner}/{repo}/git/blobs/{file_sha}":
        return { content: base64(blobs.get(String(parameters.file_sha)) ?? ""), encoding: "base64" };
      case "GET /repos/{owner}/{repo}/issues":
        return parameters.page && Number(parameters.page) > 1 ? [] : [
          ...(state.issues ?? []).map((issue) => typeof issue === "object" && issue !== null && "number" in issue ? { ...issue, ...edits.get(Number(issue.number)) } : issue),
          ...(state.pulls ?? []).filter((pull) => pull.labels.includes("cicd-optimizer")).map((pull) => ({ ...pull, pull_request: {} })),
        ];
      case "GET /repos/{owner}/{repo}/pulls": {
        const matching = (state.pulls ?? []).filter((pull) =>
          (!parameters.head || parameters.head === `${parameters.owner}:${pull.head.ref}`) &&
          (!parameters.base || parameters.base === pull.base.ref) &&
          (parameters.state === "all" || parameters.state === pull.state));
        const offset = (Number(parameters.page ?? 1) - 1) * Number(parameters.per_page ?? 100);
        return matching.slice(offset, offset + Number(parameters.per_page ?? 100));
      }
      case "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        const number = Number(parameters.pull_number);
        const issue = state.issues?.find((entry) => typeof entry === "object" && entry !== null && "number" in entry && entry.number === number);
        return state.pulls?.find((pull) => pull.number === number) ?? {
          state: "open", ...(typeof issue === "object" ? issue : {}), ...edits.get(number),
          head: { ...(state.pullHeads?.[number] ?? { sha: "pr-head", ref: "cicd-optimizer/workflow" }), repo: { full_name: `${parameters.owner}/${parameters.repo}` } },
          base: { ref: branch },
        };
      }
      case "POST /graphql": {
        const variables = parameters.variables as { input: { refUpdates: Array<{ name: string; beforeOid: string; afterOid: string }> } };
        const updates = variables.input.refUpdates;
        if (updates.some((update) => branchHeads[update.name.slice("refs/heads/".length)] !== update.beforeOid)) {
          return { data: { updateRefs: null }, errors: [{ message: "Reference no longer points to the expected commit" }] };
        }
        for (const update of updates) {
          const ref = update.name.slice("refs/heads/".length);
          if (update.afterOid === "0".repeat(40)) delete branchHeads[ref];
          else {
            branchHeads[ref] = update.afterOid;
            for (const pull of state.pulls ?? []) if (pull.head.ref === ref) pull.head.sha = update.afterOid;
          }
        }
        return { data: { updateRefs: { clientMutationId: null } } };
      }
      case "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers": {
        const pull = state.pulls?.find((pull) => pull.number === Number(parameters.pull_number));
        return { users: pull?.requested_reviewers ?? [], teams: pull?.requested_teams ?? [] };
      }
      case "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers": {
        const pull = state.pulls?.find((pull) => pull.number === Number(parameters.pull_number));
        pull?.requested_reviewers.push(...(parameters.reviewers as string[]).map((login) => ({ login })));
        pull?.requested_teams.push(...(parameters.team_reviewers as string[]).map((slug) => ({ slug })));
        return {};
      }
      case "POST /repos/{owner}/{repo}/issues/{issue_number}/labels": {
        const pull = state.pulls?.find((pull) => pull.number === Number(parameters.issue_number));
        if (pull) pull.labels = [...new Set([...pull.labels, ...parameters.labels as string[]])];
        return {};
      }
      case "PATCH /repos/{owner}/{repo}/pulls/{pull_number}": {
        const pull = state.pulls?.find((pull) => pull.number === Number(parameters.pull_number));
        if (pull && typeof parameters.body === "string") pull.body = parameters.body;
        if (pull && typeof parameters.title === "string") pull.title = parameters.title;
        if (pull && typeof parameters.state === "string") pull.state = parameters.state;
        if (!pull) edits.set(Number(parameters.pull_number), { ...edits.get(Number(parameters.pull_number)), ...parameters });
        return {};
      }
      case "GET /repos/{owner}/{repo}/pulls/{pull_number}/files":
        return parameters.page && Number(parameters.page) > 1 ? [] : state.pullFiles ?? [];
      case "GET /repos/{owner}/{repo}/labels":
        return [];
      case "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs":
      case "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs":
        return { jobs: state.jobs?.[Number(parameters.run_id)] ?? [] };
      case "GET /repos/{owner}/{repo}/actions/runs/{run_id}": {
        const found = state.runs?.[Number(parameters.run_id)];
        if (found === undefined) throw httpError(404);
        return found;
      }
      case "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs":
        return { workflow_runs: state.workflowRuns ?? [] };
      case "GET /repos/{owner}/{repo}/git/commits/{commit_sha}":
        return { tree: { sha: "base-tree" } };
      case "GET /repos/{owner}/{repo}/git/ref/{ref}":
        if (branchHeads[String(parameters.ref).slice("heads/".length)]) return { object: { sha: branchHeads[String(parameters.ref).slice("heads/".length)] } };
        throw httpError(404);
      case "POST /repos/{owner}/{repo}/git/refs": {
        const ref = String(parameters.ref).slice("refs/heads/".length);
        if (branchHeads[ref]) throw httpError(422);
        branchHeads[ref] = String(parameters.sha);
        return {};
      }
      case "POST /repos/{owner}/{repo}/git/trees":
        return { sha: "new-tree" };
      case "POST /repos/{owner}/{repo}/git/commits":
        return { sha: "new-commit" };
      case "POST /repos/{owner}/{repo}/pulls":
        if (state.pulls?.some((pull) => pull.head.ref === parameters.head && pull.base.ref === parameters.base && pull.state === "open")) throw httpError(422);
        state.pulls?.push({
          number: 42, title: String(parameters.title), body: String(parameters.body), state: "open", draft: Boolean(parameters.draft), labels: [],
          head: { ref: String(parameters.head), sha: "new-commit", repo: { full_name: `${parameters.owner}/${parameters.repo}` } },
          base: { ref: String(parameters.base) }, requested_reviewers: [], requested_teams: [],
        });
        return { number: 42 };
      case "POST /repos/{owner}/{repo}/issues":
        return { number: (nextId += 1) };
      case "POST /repos/{owner}/{repo}/check-runs":
        return { id: 99 };
      case "POST /repos/{owner}/{repo}/code-scanning/sarifs":
        if (state.sarifStatus && state.sarifStatus >= 400) throw httpError(state.sarifStatus);
        return { id: "sarif-1" };
      default:
        return {};
    }
  });
}

export type FakeApi = ReturnType<typeof fakeApi>;

export const routes = (client: FakeApi) => client.calls.map((call) => call.route);
export const writes = (client: FakeApi) => client.calls.filter((call) => !call.route.startsWith("GET"));
export const callsTo = (client: FakeApi, route: string) => client.calls.filter((call) => call.route === route);

export const WORKFLOW = ".github/workflows/ci.yml";
export const MISSING_TIMEOUT = "on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n";
export const CLEAN = "on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n    steps:\n      - run: echo hi\n";
/** Only the job-timeout rule, as an error, so tests are independent of the rest of the preset. */
export const TIMEOUT_ONLY = "extends: []\nrules:\n  workflow/job-timeout: error\n";
