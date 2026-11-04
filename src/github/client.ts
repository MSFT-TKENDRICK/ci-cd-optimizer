/**
 * Minimal GitHub REST surface used by the planners' executors. `context.octokit` (Probot) and `@octokit/core`
 * satisfy it through `fromOctokit`, and tests use simple in-memory fakes.
 */
export interface GitHubClient {
  request(route: string, parameters?: Record<string, unknown>): Promise<{ status: number; data: unknown }>;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export function fromOctokit(octokit: { request: (...args: never[]) => Promise<unknown> }): GitHubClient {
  const request = octokit.request as unknown as (route: string, parameters?: Record<string, unknown>) => Promise<{ status: number; data: unknown }>;
  return { request: (route, parameters) => request(route, parameters) };
}

export function httpStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

/** Lists up to `maxPages` pages of a paginated list endpoint. */
export async function paginate<T>(client: GitHubClient, route: string, parameters: Record<string, unknown>, maxPages = 10): Promise<T[]> {
  const results: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await client.request(route, { ...parameters, per_page: 100, page });
    const data = response.data as T[];
    results.push(...data);
    if (data.length < 100) break;
  }
  return results;
}

export const LABEL_COLORS: Record<string, string> = {
  "cicd-optimizer": "0e8a16",
  "severity:error": "b60205",
  "severity:warn": "fbca04",
  "severity:info": "c5def5",
  "alert:duration": "d93f0b",
  "copilot:ready": "8250df",
  dependencies: "0366d6",
};

function colorFor(label: string): string {
  if (LABEL_COLORS[label]) return LABEL_COLORS[label] as string;
  if (label.startsWith("ruleset:")) return "1d76db";
  if (label.startsWith("impact:")) return "5319e7";
  if (label.startsWith("recipe:")) return "006b75";
  return "ededed";
}

/** Creates any missing labels (422 = already exists, which is fine under concurrency). */
export async function ensureLabels(client: GitHubClient, repo: RepoRef, labels: readonly string[]): Promise<void> {
  if (labels.length === 0) return;
  const existing = new Set(
    (await paginate<{ name: string }>(client, "GET /repos/{owner}/{repo}/labels", { ...repo }, 5)).map((label) => label.name.toLowerCase()),
  );
  for (const name of new Set(labels)) {
    if (existing.has(name.toLowerCase())) continue;
    try {
      await client.request("POST /repos/{owner}/{repo}/labels", { ...repo, name, color: colorFor(name) });
    } catch (error) {
      if (httpStatus(error) !== 422) throw error;
    }
  }
}
