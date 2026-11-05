import { describe, expect, it } from "vitest";
import type { GitHubClient } from "../../src/github/client.js";
import { DEFAULT_CONFIG } from "../../src/lint/config.js";
import { applyFixActions, dismissalsFrom, handleFixCommands, IGNORED_LABEL, listManagedPullRequests, type ManagedPullRequest } from "../../src/fixes/github.js";
import { planFixPullRequests, type FixChange } from "../../src/fixes/plan.js";
import { marker, parseMarker } from "../../src/issues/markers.js";

interface Call {
  route: string;
  parameters: Record<string, unknown>;
}

function fakeClient(handler: (route: string, parameters: Record<string, unknown>) => unknown = () => ({})): GitHubClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async request(route, parameters = {}) {
      calls.push({ route, parameters });
      return { status: 200, data: handler(route, parameters) };
    },
  };
}

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const repo = { owner: "acme", repo: "widgets" };
const change: FixChange = {
  group: "hermeticity",
  branch: "cicd-optimizer/hermeticity",
  files: [{ path: ".github/workflows/ci.yml", content: "runs-on: ubuntu-24.04\n" }],
  applied: [],
  rules: ["hermeticity/pin-runner"],
  signature: "sig",
};

function managed(overrides: Partial<ManagedPullRequest> = {}): ManagedPullRequest {
  return {
    number: 7,
    state: "open",
    merged: false,
    group: "hermeticity",
    branch: "cicd-optimizer/hermeticity",
    title: "t",
    body: `${marker("fix", "group:hermeticity", { signature: "sig", rules: "hermeticity/pin-runner,hermeticity/pin-actions" })}\nbody`,
    labels: ["cicd-optimizer"],
    rules: ["hermeticity/pin-runner", "hermeticity/pin-actions"],
    ignoredRules: [],
    ignoredGroup: false,
    ...overrides,
  };
}

