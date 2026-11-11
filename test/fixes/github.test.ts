import { describe, expect, it } from "vitest";
import type { GitHubClient } from "../../src/github/client.js";
import { DEFAULT_CONFIG } from "../../src/lint/config.js";
import { applyFixActions, dismissalsFrom, handleFixCommands, IGNORED_LABEL, listManagedPullRequests, type ManagedPullRequest } from "../../src/fixes/github.js";
import { planFixPullRequests, type FixChange } from "../../src/fixes/plan.js";
import { marker, parseMarker } from "../../src/issues/markers.js";
import { fakeApi } from "../service/api.js";

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

/** Branch lookups that settle later for earlier groups, so serial, unbounded and completion-ordered callers all differ. */
function branchLookups(groups: readonly string[], failing?: string) {
  const state = { inFlight: 0, peak: 0, started: [] as string[] };
  const client: GitHubClient = {
    async request(route, parameters = {}) {
      if (route === "GET /repos/{owner}/{repo}/issues") return { status: 200, data: [] };
      const index = groups.findIndex((group) => parameters.head === `acme:cicd-optimizer/${group}`);
      const group = groups[index];
      if (route !== "GET /repos/{owner}/{repo}/pulls" || !group) throw new Error(`Unexpected request: ${route}`);
      state.started.push(group);
      if (group === failing) throw httpError(403);
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, (groups.length - index) * 3));
      state.inFlight -= 1;
      return {
        status: 200,
        data: [{
          number: index + 1, title: group, state: "open", labels: [],
          body: marker("fix", `group:${group}`, { signature: "s", commit: "c" }),
          head: { ref: `cicd-optimizer/${group}`, sha: "c", repo: { full_name: "acme/widgets" } }, base: { ref: "main" },
        }],
      };
    },
  };
  return { client, state };
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

  describe("with many fix groups", () => {
    const groups = Array.from({ length: 12 }, (_, index) => `g${String(index).padStart(2, "0")}`);
    const discovery = { baseBranch: "main", branchPrefix: "cicd-optimizer/", groups };

    it("looks up the groups' branches concurrently within a bound and keeps group order", async () => {
      const { client, state } = branchLookups(groups);
      const prs = await listManagedPullRequests(client, repo, discovery);
      expect(prs.map((pr) => pr.group)).toEqual(groups);
      expect(state.peak).toBeGreaterThan(1);
      expect(state.peak).toBeLessThanOrEqual(8);
    });

    it("fails closed when one lookup fails and stops queuing the remaining lookups", async () => {
      const { client, state } = branchLookups(groups, "g05");
      await expect(listManagedPullRequests(client, repo, discovery)).rejects.toThrow("403");
      expect(state.started.length).toBeLessThan(groups.length);
    });
  });

  it.each(["open", "closed"])("does not adopt a labeled %s fork PR as repository history", async (state) => {
    const client = fakeClient((route) => route.endsWith("/issues") ? [{
      number: 7, title: "fork", state, pull_request: {}, labels: ["cicd-optimizer"],
      body: marker("fix", "group:hermeticity", { signature: "s", commit: "c" }),
    }] : { head: { sha: "c", ref: change.branch, repo: { full_name: "fork/widgets" } } });
    expect(await listManagedPullRequests(client, repo)).toEqual([]);
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

  it("finds fix pull requests by marker and verifies open and closed history", async () => {
    const client = fakeClient((route) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/issues"))
        return [
          { number: 1, title: "a", state: "open", body: marker("fix", "group:caching", { signature: "s", commit: "c1", rules: "caching/a,caching/b" }), pull_request: {} },
          { number: 2, title: "b", state: "closed", body: marker("fix", "group:workflow", { ignored: "workflow/x" }), pull_request: { merged_at: null }, labels: [{ name: IGNORED_LABEL }] },
          { number: 3, title: "issue", state: "open", body: marker("finding", "rule:x") },
          { number: 4, title: "other pr", state: "open", body: "no marker", pull_request: {} },
        ];
      if (route.startsWith("GET /repos/{owner}/{repo}/pulls/{pull_number}")) return { head: { sha: "c2", ref: "cicd-optimizer/caching", repo: { full_name: "acme/widgets" } } };
      return {};
    });
    const prs = await listManagedPullRequests(client, repo);
    expect(prs.map((pr) => pr.number)).toEqual([1, 2]);
    expect(prs[0]).toMatchObject({ group: "caching", signature: "s", commitSha: "c1", headSha: "c2", branch: "cicd-optimizer/caching", rules: ["caching/a", "caching/b"] });
    expect(prs[1]).toMatchObject({ state: "closed", merged: false, ignoredRules: ["workflow/x"] });
    expect(client.calls.filter((call) => call.route.includes("/pulls/"))).toHaveLength(2);
    expect(dismissalsFrom(prs).rules).toEqual(new Set(["workflow/x"]));
  });

  it("never adopts a labeled PR's arbitrary head branch for rewrites or cleanup", async () => {
    const body = marker("fix", "group:hermeticity", { signature: "s", commit: "c" });
    const pull = { number: 5, title: "forged", state: "open", body, labels: [], head: { sha: "c", ref: "release", repo: { full_name: "acme/widgets" } }, base: { ref: "main" } };
    const client = fakeClient((route) => {
      if (route.endsWith("/issues")) return [{ ...pull, pull_request: {} }];
      if (route.startsWith("GET /repos/{owner}/{repo}/pulls/{pull_number}")) return pull;
      return {};
    });
    const [pr] = await listManagedPullRequests(client, repo);
    expect(pr).toMatchObject({ number: 5, headSha: "c", commitSha: "c" });
    expect(pr?.branch).toBeUndefined();
    if (!pr) throw new Error("expected PR");
    expect(planFixPullRequests([{ ...change, signature: "new" }], [pr], { openPullRequestsLimit: 5 }).skipped).toEqual([{ group: "hermeticity", reason: "edited", number: 5 }]);
    expect(planFixPullRequests([], [pr], { openPullRequestsLimit: 5 }).actions).toEqual([]);

    await handleFixCommands(client, repo, pr, [{ type: "close" }]);
    expect(client.calls.find((call) => call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}")?.parameters).toMatchObject({ state: "closed" });
    expect(client.calls.some((call) => call.route.startsWith("DELETE") || call.route === "POST /graphql")).toBe(false);
    expect(pr.cleanup).toBeUndefined();
  });

  it("refreshes labeled history from discovery details without another per-PR request", async () => {
    const stale = {
      number: 7, title: "old", state: "closed", labels: [IGNORED_LABEL], pull_request: {},
      body: marker("fix", "group:hermeticity", { signature: "old", commit: "old", ignored: "hermeticity/pin-actions" }),
    };
    const fresh = {
      ...stale, state: "open", labels: ["cicd-optimizer"],
      body: marker("fix", "group:hermeticity", { signature: "fresh", commit: "fresh" }),
      head: { ref: change.branch, sha: "fresh", repo: { full_name: "acme/widgets" } }, base: { ref: "main" },
    };
    const client = fakeClient((route) => {
      if (route.endsWith("/issues")) return [stale];
      if (route === "GET /repos/{owner}/{repo}/pulls") return [fresh];
      throw new Error(`Unexpected request: ${route}`);
    });
    const prs = await listManagedPullRequests(client, repo, { baseBranch: "main", branchPrefix: "cicd-optimizer/", groups: ["hermeticity"] });
    expect(prs[0]).toMatchObject({ state: "open", signature: "fresh", headSha: "fresh", ignoredRules: [] });
    expect(dismissalsFrom(prs).rules.size).toBe(0);
    expect(client.calls).toHaveLength(2);
  });

  it("does not let a labeled fork hide an unlabeled same-repository PR", async () => {
    const body = marker("fix", "group:hermeticity", { signature: "s", commit: "c" });
    const local = { number: 8, title: "local", body, state: "open", labels: [], head: { ref: change.branch, sha: "c", repo: { full_name: "acme/widgets" } }, base: { ref: "main" } };
    const client = fakeClient((route) => {
      if (route.endsWith("/issues")) return [{ number: 7, title: "fork", state: "open", body, pull_request: {} }];
      if (route === "GET /repos/{owner}/{repo}/pulls") return [local];
      return { ...local, number: 7, head: { ...local.head, repo: { full_name: "fork/widgets" } } };
    });
    expect((await listManagedPullRequests(client, repo, { baseBranch: "main", branchPrefix: "cicd-optimizer/", groups: ["hermeticity"] })).map((pr) => pr.number)).toEqual([8]);
  });

  it.each([404, 403, 500])("propagates closed-history lookup failures (%s)", async (status) => {
    const client = fakeClient((route) => {
      if (route.endsWith("/issues")) return [{ number: 7, title: "closed", state: "closed", body: marker("fix", "group:hermeticity"), pull_request: {} }];
      throw httpError(status);
    });
    await expect(listManagedPullRequests(client, repo)).rejects.toThrow(String(status));
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
    const previous = managed({
      state: "closed", commitSha: "old-bot", headSha: "old-bot",
      body: marker("fix", "group:hermeticity", { signature: "old", commit: "old-bot" }),
    });
    const client = fakeClient((route) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return {
        ...previous, head: { sha: "old-bot", ref: change.branch, repo: { full_name: "acme/widgets" } }, base: { ref: "main" },
      };
      if (route === "GET /repos/{owner}/{repo}") return { node_id: "repo-node", default_branch: "main" };
      if (route === "POST /graphql") return { data: { updateRefs: {} } };
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { object: { sha: "old-bot" } };
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") return { tree: { sha: "tree" } };
      if (route === "POST /repos/{owner}/{repo}/git/refs") throw httpError(422);
      if (route.startsWith("POST /repos/{owner}/{repo}/git/")) return { sha: "new-bot" };
      if (route === "POST /repos/{owner}/{repo}/pulls") return { number: 42 };
      return [];
    });
    await applyFixActions(client, repo, [{ type: "create", change }], {
      baseBranch: "main", baseSha: "base", config: DEFAULT_CONFIG.fixes, rules: [],
      existing: [previous],
    });
    expect(client.calls.find((call) => call.route === "POST /graphql")?.parameters.variables)
      .toMatchObject({ input: { refUpdates: [{ beforeOid: "old-bot", afterOid: "new-bot", force: true }] } });
  });

  it("atomically updates the PR's existing branch even when the configured prefix changes", async () => {
    const previous = managed({ ignoredRules: ["hermeticity/pin-actions"], headSha: "c2" });
    let body = previous.body;
    let sha = "c2";
    const client = fakeClient((route, parameters) => {
      if (route === "GET /repos/{owner}/{repo}") return { node_id: "repo-node", default_branch: "main" };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return { body, state: "open", head: { sha, ref: change.branch, repo: { full_name: "acme/widgets" } } };
      if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") body = String(parameters.body);
      if (route === "POST /graphql") { sha = "c3"; return { data: { updateRefs: {} } }; }
      if (route.startsWith("GET /repos/{owner}/{repo}/git/commits")) return { tree: { sha: "t" } };
      if (route.startsWith("POST /repos/{owner}/{repo}/git")) return { sha: "c3" };
      return {};
    });
    const existing = [previous];
    await applyFixActions(client, repo, [{ type: "update", number: 7, change: { ...change, branch: "new-prefix/hermeticity" } }], { baseBranch: "main", baseSha: "base", config: DEFAULT_CONFIG.fixes, rules: [], existing });
    expect(client.calls.find((call) => call.route === "POST /graphql")?.parameters.variables).toMatchObject({
      input: { refUpdates: [{ name: "refs/heads/cicd-optimizer/hermeticity", beforeOid: "c2", afterOid: "c3", force: true }] },
    });
    const patch = client.calls.find((call) => call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}");
    expect(parseMarker(patch?.parameters.body as string)?.attributes.ignored).toBe("hermeticity/pin-actions");
  });

  it("refuses an update without the current PR head before creating a commit", async () => {
    const client = fakeClient();
    await expect(applyFixActions(client, repo, [{ type: "update", number: 7, change }], {
      baseBranch: "main", baseSha: "base", config: DEFAULT_CONFIG.fixes, rules: [], existing: [managed()],
    })).rejects.toThrow("Missing current head");
    expect(client.calls).toHaveLength(0);
  });

  it("closes stale pull requests with a comment and deletes the branch", async () => {
    const pr = managed({ headSha: "observed" });
    const client = fakeApi({ issues: [{ ...pr, pull_request: {} }], pullHeads: { 7: { ref: change.branch, sha: "observed" } } });
    await applyFixActions(client, repo, [{ type: "close", number: 7, group: pr.group, branch: change.branch, comment: "bye" }], {
      baseBranch: "main",
      baseSha: "base",
      config: DEFAULT_CONFIG.fixes,
      rules: [],
      existing: [pr],
    });
    expect(client.calls.find((call) => call.route === "POST /graphql")?.parameters.variables).toMatchObject({
      input: { refUpdates: [{ beforeOid: "observed", afterOid: "0".repeat(40) }] },
    });
    expect(client.calls.some((call) => call.route.startsWith("DELETE"))).toBe(false);
    const patches = client.calls.filter((call) => call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}");
    expect(patches[0]?.parameters.state).toBe("closed");
    expect(parseMarker(String(patches.at(-1)?.parameters.body))?.attributes.cleanupStatus).toBe("deleted");
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
    const group = managed({ headSha: "observed" });
    const groupClient = fakeApi({ issues: [{ ...group, pull_request: {} }], pullHeads: { 7: { ref: change.branch, sha: "observed" } } });
    const outcome = await handleFixCommands(groupClient, repo, group, [{ type: "ignore-group" }]);
    expect(outcome.recompute).toBe(false);
    expect(group.state).toBe("closed");
    expect(dismissalsFrom([group]).groups).toEqual(new Set(["hermeticity"]));
    expect(groupClient.calls.some((call) => call.route === "POST /graphql")).toBe(true);
  });

  it("queues rebase and recreate for the follow-up fix run", async () => {
    const client = fakeClient();
    const outcome = await handleFixCommands(client, repo, managed(), [{ type: "rebase" }, { type: "recreate" }]);
    expect(outcome).toMatchObject({ rebase: new Set(["hermeticity"]), recreate: new Set(["hermeticity"]), recompute: true });
  });
});
