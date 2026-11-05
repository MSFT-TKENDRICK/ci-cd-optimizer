import { describe, expect, it, vi } from "vitest";
import { fromOctokit } from "../../src/github/client.js";
import { updateBranch } from "../../src/github/git.js";
import { fakeClient, httpError, repo } from "../experiments/fixtures.js";

describe("updateBranch", () => {
  it("uses an atomic expected-head update, allowing non-fast-forward rebuilds", async () => {
    const client = fakeClient((route) => route.startsWith("GET") ? { node_id: "repo-node" } : { data: { updateRefs: { clientMutationId: null } } });
    await updateBranch(client, repo, "ci/cache", "new-sha", "old-sha");
    expect(client.calls.map((call) => call.route)).toEqual(["GET /repos/{owner}/{repo}", "POST /graphql"]);
    expect(client.calls[1]?.parameters.variables).toEqual({
      input: { repositoryId: "repo-node", refUpdates: [{ name: "refs/heads/ci/cache", beforeOid: "old-sha", afterOid: "new-sha", force: true }] },
    });
    expect(client.calls[1]?.parameters.query).toContain("updateRefs(input: $input)");
  });

  it("does not overwrite a human commit made after planning", async () => {
    let head = "old-sha";
    const client = fakeClient((route, parameters) => {
      if (route.startsWith("GET")) { head = "human-sha"; return { node_id: "repo-node" }; }
      const { input } = parameters.variables as { input: { refUpdates: Array<{ beforeOid: string; afterOid: string }> } };
      const update = input.refUpdates[0]!;
      if (head !== update.beforeOid) return { data: { updateRefs: null }, errors: [{ message: "Reference changed" }] };
      head = update.afterOid;
      return { data: { updateRefs: {} } };
    });
    await expect(updateBranch(client, repo, "ci/cache", "new-sha", head)).rejects.toThrow("Reference changed");
    expect(head).toBe("human-sha");
    expect(client.calls.filter((call) => !call.route.startsWith("GET")).map((call) => call.route)).toEqual(["POST /graphql"]);
  });

  it.each([undefined, {}, { data: null }, { data: { updateRefs: null } }])("rejects an unacknowledged mutation: %j", async (response) => {
    const client = fakeClient((route) => route.startsWith("GET") ? { node_id: "repo-node" } : response);
    await expect(updateBranch(client, repo, "ci/cache", "new", "old")).rejects.toThrow("did not acknowledge");
  });

  it("refuses missing expected heads and repository identity", async () => {
    const client = fakeClient();
    await expect(updateBranch(client, repo, "ci/cache", "new", "")).rejects.toThrow("Missing expected head");
    expect(client.calls).toHaveLength(0);
    await expect(updateBranch(client, repo, "ci/cache", "new", "old")).rejects.toThrow("repository node ID");
    expect(client.calls.map((call) => call.route)).toEqual(["GET /repos/{owner}/{repo}"]);
  });

  it("propagates transport errors without falling back to an unconditional update", async () => {
    const client = fakeClient((route) => {
      if (route.startsWith("GET")) return { node_id: "repo-node" };
      throw httpError(403);
    });
    await expect(updateBranch(client, repo, "ci/cache", "new", "old")).rejects.toThrow("403");
    expect(client.calls).toHaveLength(2);
  });
});

describe("Octokit GraphQL routing", () => {
  it.each(["https://ghe.example.com/api/v3", "https://ghe.example.com/api/v3/"])("uses the Enterprise GraphQL endpoint from %s", async (baseUrl) => {
    const request = Object.assign(vi.fn(async (_route: string, _parameters?: Record<string, unknown>) => ({ status: 200, data: {} })), {
      endpoint: { DEFAULTS: { baseUrl } },
    });
    const client = fromOctokit({ request });
    const parameters = { query: "{ viewer { login } }", variables: {} };
    await client.request("POST /graphql", parameters);
    expect(request).toHaveBeenLastCalledWith("POST /graphql", { ...parameters, baseUrl: "https://ghe.example.com/api" });
    await client.request("GET /repos/{owner}/{repo}", repo);
    expect(request).toHaveBeenLastCalledWith("GET /repos/{owner}/{repo}", repo);
  });

  it("preserves public GitHub routing", async () => {
    const request = Object.assign(vi.fn(async (_route: string, _parameters?: Record<string, unknown>) => ({ status: 200, data: {} })), {
      endpoint: { DEFAULTS: { baseUrl: "https://api.github.com" } },
    });
    await fromOctokit({ request }).request("POST /graphql", { query: "{}" });
    expect(request).toHaveBeenCalledWith("POST /graphql", { query: "{}" });
  });
});
