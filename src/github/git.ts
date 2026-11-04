import type { SourceFile } from "../lint/types.js";
import { httpStatus, type GitHubClient, type RepoRef } from "./client.js";

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

/** Points `branch` at `sha`, creating it or force-updating it. */
export async function pushBranch(client: GitHubClient, repo: RepoRef, branch: string, sha: string): Promise<void> {
  try {
    await client.request("POST /repos/{owner}/{repo}/git/refs", { ...repo, ref: `refs/heads/${branch}`, sha });
  } catch (error) {
    if (httpStatus(error) !== 422) throw error;
    await client.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", { ...repo, ref: `heads/${branch}`, sha, force: true });
  }
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
