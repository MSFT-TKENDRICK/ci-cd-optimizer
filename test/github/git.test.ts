import { describe, expect, it, vi } from "vitest";
import { fromOctokit } from "../../src/github/client.js";
import { deleteBranch, updateBranch } from "../../src/github/git.js";
import { fakeClient, httpError, repo } from "../experiments/fixtures.js";

const repository = { node_id: "repo-node", default_branch: "main" };

describe("updateBranch", () => {
  it("uses an atomic expected-head update, allowing non-fast-forward rebuilds", async () => {
    const client = fakeClient((route) => route.startsWith("GET") ? repository : { data: { updateRefs: { clientMutationId: null } } });
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
      if (route.startsWith("GET")) { head = "human-sha"; return repository; }
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
    const client = fakeClient((route) => route.startsWith("GET") ? repository : response);
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
      if (route.startsWith("GET")) return repository;
      throw httpError(403);
    });
    await expect(updateBranch(client, repo, "ci/cache", "new", "old")).rejects.toThrow("403");
    expect(client.calls).toHaveLength(2);
  });
});

describe("default branch protection", () => {
  it.each(["main", "ci/cache", "release/next"])("refuses a non-deletion write to the current default %s", async (branch) => {
    const client = fakeClient((route) => route.startsWith("GET") ? { ...repository, default_branch: branch } : { data: { updateRefs: {} } });
    await expect(updateBranch(client, repo, branch, "new", "observed")).rejects.toThrow("default branch");
    expect(client.calls.map((call) => call.route)).toEqual(["GET /repos/{owner}/{repo}"]);
  });

  it.each([undefined, null, "", " ", 42, true, {}, []].flatMap((value) => [false, true].map((deleting) => ({ value, deleting }))))(
    "refuses unknown default metadata ($value, deleting: $deleting)",
    async ({ value, deleting }) => {
      const client = fakeClient((route) => {
        if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { object: { sha: "observed" } };
        if (route === "GET /repos/{owner}/{repo}") return { node_id: "repo-node", default_branch: value };
        return { data: { updateRefs: {} } };
      });
      await expect(deleting ? deleteBranch(client, repo, "ci/cache", "observed") : updateBranch(client, repo, "ci/cache", "new", "observed"))
        .rejects.toThrow("default branch");
      expect(client.calls.every((call) => call.route.startsWith("GET"))).toBe(true);
    },
  );

  it.each([undefined, null, "", " ", 42, {}, []].map((value) => ({ value })))("requires a valid repository node ID ($value)", async ({ value }) => {
    const client = fakeClient(() => ({ node_id: value, default_branch: "main" }));
    await expect(updateBranch(client, repo, "ci/cache", "new", "observed")).rejects.toThrow("repository node ID");
    expect(client.calls).toHaveLength(1);
  });

  it.each([undefined, null].map((data) => ({ data })))("refuses an absent repository response ($data)", async ({ data }) => {
    const client = fakeClient(() => data);
    await expect(updateBranch(client, repo, "ci/cache", "new", "observed")).rejects.toThrow("repository node ID");
    expect(client.calls).toHaveLength(1);
  });

  it("rereads the default branch on every update instead of caching it", async () => {
    let defaultBranch = "main";
    const client = fakeClient((route) => route.startsWith("GET") ? { ...repository, default_branch: defaultBranch } : { data: { updateRefs: {} } });
    await updateBranch(client, repo, "ci/cache", "first", "observed");
    defaultBranch = "ci/cache";
    await expect(updateBranch(client, repo, "ci/cache", "second", "first")).rejects.toThrow("default branch");
    expect(client.calls.filter((call) => call.route === "POST /graphql")).toHaveLength(1);
    expect(client.calls.filter((call) => call.route === "GET /repos/{owner}/{repo}")).toHaveLength(2);
  });
});

describe("deleteBranch", () => {
  it("uses a zero target with the original observed head, never REST deletion", async () => {
    const client = fakeClient((route) => {
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { object: { sha: "observed" } };
      if (route === "GET /repos/{owner}/{repo}") return repository;
      return { data: { updateRefs: {} } };
    });
    expect(await deleteBranch(client, repo, "ci/a", "observed")).toBe("deleted");
    expect(client.calls.at(-1)?.parameters.variables).toMatchObject({
      input: { refUpdates: [{ name: "refs/heads/ci/a", beforeOid: "observed", afterOid: "0".repeat(40), force: true }] },
    });
    expect(client.calls.some((call) => call.route.startsWith("DELETE"))).toBe(false);
  });

  it("preserves a changed head and treats a missing ref as already absent", async () => {
    const changed = fakeClient(() => ({ object: { sha: "human" } }));
    expect(await deleteBranch(changed, repo, "ci/a", "observed")).toBe("changed");
    expect(changed.calls).toHaveLength(1);
    const missing = fakeClient(() => { throw httpError(404); });
    expect(await deleteBranch(missing, repo, "ci/a", "observed")).toBe("missing");
  });

  it.each([403, 422, 429, 500])("does not hide a ref lookup failure (%s)", async (status) => {
    const client = fakeClient(() => { throw httpError(status); });
    await expect(deleteBranch(client, repo, "ci/a", "observed")).rejects.toThrow(String(status));
    expect(client.calls).toHaveLength(1);
  });

  it("propagates a racing-head failure; a retry preserves the changed ref", async () => {
    let head = "observed";
    const client = fakeClient((route) => {
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { object: { sha: head } };
      if (route === "GET /repos/{owner}/{repo}") { head = "human"; return repository; }
      return { errors: [{ message: "Reference changed" }] };
    });
    await expect(deleteBranch(client, repo, "ci/a", "observed")).rejects.toThrow("Reference changed");
    expect(await deleteBranch(client, repo, "ci/a", "observed")).toBe("changed");
    expect(head).toBe("human");
    expect(client.calls.filter((call) => call.route === "POST /graphql")).toHaveLength(1);
  });

  it("requires an observed head and refuses the default branch", async () => {
    const client = fakeClient((route) => route.endsWith("/git/ref/{ref}") ? { object: { sha: "observed" } } : { node_id: "repo-node", default_branch: "main" });
    await expect(deleteBranch(client, repo, undefined, "observed")).rejects.toThrow("requires");
    await expect(deleteBranch(client, repo, "ci/a", undefined)).rejects.toThrow("requires");
    await expect(deleteBranch(client, repo, "ci/a", "0".repeat(40))).rejects.toThrow("requires");
    expect(client.calls).toEqual([]);
    await expect(deleteBranch(client, repo, "main", "observed")).rejects.toThrow("default branch");
    expect(client.calls.some((call) => call.route === "POST /graphql")).toBe(false);
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
