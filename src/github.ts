import type { Context } from "probot";
import { defaultConfig, parseConfig } from "./config.js";
import type { OptimizerConfig, RepositoryFile } from "./types.js";

const relevantPath =
  /(^|\/)(Dockerfile(?:\.[^/]+)?|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|poetry\.lock|requirements[^/]*\.txt|go\.mod|go\.sum|pom\.xml|build\.gradle(?:\.kts)?|gradle\.properties|Cargo\.toml|Cargo\.lock|.*\.(?:csproj|sln)|\.npmrc|turbo\.json|nx\.json|WORKSPACE|MODULE\.bazel|BUILD(?:\.bazel)?)$|^\.github\/workflows\/.*\.ya?ml$|^\.github\/ci-cd-optimizer\.ya?ml$/i;

type PullRequestContext = Context<"pull_request.opened" | "pull_request.synchronize" | "pull_request.reopened" | "pull_request.ready_for_review">;

interface GitTreeEntry {
  path?: string;
  type?: string;
  sha?: string;
  size?: number;
}

interface GitTreeResponse {
  tree: GitTreeEntry[];
  truncated?: boolean;
}

export async function loadRepositoryFiles(
  context: PullRequestContext,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ files: RepositoryFile[]; config: OptimizerConfig; truncated: boolean }> {
  const treeResponse = await context.octokit.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    {
    owner,
    repo,
    tree_sha: ref,
    recursive: "true",
    },
  );
  const tree = treeResponse.data as GitTreeResponse;

  const configEntry = tree.tree.find(
    (entry) =>
      entry.type === "blob" &&
      (entry.path === ".github/ci-cd-optimizer.yml" ||
        entry.path === ".github/ci-cd-optimizer.yaml"),
  );

  let config = defaultConfig;
  if (configEntry?.sha && configEntry.path) {
    const configFile = await loadBlob(context, owner, repo, configEntry.path, configEntry.sha);
    if (configFile) config = parseConfig(configFile);
  }

  const candidates = tree.tree
    .filter(
      (entry): entry is GitTreeEntry & { path: string; sha: string } =>
        entry.type === "blob" &&
        typeof entry.path === "string" &&
        typeof entry.sha === "string" &&
        relevantPath.test(entry.path) &&
        (entry.size ?? 0) <= config.maxFileBytes,
    )
    .slice(0, config.maxFiles);

  const files = (
    await Promise.all(
      candidates.map((entry) => loadBlob(context, owner, repo, entry.path, entry.sha)),
    )
  ).filter((file): file is RepositoryFile => file !== undefined);

  return {
    files,
    config,
    truncated: Boolean(tree.truncated) || candidates.length >= config.maxFiles,
  };
}

async function loadBlob(
  context: PullRequestContext,
  owner: string,
  repo: string,
  path: string,
  sha: string,
): Promise<RepositoryFile | undefined> {
  const response = await context.octokit.request(
    "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
    { owner, repo, file_sha: sha },
  );
  const blob = response.data as { encoding: string; content: string };
  if (blob.encoding !== "base64") return undefined;
  const content = Buffer.from(blob.content, "base64").toString("utf8");
  return { path, content, size: Buffer.byteLength(content) };
}