describe("listManagedPullRequests", () => {
  it("recovers only matching same-repository PRs, including declined changes and custom prefixes", async () => {
    const base = {
      number: 8, title: "recover", body: marker("fix", "group:hermeticity", { signature: "sig", commit: "bot-commit" }),
      state: "open", labels: [], head: { ref: "custom/hermeticity", sha: "human-commit", repo: { full_name: "ACME/widgets" } }, base: { ref: "main" },
    };
    const client = fakeClient((route) => route.endsWith("/issues") ? [] : [
      base,
      { ...base, number: 9, state: "closed" },
      { ...base, number: 10, head: { ...base.head, repo: { full_name: "fork/widgets" } } },
      { ...base, number: 11, base: { ref: "release" } },
      { ...base, number: 12, head: { ...base.head, ref: "someone-elses-branch" } },
      { ...base, number: 13, body: marker("fix", "group:other", { signature: "sig", commit: "bot-commit" }) },
      { ...base, number: 14, body: marker("fix", "group:hermeticity", { signature: "sig" }) },
      { ...base, number: 15, body: "<!-- cicd-optimizer:fix fingerprint=%ZZ -->" },
    ]);
    const prs = await listManagedPullRequests(client, repo, { baseBranch: "main", branchPrefix: "custom/", groups: ["hermeticity"] });
    expect(prs.map((pr) => pr.number)).toEqual([8, 9]);
    expect(prs[0]).toMatchObject({ commitSha: "bot-commit", headSha: "human-commit", branch: "custom/hermeticity", labels: [] });
    const plan = planFixPullRequests([change], prs, { openPullRequestsLimit: 5, labels: ["cicd-optimizer"] });
    expect(plan.actions).toEqual([{ type: "metadata", group: "hermeticity", number: 8, labels: ["cicd-optimizer"], reviewers: [] }]);
    expect(plan.skipped).toEqual([{ reason: "edited", group: "hermeticity", number: 8 }]);
    expect(planFixPullRequests([change], prs.slice(1), { openPullRequestsLimit: 5 }).skipped[0]?.reason).toBe("declined");
    expect(client.calls[1]?.parameters).toMatchObject({ head: "acme:custom/hermeticity", base: "main", state: "all" });
  });

  it("propagates discovery failures rather than treating them as an empty result", async () => {
    const client = fakeClient((route) => {
      if (route.endsWith("/issues")) return [];
      throw httpError(403);
    });
    await expect(listManagedPullRequests(client, repo, { baseBranch: "main", branchPrefix: "ci/", groups: ["hermeticity"] })).rejects.toThrow("403");
  });

  it.each([999, 1000])("fails closed at the discovery limit (%s results)", async (count) => {
    const client = fakeClient((route, parameters) => {
      if (route.endsWith("/issues")) return [];
      const start = (Number(parameters.page) - 1) * 100;
      return Array.from({ length: Math.min(100, count - start) }, (_, index) => ({
        number: start + index + 1, title: "historic fix", state: "closed",
        body: marker("fix", "group:hermeticity", { signature: "s", commit: "c" }),
        head: { ref: change.branch, sha: "c", repo: { full_name: "acme/widgets" } }, base: { ref: "main" },
      }));
    });
    const result = listManagedPullRequests(client, repo, { baseBranch: "main", branchPrefix: "cicd-optimizer/", groups: ["hermeticity"] });
    if (count === 1000) await expect(result).rejects.toThrow("1000-result limit");
    else expect(await result).toHaveLength(999);
  });

  it("finds fix pull requests by marker and reads the head of open ones", async () => {
    const client = fakeClient((route) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/issues"))
        return [
          { number: 1, title: "a", state: "open", body: marker("fix", "group:caching", { signature: "s", commit: "c1", rules: "caching/a,caching/b" }), pull_request: {} },
          { number: 2, title: "b", state: "closed", body: marker("fix", "group:workflow", { ignored: "workflow/x" }), pull_request: { merged_at: null }, labels: [{ name: IGNORED_LABEL }] },
          { number: 3, title: "issue", state: "open", body: marker("finding", "rule:x") },
          { number: 4, title: "other pr", state: "open", body: "no marker", pull_request: {} },
        ];
      if (route.startsWith("GET /repos/{owner}/{repo}/pulls/{pull_number}")) return { head: { sha: "c2", ref: "cicd-optimizer/caching" } };
      return {};
    });
    const prs = await listManagedPullRequests(client, repo);
    expect(prs.map((pr) => pr.number)).toEqual([1, 2]);
    expect(prs[0]).toMatchObject({ group: "caching", signature: "s", commitSha: "c1", headSha: "c2", branch: "cicd-optimizer/caching", rules: ["caching/a", "caching/b"] });
    expect(prs[1]).toMatchObject({ state: "closed", merged: false, ignoredRules: ["workflow/x"] });
    expect(client.calls.filter((call) => call.route.includes("/pulls/"))).toHaveLength(1);
    expect(dismissalsFrom(prs).rules).toEqual(new Set(["workflow/x"]));
  });
});

