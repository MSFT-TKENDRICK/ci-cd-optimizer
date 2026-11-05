import { CONFIG_PATHS, parseConfigText, type ConfigProblem, type LintConfig } from "../lint/config.js";
import { selectInventory, truncateContent, type LoadedInput } from "../lint/inventory.js";
import { allRules } from "../lint/rules/index.js";
import type { ChangeContext, SourceFile } from "../lint/types.js";
import type { GitHubClient, RepoRef } from "./client.js";
import { readFileAt } from "./git.js";
import { mapLimit } from "../utils.js";

export interface RepositorySnapshot {
  input: LoadedInput;
  /** Branch or ref that was read. */
  ref: string;
  /** Commit the snapshot was taken from (base for fix commits). */
  sha: string;
}

export async function defaultBranch(client: GitHubClient, repo: RepoRef, expectedRepositoryId?: number): Promise<string> {
  const response = await client.request("GET /repos/{owner}/{repo}", { ...repo });
  const metadata = response.data as { default_branch: string; id?: unknown };
  if (expectedRepositoryId !== undefined &&
      (!Number.isSafeInteger(expectedRepositoryId) || expectedRepositoryId <= 0 || metadata.id !== expectedRepositoryId)) {
    throw new Error("Repository identity changed since the event was recorded");
  }
  return metadata.default_branch;
}

export interface RemoteConfig {
  config: LintConfig;
  path?: string;
  problems: ConfigProblem[];
}

/** Reads `.github/ci-cd-optimizer.yml` from a ref (always the base branch, so pull requests cannot change policy). */
export async function loadRemoteConfig(client: GitHubClient, repo: RepoRef, ref: string): Promise<RemoteConfig> {
  for (const path of CONFIG_PATHS) {
    const text = await readFileAt(client, repo, path, ref);
    if (text === undefined) continue;
    const parsed = parseConfigText(text, allRules, path);
    return { config: parsed.config, path, problems: parsed.problems };
  }
  const parsed = parseConfigText("", allRules);
  return { config: parsed.config, problems: [] };
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

/**
 * Loads the analysis input for a repository through the REST API (one recursive tree call plus one blob call per
 * selected file), so remote repositories can be linted without a checkout.
 */
export async function loadRepositorySnapshot(
  client: GitHubClient,
  repo: RepoRef,
  options: {
    ref: string; config: Pick<LintConfig, "ignorePaths" | "limits">; change?: ChangeContext; concurrency?: number;
    /** Optional narrower inventory, applied before selection limits and blob reads. */
    pathFilter?: (path: string) => boolean;
  },
): Promise<RepositorySnapshot> {
  const commit = await client.request("GET /repos/{owner}/{repo}/commits/{ref}", { ...repo, ref: options.ref });
  const commitData = commit.data as { sha: string; commit: { tree: { sha: string } } };
  const tree = await client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { ...repo, tree_sha: commitData.commit.tree.sha, recursive: "1" });
  const treeData = tree.data as { tree: TreeEntry[]; truncated?: boolean };
  const blobs = new Map(treeData.tree.filter((entry) => entry.type === "blob" && (!options.pathFilter || options.pathFilter(entry.path))).map((entry) => [entry.path, entry]));
  const selection = selectInventory(
    [...blobs.values()].map((entry) => ({ path: entry.path, ...(entry.size !== undefined ? { size: entry.size } : {}) })),
    options.config,
  );
  const truncated = new Set(selection.truncated);
  const files: SourceFile[] = await mapLimit(selection.paths, options.concurrency ?? 8, async (path) => {
    if (path.endsWith(".lockb")) return { path, content: "" };
    const blob = await client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", { ...repo, file_sha: (blobs.get(path) as TreeEntry).sha });
    const data = blob.data as { content: string; encoding: string };
    const content = data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : data.content;
    return { path, content: truncated.has(path) ? truncateContent(content) : content };
  });
  return {
    ref: options.ref,
    sha: commitData.sha,
    input: {
      files,
      mode: "repository",
      inventoryComplete: selection.complete && treeData.truncated !== true,
      truncated: selection.truncated,
      ...(options.change ? { change: options.change } : {}),
    },
  };
}
