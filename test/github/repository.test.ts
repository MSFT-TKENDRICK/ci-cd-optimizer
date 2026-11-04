import { describe, expect, it } from "vitest";
import { defaultBranch, loadRemoteConfig, loadRepositorySnapshot } from "../../src/github/repository.js";
import { DEFAULT_CONFIG } from "../../src/lint/config.js";
import { fakeClient, httpError, repo } from "../experiments/fixtures.js";

const base64 = (text: string) => Buffer.from(text).toString("base64");

describe("defaultBranch", () => {
  it("reads the repository's default branch", async () => {
    expect(await defaultBranch(fakeClient(() => ({ default_branch: "trunk" })), repo)).toBe("trunk");
  });
});

describe("loadRemoteConfig", () => {
  it("reads the first configuration file that exists on the ref", async () => {
    const client = fakeClient((_route, parameters) => {
      if (parameters.path === ".github/ci-cd-optimizer.yaml") return { content: base64("rules:\n  workflow/job-timeout: off\n"), encoding: "base64" };
      throw httpError(404);
    });
    const remote = await loadRemoteConfig(client, repo, "main");
    expect(remote).toMatchObject({ path: ".github/ci-cd-optimizer.yaml", problems: [] });
    expect(remote.config.rules["workflow/job-timeout"]).toBe("off");
    expect(client.calls.map((call) => call.parameters.ref)).toEqual(["main", "main"]);
  });

  it("falls back to defaults and reports invalid files", async () => {
    expect(await loadRemoteConfig(fakeClient(() => Promise.reject(httpError(404))), repo, "main")).toEqual({ config: DEFAULT_CONFIG, problems: [] });
    const invalid = await loadRemoteConfig(fakeClient(() => ({ content: "rulesets:\n  nope: error\n", encoding: "utf-8" })), repo, "main");
    expect(invalid.problems[0]?.message).toContain('Unknown ruleset "nope"');
  });

  it("propagates errors other than not found", async () => {
    await expect(loadRemoteConfig(fakeClient(() => Promise.reject(httpError(500))), repo, "main")).rejects.toThrow("HTTP 500");
  });
});

describe("loadRepositorySnapshot", () => {
  const tree = [
    { path: ".github/workflows/ci.yml", type: "blob", sha: "b1", size: 20 },
    { path: "src/index.ts", type: "blob", sha: "b2", size: 10 },
    { path: "bun.lockb", type: "blob", sha: "b3", size: 10 },
    { path: ".github", type: "tree", sha: "t1" },
  ];

  const client = (truncated = false) =>
    fakeClient((route, parameters) => {
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") return { sha: "c1", commit: { tree: { sha: "root" } } };
      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") return { tree, truncated };
      if (route === "GET /repos/{owner}/{repo}/git/blobs/{file_sha}") return { content: base64(`content of ${String(parameters.file_sha)}`), encoding: "base64" };
      throw new Error(`unexpected ${route}`);
    });

  it("loads relevant files through the tree and blob APIs", async () => {
    const fake = client();
    const snapshot = await loadRepositorySnapshot(fake, repo, { ref: "main", config: DEFAULT_CONFIG });
    expect(snapshot).toMatchObject({ ref: "main", sha: "c1", input: { mode: "repository", inventoryComplete: true } });
    const workflow = snapshot.input.files.find((file) => file.path === ".github/workflows/ci.yml");
    expect(workflow?.content).toBe("content of b1");
    expect(snapshot.input.files.find((file) => file.path === "bun.lockb")?.content ?? "").toBe("");
    expect(fake.calls.find((call) => call.route.includes("git/trees"))?.parameters).toMatchObject({ tree_sha: "root", recursive: "1" });
    expect(fake.calls.filter((call) => call.route.includes("git/blobs")).every((call) => call.parameters.file_sha !== "b3")).toBe(true);
  });

  it("marks the inventory incomplete when the tree is truncated and passes change context", async () => {
    const change = { baseRef: "main", changedFiles: ["src/index.ts"] };
    const snapshot = await loadRepositorySnapshot(client(true), repo, { ref: "main", config: DEFAULT_CONFIG, change: change as never });
    expect(snapshot.input.inventoryComplete).toBe(false);
    expect(snapshot.input.change).toEqual(change);
  });
});