describe("applyFixActions", () => {
  it("commits through the Git Data API, pushes the branch, and opens a labeled pull request", async () => {
    let body = "";
    const client = fakeClient((route, parameters) => {
      if (route === "GET /repos/{owner}/{repo}/pulls") return [];
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { body };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers") return { users: [], teams: [] };
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") throw httpError(404);
      if (route.startsWith("GET /repos/{owner}/{repo}/labels")) return [];
      if (route.startsWith("GET /repos/{owner}/{repo}/git/commits")) return { tree: { sha: "base-tree" } };
      if (route.startsWith("POST /repos/{owner}/{repo}/git/trees")) return { sha: "new-tree" };
      if (route.startsWith("POST /repos/{owner}/{repo}/git/commits")) return { sha: "new-commit" };
      if (route === "POST /repos/{owner}/{repo}/pulls") { body = String(parameters.body); return { number: 42 }; }
      return {};
    });
    const config = { ...DEFAULT_CONFIG.fixes, labels: ["ci"], reviewers: ["octocat", "acme/platform"] };
    const applied = await applyFixActions(client, repo, [{ type: "create", change }], { baseBranch: "main", baseSha: "base", config, rules: [], existing: [] });
    expect(applied).toEqual([{ action: { type: "create", change }, number: 42, commitSha: "new-commit" }]);
    const routes = client.calls.map((call) => call.route);
    expect(routes).toContain("POST /repos/{owner}/{repo}/git/refs");
    const tree = client.calls.find((call) => call.route === "POST /repos/{owner}/{repo}/git/trees");
    expect(tree?.parameters).toMatchObject({ base_tree: "base-tree", tree: [{ path: ".github/workflows/ci.yml", mode: "100644", type: "blob" }] });
    const pull = client.calls.find((call) => call.route === "POST /repos/{owner}/{repo}/pulls");
    expect(pull?.parameters).toMatchObject({ head: "cicd-optimizer/hermeticity", base: "main", draft: false });
    expect(parseMarker(pull?.parameters.body as string)?.attributes.commit).toBe("new-commit");
    expect(client.calls.find((call) => call.route.endsWith("/labels") && call.route.startsWith("POST /repos/{owner}/{repo}/issues"))?.parameters.labels).toEqual([
      "cicd-optimizer",
      "ci",
    ]);
    expect(client.calls.find((call) => call.route.startsWith("POST") && call.route.endsWith("requested_reviewers"))?.parameters).toMatchObject({ reviewers: ["octocat"], team_reviewers: ["platform"] });
    expect(parseMarker(body)?.attributes.pendingReviewers).toBe("octocat,acme/platform");
    expect(parseMarker(client.calls.at(-1)?.parameters.body as string)?.attributes.pendingReviewers).toBeUndefined();
  });

  it("refuses to push a create over an existing PR even when its marker or base differs", async () => {
    const client = fakeClient((route) => route.endsWith("/labels") ? [] : [{
      number: 99, body: "unrelated", head: { ref: change.branch, repo: { full_name: "acme/widgets" } }, base: { ref: "release" },
    }]);
    await expect(applyFixActions(client, repo, [{ type: "create", change }], {
      baseBranch: "main", baseSha: "base", config: DEFAULT_CONFIG.fixes, rules: [], existing: [],
    })).rejects.toThrow("Its branch was not changed");
    expect(client.calls.some((call) => call.route.includes("/git/"))).toBe(false);
  });

  it("does not overwrite an existing branch with no recognized PR", async () => {
    const client = fakeClient((route) => {
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { object: { sha: "human" } };
      return [];
    });
    await expect(applyFixActions(client, repo, [{ type: "create", change }], {
      baseBranch: "main", baseSha: "base", config: DEFAULT_CONFIG.fixes, rules: [], existing: [],
    })).rejects.toThrow("unrecognized or modified branch");
    expect(client.calls.some((call) => !call.route.startsWith("GET") && call.route.includes("/git/"))).toBe(false);
  });

  it("does not force-push a branch created by someone else after preflight", async () => {
    const client = fakeClient((route) => {
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") throw httpError(404);
      if (route === "POST /repos/{owner}/{repo}/git/refs") throw httpError(422);
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") return { tree: { sha: "tree" } };
      if (route.startsWith("POST /repos/{owner}/{repo}/git/")) return { sha: "commit" };
      return [];
    });
    await expect(applyFixActions(client, repo, [{ type: "create", change }], {
      baseBranch: "main", baseSha: "base", config: DEFAULT_CONFIG.fixes, rules: [], existing: [],
    })).rejects.toThrow("422");
    expect(client.calls.some((call) => call.route.startsWith("PATCH"))).toBe(false);
    expect(client.calls.some((call) => call.route === "POST /repos/{owner}/{repo}/pulls")).toBe(false);
  });

  it("can reuse an unchanged bot branch from a closed PR for a new change", async () => {
    const client = fakeClient((route) => {
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { object: { sha: "old-bot" } };
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") return { tree: { sha: "tree" } };
      if (route === "POST /repos/{owner}/{repo}/git/refs") throw httpError(422);
      if (route.startsWith("POST /repos/{owner}/{repo}/git/")) return { sha: "new-bot" };
      if (route === "POST /repos/{owner}/{repo}/pulls") return { number: 42 };
      return [];
    });
    await applyFixActions(client, repo, [{ type: "create", change }], {
      baseBranch: "main", baseSha: "base", config: DEFAULT_CONFIG.fixes, rules: [],
      existing: [managed({ state: "closed", commitSha: "old-bot" })],
    });
    expect(client.calls.find((call) => call.route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}")?.parameters)
      .toMatchObject({ sha: "new-bot", force: true });
  });

  it("force-updates an existing branch and refreshes the pull request on update", async () => {
    const client = fakeClient((route) => {
      if (route === "POST /repos/{owner}/{repo}/git/refs") throw httpError(422);
      if (route.startsWith("GET /repos/{owner}/{repo}/git/commits")) return { tree: { sha: "t" } };
      if (route.startsWith("POST /repos/{owner}/{repo}/git")) return { sha: "c3" };
      return {};
    });
    const existing = [managed({ ignoredRules: ["hermeticity/pin-actions"] })];
    await applyFixActions(client, repo, [{ type: "update", number: 7, change }], { baseBranch: "main", baseSha: "base", config: DEFAULT_CONFIG.fixes, rules: [], existing });
    expect(client.calls.find((call) => call.route.startsWith("PATCH /repos/{owner}/{repo}/git/refs"))?.parameters).toMatchObject({
      ref: "heads/cicd-optimizer/hermeticity",
      sha: "c3",
      force: true,
    });
    const patch = client.calls.find((call) => call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}");
    expect(parseMarker(patch?.parameters.body as string)?.attributes.ignored).toBe("hermeticity/pin-actions");
  });

  it("closes stale pull requests with a comment and deletes the branch", async () => {
    const client = fakeClient((route) => {
      if (route.startsWith("DELETE")) throw httpError(422);
      return {};
    });
    await applyFixActions(client, repo, [{ type: "close", number: 7, group: "a", branch: "cicd-optimizer/a", comment: "bye" }], {
      baseBranch: "main",
      baseSha: "base",
      config: DEFAULT_CONFIG.fixes,
      rules: [],
      existing: [],
    });
    expect(client.calls.map((call) => call.route)).toEqual([
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
    ]);
  });
});

describe("handleFixCommands", () => {
  it("records ignored rules in the marker and label, and asks for a recompute", async () => {
    const client = fakeClient((route) => (route.startsWith("GET") ? [] : {}));
    const pr = managed();
    const outcome = await handleFixCommands(client, repo, pr, [{ type: "ignore-rule", rule: "hermeticity/pin-actions" }]);
    expect(outcome.recompute).toBe(true);
    expect(pr.ignoredRules).toEqual(["hermeticity/pin-actions"]);
    expect(parseMarker(pr.body)?.attributes).toMatchObject({ ignored: "hermeticity/pin-actions", signature: "sig" });
    expect(pr.body.endsWith("\nbody")).toBe(true);
    expect(dismissalsFrom([pr]).rules).toEqual(new Set(["hermeticity/pin-actions"]));
    expect(client.calls.at(-1)?.route).toBe("POST /repos/{owner}/{repo}/issues/{issue_number}/comments");
  });

  it("ignores every rule in the pull request when none is named, and ignoring the group closes it", async () => {
    const client = fakeClient((route) => (route.startsWith("GET") ? [] : {}));
    const pr = managed();
    await handleFixCommands(client, repo, pr, [{ type: "ignore-rule" }]);
    expect(pr.ignoredRules).toEqual(["hermeticity/pin-runner", "hermeticity/pin-actions"]);
    const group = managed();
    const outcome = await handleFixCommands(client, repo, group, [{ type: "ignore-group" }]);
    expect(outcome.recompute).toBe(false);
    expect(group.state).toBe("closed");
    expect(dismissalsFrom([group]).groups).toEqual(new Set(["hermeticity"]));
    expect(client.calls.some((call) => call.route.startsWith("DELETE /repos/{owner}/{repo}/git/refs"))).toBe(true);
  });

  it("queues rebase and recreate for the follow-up fix run", async () => {
    const client = fakeClient();
    const outcome = await handleFixCommands(client, repo, managed(), [{ type: "rebase" }, { type: "recreate" }]);
    expect(outcome).toMatchObject({ rebase: new Set(["hermeticity"]), recreate: new Set(["hermeticity"]), recompute: true });
  });
});
