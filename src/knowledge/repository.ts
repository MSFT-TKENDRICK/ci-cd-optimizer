import type { GitHubClient, RepoRef } from "../github/client.js";
import { validateScope } from "./identity.js";
import type { RepositoryIdentity } from "./types.js";

/** Stable repository identity is obtained from the authenticated API, never inferred from its mutable name. */
export async function loadKnowledgeIdentity(client: GitHubClient, repo: RepoRef, expectedRepositoryId?: number): Promise<RepositoryIdentity> {
  if (expectedRepositoryId !== undefined && (!Number.isSafeInteger(expectedRepositoryId) || expectedRepositoryId <= 0)) {
    throw new Error("Expected repository identity must be a positive safe integer");
  }
  const response = await client.request("GET /repos/{owner}/{repo}", { ...repo });
  const data = response.data as { id?: unknown; html_url?: unknown; name?: unknown; owner?: { login?: unknown } } | undefined;
  if (!Number.isSafeInteger(data?.id) || Number(data?.id) <= 0 ||
      typeof data?.html_url !== "string" || typeof data.name !== "string" || typeof data.owner?.login !== "string") {
    throw new Error("Repository metadata lacks a stable identity for knowledge collection");
  }
  const url = new URL(data.html_url);
  const identity = { host: url.origin, repositoryId: String(data.id), owner: data.owner.login, repo: data.name };
  validateScope(identity);
  if (expectedRepositoryId !== undefined && identity.repositoryId !== String(expectedRepositoryId)) {
    throw new Error("Repository identity changed since the event was recorded");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== `/${identity.owner}/${identity.repo}`) {
    throw new Error("Repository identity URL does not match its metadata");
  }
  return identity;
}
