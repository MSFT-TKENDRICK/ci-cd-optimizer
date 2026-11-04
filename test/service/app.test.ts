import { describe, expect, it } from "vitest";
import { installationRepos, pushNeedsScan, rerequestedPullRequest } from "../../src/app.js";

const push = (files: string[][], overrides: Record<string, unknown> = {}) => ({
  ref: "refs/heads/main",
  repository: { default_branch: "main" },
  commits: files.map((modified) => ({ added: [], modified, removed: [] })),
  ...overrides,
});

describe("app event routing", () => {
  it("scans pushes to the default branch that touch CI/CD files", () => {
    expect(pushNeedsScan(push([["src/index.ts"], [".github/workflows/ci.yml"]]))).toBe(true);
    expect(pushNeedsScan(push([["Dockerfile"]]))).toBe(true);
    expect(pushNeedsScan(push([[".github/ci-cd-optimizer.yml"]]))).toBe(true);
    expect(pushNeedsScan(push([["src/index.ts", "README.md"]]))).toBe(false);
  });

  it("ignores other branches and branch deletions", () => {
    expect(pushNeedsScan(push([["Dockerfile"]], { ref: "refs/heads/feature" }))).toBe(false);
    expect(pushNeedsScan(push([["Dockerfile"]], { ref: "refs/tags/v1" }))).toBe(false);
    expect(pushNeedsScan(push([], { deleted: true }))).toBe(false);
  });

  it("scans when the push payload's file list may be incomplete", () => {
    expect(pushNeedsScan(push([]))).toBe(true);
    expect(pushNeedsScan(push(Array.from({ length: 20 }, () => ["src/a.ts"])))).toBe(true);
  });

  it("maps a re-requested optimizer check to its pull request", () => {
    const pullRequests = [
      { number: 1, head: { sha: "other" }, base: { ref: "main", sha: "b1" } },
      { number: 2, head: { sha: "head" }, base: { ref: "main", sha: "b2" } },
    ];
    expect(rerequestedPullRequest({ name: "CI/CD Optimizer", head_sha: "head", pull_requests: pullRequests })).toEqual({ number: 2, headSha: "head", baseRef: "main", baseSha: "b2" });
    expect(rerequestedPullRequest({ name: "CI/CD Telemetry (CI)", head_sha: "head", pull_requests: pullRequests })).toBeUndefined();
    expect(rerequestedPullRequest({ name: "CI/CD Optimizer", head_sha: "head", pull_requests: [] })).toBeUndefined();
  });

  it("parses installation repositories", () => {
    expect(installationRepos([{ full_name: "acme/web" }, { full_name: "bad" }])).toEqual([{ owner: "acme", repo: "web" }]);
    expect(installationRepos(undefined)).toEqual([]);
  });
});
