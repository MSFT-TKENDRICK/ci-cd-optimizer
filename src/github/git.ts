import type { SourceFile } from "../lint/types.js";
import { graphql, httpStatus, type GitHubClient, type RepoRef } from "./client.js";

/** Creates a commit on top of `baseSha` with the given full file contents (Git Data API, no checkout needed). */
export async function commitFiles(client: GitHubClient, repo: RepoRef, baseSha: string, files: readonly SourceFile[], message: string): Promise<string> {
  const base = await client.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { ...repo, commit_sha: baseSha });
  const baseTree = (base.data as { tree: { sha: string } }).tree.sha;
  const tree = await client.request("POST /repos/{owner}/{repo}/git/trees", {
    ...repo,
    base_tree: baseTree,
    tree: files.map((file) => ({ path: file.path, mode: "100644", type: "blob", content: file.content })),
  });
  const commit = await client.request("POST /repos/{owner}/{repo}/git/commits", {
    ...repo,
    message,
    tree: (tree.data as { sha: string }).sha,
    parents: [baseSha],
  });
  return (commit.data as { sha: string }).sha;
}

/** Creates a branch without overwriting an existing ref; use updateBranch for conditional rebuilds. */
export async function pushBranch(client: GitHubClient, repo: RepoRef, branch: string, sha: string): Promise<void> {
  await client.request("POST /repos/{owner}/{repo}/git/refs", { ...repo, ref: `refs/heads/${branch}`, sha });
}

/** GitHub enforces beforeOid atomically, even for a non-fast-forward rebuild. Never fall back to an unconditional push. */
export async function updateBranch(client: GitHubClient, repo: RepoRef, branch: string, sha: string, expectedSha: string): Promise<void> {
  if (!expectedSha) throw new Error(`Missing expected head for ${branch}; refusing an unconditional update.`);
  const repository = await client.request("GET /repos/{owner}/{repo}", { ...repo });
  const id = (repository.data as { node_id?: string }).node_id;
  if (!id) throw new Error("GitHub did not return the repository node ID required for an atomic ref update.");
  const result = await graphql(client, `mutation UpdateOptimizerRef($input: UpdateRefsInput!) {
    updateRefs(input: $input) { clientMutationId }
  }`, {
    input: { repositoryId: id, refUpdates: [{ name: `refs/heads/${branch}`, beforeOid: expectedSha, afterOid: sha, force: true }] },
  }) as { updateRefs?: { clientMutationId?: string | null } } | undefined;
  if (!result?.updateRefs) throw new Error(`GitHub did not acknowledge the atomic update of ${branch}.`);
}

export async function deleteBranch(client: GitHubClient, repo: RepoRef, branch: string | undefined): Promise<void> {
  if (!branch) return;
  try {
    await client.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", { ...repo, ref: `heads/${branch}` });
  } catch (error) {
    if (![404, 422].includes(httpStatus(error) ?? 0)) throw error;
  }
}

export async function branchSha(client: GitHubClient, repo: RepoRef, branch: string): Promise<string> {
  const response = await client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { ...repo, ref: `heads/${branch}` });
  return (response.data as { object: { sha: string } }).object.sha;
}

export async function readFileAt(client: GitHubClient, repo: RepoRef, path: string, ref: string): Promise<string | undefined> {
  try {
    const response = await client.request("GET /repos/{owner}/{repo}/contents/{path}", { ...repo, path, ref });
    const data = response.data as { content?: string; encoding?: string };
    if (typeof data.content !== "string") return undefined;
    return data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : data.content;
  } catch (error) {
    if (httpStatus(error) === 404) return undefined;
    throw error;
  }
}
