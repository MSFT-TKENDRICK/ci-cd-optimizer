import { fakeClient, httpError } from "../experiments/fixtures.js";
import type { PullFile } from "../../src/review/intake.js";
import { parseProjectText, type Project } from "../../src/review/project.js";

export const REGISTRY = { owner: "MSFT-TKENDRICK", repo: "ci-cd-optimizer" };
export const REGISTRY_NAME = "MSFT-TKENDRICK/ci-cd-optimizer";
export const TARGET = { owner: "octo-org", repo: "widget" };
export const TARGET_ID = 4242;
export const TARGET_SHA = "1".repeat(40);
export const TREE_SHA = "2".repeat(40);
export const HEAD_SHA = "3".repeat(40);
export const BASE_SHA = "4".repeat(40);
export const NEW_HEAD_SHA = "5".repeat(40);
export const PROJECT_PATH = "projects/widget/project.yaml";

export const PROJECT_YAML = `name: widget
main_repo: https://github.com/octo-org/widget
repository_id: ${TARGET_ID}
primary_contact: octocat
auto_ccs: [hubot]
`;

/** The strict preset enables `hermeticity/pin-actions`, which the default preset does not. */
export const STRICT_PROJECT_YAML = `${PROJECT_YAML}preset: strict
`;

export const CONSENT_YAML = `registry: MSFT-TKENDRICK/ci-cd-optimizer
project: widget
contacts: [octocat, hubot]
`;

/** A workflow with an ordinary finding (no timeout) and, under the strict preset, a security-sensitive one (an unpinned action). */
export const WORKFLOW = `name: ci
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: echo hi
`;

export function project(text = PROJECT_YAML, directory = "widget"): Project {
  const parsed = parseProjectText(text, directory);
  if (!parsed.project) throw new Error(parsed.problems.join("\n"));
  return parsed.project;
}

export const contents = (text: string) => ({ type: "file", size: Buffer.byteLength(text), encoding: "base64", content: Buffer.from(text).toString("base64") });

export interface PullData {
  number?: number;
  state?: string;
  changed_files?: number;
  user?: { login: string; type: string };
  head?: { sha: string; repo?: { name: string; owner: { login: string } } };
  base?: { sha: string };
}

export interface World {
  metadata?: Record<string, unknown> | "missing";
  /** Consent file text on the target's default branch; undefined means it does not exist. */
  consent?: string | undefined;
  /** Target repository files reviewed through the tree API. */
  files?: Record<string, string>;
  /** The target's .github/ci-cd-optimizer.yml. */
  config?: string;
  commitError?: Error;
  /** Pull request responses returned in order; the last one repeats. */
  pulls?: PullData[];
  /** Pull request responses by number, for flows that read several pull requests; overrides `pulls`. */
  pullsByNumber?: Record<number, PullData>;
  pullFiles?: PullFile[];
  /** Files of non-target repositories (the registry and forks) keyed by `<owner>/<repo>@<ref>:<path>`. */
  registryFiles?: Record<string, string>;
  openPulls?: PullData[];
  otherPullFiles?: Record<number, PullFile[]>;
  comments?: Array<{ id: number; body: string; user: { login: string; type: string } }>;
}

export function pull(overrides: Partial<PullData> = {}): PullData {
  return {
    number: 7,
    state: "open",
    changed_files: 1,
    user: { login: "octocat", type: "User" },
    head: { sha: HEAD_SHA, repo: { name: "ci-cd-optimizer", owner: { login: "octocat" } } },
    base: { sha: BASE_SHA },
    ...overrides,
  };
}

const sameRepo = (parameters: Record<string, unknown>, repo: { owner: string; repo: string }) =>
  String(parameters.owner).toLowerCase() === repo.owner.toLowerCase() && String(parameters.repo).toLowerCase() === repo.repo.toLowerCase();

/** A fake GitHub API holding one registry repository and one consenting target repository. */
export function world(spec: World = {}) {
  const state = { ...{ consent: CONSENT_YAML, files: { ".github/workflows/ci.yml": WORKFLOW } }, ...spec };
  let pullIndex = 0;
  return fakeClient((route, parameters) => {
    switch (route) {
      case "GET /repositories/{repository_id}": {
        if (state.metadata === "missing") throw httpError(404);
        return {
          id: TARGET_ID,
          full_name: "octo-org/widget",
          private: false,
          visibility: "public",
          fork: false,
          archived: false,
          disabled: false,
          default_branch: "main",
          ...state.metadata,
        };
      }
      case "GET /repos/{owner}/{repo}/commits/{ref}":
        if (state.commitError) throw state.commitError;
        return { sha: TARGET_SHA, commit: { tree: { sha: TREE_SHA } } };
      case "GET /repos/{owner}/{repo}/contents/{path}": {
        const path = String(parameters.path);
        if (sameRepo(parameters, TARGET)) {
          if (parameters.ref !== TARGET_SHA) throw new Error(`unexpected ref ${String(parameters.ref)}`);
          if (path === ".github/ci-cd-optimizer-review.yml" && state.consent !== undefined) return contents(state.consent);
          if (path === ".github/ci-cd-optimizer.yml" && state.config !== undefined) return contents(state.config);
          throw httpError(404);
        }
        const key = `${String(parameters.owner)}/${String(parameters.repo)}@${String(parameters.ref)}:${path}`.toLowerCase();
        const text = Object.entries(state.registryFiles ?? {}).find(([candidate]) => candidate.toLowerCase() === key)?.[1];
        if (text === undefined) throw httpError(404);
        return contents(text);
      }
      case "GET /repos/{owner}/{repo}/git/trees/{tree_sha}":
        return {
          tree: Object.entries(state.files).map(([path, text]) => ({ path, type: "blob", sha: `blob:${path}`, size: Buffer.byteLength(text) })),
          truncated: false,
        };
      case "GET /repos/{owner}/{repo}/git/blobs/{file_sha}": {
        const path = String(parameters.file_sha).slice("blob:".length);
        return { content: Buffer.from(state.files[path] ?? "").toString("base64"), encoding: "base64" };
      }
      case "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        const byNumber = state.pullsByNumber?.[Number(parameters.pull_number)];
        if (byNumber) return byNumber;
        const pulls = state.pulls ?? [pull()];
        const data = pulls[Math.min(pullIndex, pulls.length - 1)];
        pullIndex += 1;
        return data;
      }
      case "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": {
        const current = (state.pulls ?? [pull()])[0]?.number ?? 7;
        if (parameters.pull_number === current) return state.pullFiles ?? [{ filename: PROJECT_PATH, status: "added" }];
        return state.otherPullFiles?.[Number(parameters.pull_number)] ?? [];
      }
      case "GET /repos/{owner}/{repo}/pulls":
        return state.openPulls ?? [];
      case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments":
        return state.comments ?? [];
      case "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}":
        return {};
      case "POST /repos/{owner}/{repo}/issues/{issue_number}/comments":
        return { id: 99 };
      case "POST /repos/{owner}/{repo}/statuses/{sha}":
        return {};
      default:
        throw new Error(`unexpected route ${route}`);
    }
  });
}

/** Registry files for a submission at the default head SHA. */
export const submitted = (text = PROJECT_YAML, path = PROJECT_PATH) => ({ [`${REGISTRY_NAME}@${HEAD_SHA}:${path}`]: text });

/** Registry files on the base branch. */
export const onBase = (text = PROJECT_YAML, path = PROJECT_PATH) => ({ [`${REGISTRY_NAME}@${BASE_SHA}:${path}`]: text });
