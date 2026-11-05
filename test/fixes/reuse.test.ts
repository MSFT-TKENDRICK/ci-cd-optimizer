import { describe, expect, it } from "vitest";
import { applyFixActions, listManagedPullRequests, type ManagedPullRequest } from "../../src/fixes/github.js";
import { planFixPullRequests, type FixChange } from "../../src/fixes/plan.js";
import { marker } from "../../src/issues/markers.js";
import { DEFAULT_CONFIG } from "../../src/lint/config.js";
import { httpError, repo } from "../experiments/fixtures.js";
import { callsTo, fakeApi, type FakePull } from "../service/api.js";

const change: FixChange = {
  group: "hermeticity", branch: "cicd-optimizer/hermeticity", signature: "new",
  files: [{ path: ".github/workflows/ci.yml", content: "name: example\n" }], applied: [], rules: [],
};

function fixture() {
  const pull: FakePull = {
    number: 7, title: "old", state: "closed", draft: false, labels: ["cicd-optimizer"],
    body: marker("fix", "group:hermeticity", { signature: "old", commit: "old-bot" }),
    head: { ref: change.branch, sha: "old-bot", repo: { full_name: "acme/widgets" } }, base: { ref: "main" },
    requested_reviewers: [], requested_teams: [],
  };
  const heads = { [change.branch]: "old-bot" };
  const pulls = [pull];
  const client = fakeApi({ pulls, branchHeads: heads });
  const options = { baseBranch: "main", baseSha: "base", config: DEFAULT_CONFIG.fixes, rules: [] };
  const history = () => listManagedPullRequests(client, repo);
  const apply = async (existing?: ManagedPullRequest[]) => applyFixActions(client, repo, [{ type: "create", change }], {
    ...options, existing: existing ?? await history(),
  });
  return { pull, pulls, heads, client, history, options, apply };
}

describe("closed-PR branch reuse", () => {
  it.each(["fork", "different branch", "different head", "different base", "different marker"])(
    "does not authorize a local branch from %s history",
    async (mismatch) => {
      const f = fixture();
      if (mismatch === "fork") f.pull.head.repo.full_name = "someone/widgets";
      if (mismatch === "different branch") f.pull.head.ref = "legacy/hermeticity";
      if (mismatch === "different head") f.pull.head.sha = "human";
      if (mismatch === "different base") f.pull.base.ref = "release";
      if (mismatch === "different marker") f.pull.body = marker("fix", "group:hermeticity", { signature: "old", commit: "different" });
      await expect(f.apply()).rejects.toThrow(/unrecognized or modified branch|does not authorize reuse/);
      expect(f.heads[change.branch]).toBe("old-bot");
      expect(callsTo(f.client, "POST /repos/{owner}/{repo}/git/commits")).toEqual([]);
      expect(callsTo(f.client, "POST /graphql")).toEqual([]);
    },
  );

  it.each([404, 403, 500])("does not treat a reuse authorization error (%s) as a missing ref", async (status) => {
    const f = fixture();
    const existing = await f.history();
    const original = f.client.request.bind(f.client);
    f.client.request = async (route, parameters) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") throw httpError(status);
      return original(route, parameters);
    };
    await expect(f.apply(existing)).rejects.toThrow(String(status));
    expect(callsTo(f.client, "POST /repos/{owner}/{repo}/git/commits")).toEqual([]);
    expect(callsTo(f.client, "POST /repos/{owner}/{repo}/git/refs")).toEqual([]);
    expect(callsTo(f.client, "POST /graphql")).toEqual([]);
  });

  it.each(["reopened", "marker", "base", "fork", "other PR", "human head"])(
    "rechecks %s after commit creation but before writing the ref",
    async (race) => {
      const f = fixture();
      const original = f.client.request.bind(f.client);
      let injected = false;
      f.client.request = async (route, parameters) => {
        const response = await original(route, parameters);
        if (route === "POST /repos/{owner}/{repo}/git/commits") {
          injected = true;
          if (race === "reopened") f.pull.state = "open";
          if (race === "marker") f.pull.body = marker("fix", "group:other", { commit: "old-bot" });
          if (race === "base") f.pull.base.ref = "release";
          if (race === "fork") f.pull.head.repo.full_name = "someone/widgets";
          if (race === "other PR") f.pulls.push({ ...structuredClone(f.pull), number: 8, state: "open", body: "Unrelated PR", labels: [] });
          if (race === "human head") {
            f.heads[change.branch] = "human";
            f.pull.head.sha = "human";
          }
        }
        return response;
      };
      await expect(f.apply()).rejects.toThrow(/changed since planning|does not authorize reuse|open PR already uses/);
      expect(injected).toBe(true);
      expect(f.heads[change.branch]).toBe(race === "human head" ? "human" : "old-bot");
      expect(callsTo(f.client, "POST /graphql")).toEqual([]);
      expect(callsTo(f.client, "POST /repos/{owner}/{repo}/pulls")).toEqual([]);
    },
  );

  it("reuses the reconciled history after finalizing a closed PR's pending update", async () => {
    const f = fixture();
    f.pull.body = marker("fix", "group:hermeticity", {
      commit: "before", signature: "before", pendingFrom: "before", pendingCommit: "old-bot",
      pendingSignature: "intermediate", pendingBase: "old-base",
    });
    const existing = await f.history();
    const plan = planFixPullRequests([change], existing, { openPullRequestsLimit: 5, baseSha: "base" });
    expect(plan.actions.map((action) => action.type)).toEqual(["metadata", "create"]);
    await applyFixActions(f.client, repo, plan.actions, { ...f.options, existing });
    expect(f.heads[change.branch]).toBe("new-commit");
    expect(callsTo(f.client, "POST /graphql")[0]?.parameters.variables).toMatchObject({
      input: { refUpdates: [{ beforeOid: "old-bot", afterOid: "new-commit" }] },
    });
    expect(callsTo(f.client, "POST /repos/{owner}/{repo}/pulls")).toHaveLength(1);
  });

  it.each(["update", "cleanup"])("refuses reuse with an unreconciled %s intent", async (intent) => {
    const f = fixture();
    f.pull.body = marker("fix", "group:hermeticity", {
      commit: "old-bot", signature: "old",
      ...(intent === "update" ? { pendingFrom: "old-bot", pendingCommit: "intended", pendingSignature: "intended", pendingBase: "base" }
        : { cleanupBranch: change.branch, cleanupHead: "old-bot", cleanupStatus: "pending" }),
    });
    await expect(f.apply()).rejects.toThrow("does not authorize reuse");
    expect(callsTo(f.client, "POST /repos/{owner}/{repo}/git/commits")).toEqual([]);
    expect(f.heads[change.branch]).toBe("old-bot");
  });

  it("fails closed when the ref lookup returns no head", async () => {
    const f = fixture();
    const original = f.client.request.bind(f.client);
    f.client.request = async (route, parameters) => route === "GET /repos/{owner}/{repo}/git/ref/{ref}"
      ? { status: 200, data: { object: {} } } : original(route, parameters);
    await expect(f.apply()).rejects.toThrow("did not return the current head");
    expect(callsTo(f.client, "POST /repos/{owner}/{repo}/git/refs")).toEqual([]);
    expect(callsTo(f.client, "POST /graphql")).toEqual([]);
  });
});
