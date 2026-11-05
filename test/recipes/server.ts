import type { CheckRunSummary } from "../../src/recipes/compat.js";
import { fakeClient, httpError } from "../experiments/fixtures.js";

const base64 = (text: string) => Buffer.from(text).toString("base64");

export interface FakeRepository {
  files?: Record<string, string>;
  config?: string;
  manifest?: string;
  issues?: unknown[];
  head?: { sha: string; ref: string };
  checkRuns?: CheckRunSummary[];
  pulls?: unknown[];
  pullFiles?: unknown[];
}

/** A fake GitHub REST API for one repository, routing every endpoint the recipe flows use. */
export function server(state: FakeRepository = {}) {
  const files = state.files ?? {};
  const paths = Object.keys(files);
  const edits = new Map<number, Record<string, unknown>>();
  return fakeClient((route, parameters) => {
    switch (route) {
      case "GET /repos/{owner}/{repo}":
        return { default_branch: "main", node_id: "repository-node" };
      case "GET /repos/{owner}/{repo}/contents/{path}":
        if (parameters.path === ".github/ci-cd-optimizer.yml" && state.config !== undefined) return { content: base64(state.config), encoding: "base64" };
        if (String(parameters.path).startsWith("experiments/") && state.manifest !== undefined) return { content: base64(state.manifest), encoding: "base64" };
        throw httpError(404);
      case "GET /repos/{owner}/{repo}/commits/{ref}":
        return { sha: "base-sha", commit: { tree: { sha: "root" } } };
      case "GET /repos/{owner}/{repo}/git/trees/{tree_sha}":
        return { tree: paths.map((path, index) => ({ path, type: "blob", sha: `blob-${index}`, size: (files[path] as string).length })), truncated: false };
      case "GET /repos/{owner}/{repo}/git/blobs/{file_sha}":
        return { content: base64(files[paths[Number(String(parameters.file_sha).slice(5))] as string] as string), encoding: "base64" };
      case "GET /repos/{owner}/{repo}/issues":
        return state.issues ?? [];
      case "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        const number = Number(parameters.pull_number);
        const issue = state.issues?.find((entry) => typeof entry === "object" && entry !== null && "number" in entry && entry.number === number);
        return {
          state: "open", ...(typeof issue === "object" ? issue : {}), ...edits.get(number),
          head: { ...(state.head ?? { sha: "head-sha", ref: "cicd-optimizer/recipe-job-timeouts" }), repo: { full_name: `${parameters.owner}/${parameters.repo}` } },
        };
      }
      case "PATCH /repos/{owner}/{repo}/pulls/{pull_number}":
        edits.set(Number(parameters.pull_number), { ...edits.get(Number(parameters.pull_number)), ...parameters });
        return {};
      case "POST /graphql": {
        const variables = parameters.variables as { input: { refUpdates: Array<{ name: string; afterOid: string }> } };
        for (const update of variables.input.refUpdates) state.head = { ref: update.name.slice("refs/heads/".length), sha: update.afterOid };
        return { data: { updateRefs: { clientMutationId: null } } };
      }
      case "GET /repos/{owner}/{repo}/pulls":
        return state.pulls ?? [];
      case "GET /repos/{owner}/{repo}/pulls/{pull_number}/files":
        return state.pullFiles ?? [];
      case "GET /repos/{owner}/{repo}/labels":
        return [];
      case "GET /repos/{owner}/{repo}/git/commits/{commit_sha}":
        return { tree: { sha: "base-tree" } };
      case "GET /repos/{owner}/{repo}/git/ref/{ref}":
        throw httpError(404);
      case "POST /repos/{owner}/{repo}/git/trees":
        return { sha: "new-tree" };
      case "POST /repos/{owner}/{repo}/git/commits":
        return { sha: "new-commit" };
      case "POST /repos/{owner}/{repo}/pulls":
        return { number: 42 };
      case "POST /repos/{owner}/{repo}/issues":
        return { number: 43 };
      case "GET /repos/{owner}/{repo}/commits/{ref}/check-runs":
        return { check_runs: state.checkRuns ?? [] };
      default:
        return {};
    }
  });
}
