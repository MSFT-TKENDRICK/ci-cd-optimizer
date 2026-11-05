import { describe, expect, it } from "vitest";
import { DEFAULT_HILL_CLIMB_CONFIG } from "../../src/experiments/config.js";
import type { Decision } from "../../src/experiments/decide.js";
import {
  applyDecision,
  createExperiment,
  dispatchRuns,
  experimentBody,
  groupExperiments,
  listExperimentPullRequests,
  type ExperimentPullRequest,
  type ExperimentState,
} from "../../src/experiments/github.js";
import { parseManifest } from "../../src/experiments/manifest.js";
import { fakeClient, httpError, repo, sampleManifest } from "./fixtures.js";

const config = DEFAULT_HILL_CLIMB_CONFIG;

const pull = (arm: string, overrides: Partial<ExperimentPullRequest> = {}): ExperimentPullRequest => ({
  number: arm === "trunk" ? 10 : 10 + arm.length,
  nodeId: `PR_${arm}`,
  state: "open",
  merged: false,
  draft: arm === "trunk",
  title: `experiment(setup-cache-yarn): ${arm}`,
  body: "",
  labels: ["experiment"],
  head: `experiments/setup-cache-yarn/${arm}`,
  headSha: `sha-${arm}`,
  headRepository: "acme/widgets",
  base: arm === "trunk" ? "main" : "experiments/setup-cache-yarn/trunk",
  experiment: "setup-cache-yarn",
  arm,
  ...overrides,
});

const state = (): ExperimentState => ({
  name: "setup-cache-yarn",
  trunk: pull("trunk"),
  arms: [pull("lockfile", { number: 11 }), pull("packagemanager", { number: 12 })],
});

const evidence = (planned: ExperimentState) => ({
  experiment: planned.name, collectedAt: "2026-11-05T00:00:00Z",
  control: { arm: "trunk", headSha: planned.trunk!.headSha, pullRequest: planned.trunk!.number, changedPaths: [] },
  arms: planned.arms.filter((pull) => pull.state === "open").map((pull) => ({ arm: pull.arm, headSha: pull.headSha, pullRequest: pull.number, changedPaths: [] })),
});

const rawPull = (pull: ExperimentPullRequest) => ({
  ...pull, node_id: pull.nodeId, merged_at: pull.merged ? "2026-11-05T00:00:00Z" : null,
  head: { ref: pull.head, sha: pull.headSha, repo: pull.headRepository ? { full_name: pull.headRepository } : null },
  base: { ref: pull.base }, labels: pull.labels.map((name) => ({ name })),
});

const routes = (client: ReturnType<typeof fakeClient>) => client.calls.map((call) => call.route);

describe("experiment pull requests", () => {
  it("lists only experiment branches and groups arms under their trunk", async () => {
    const raw = (ref: string, base: string, number: number) => ({
      number,
      node_id: `N${number}`,
      state: "open",
      merged_at: null,
      closed_at: null,
      draft: false,
      title: ref,
      body: null,
      labels: [{ name: "experiment" }],
      head: { ref, sha: `s${number}`, repo: { full_name: "acme/widgets" } },
      base: { ref: base },
    });
    const client = fakeClient(() => [
      raw("experiments/alpha/trunk", "main", 1),
      raw("experiments/alpha/fast", "experiments/alpha/trunk", 2),
      raw("experiments/alpha/stray", "main", 3),
      raw("feature/unrelated", "main", 4),
      raw("experiments/beta/only", "experiments/beta/trunk", 5),
    ]);
    const pulls = await listExperimentPullRequests(client, repo);
    expect(pulls.map((p) => p.number)).toEqual([1, 2, 3, 5]);
    expect(pulls[1]).toMatchObject({ experiment: "alpha", arm: "fast", headSha: "s2", headRepository: "acme/widgets", body: "" });
    const grouped = groupExperiments(pulls);
    expect(grouped.map((g) => g.name)).toEqual(["alpha", "beta"]);
    expect(grouped[0]?.trunk?.number).toBe(1);
    expect(grouped[0]?.arms.map((a) => a.number)).toEqual([2]);
    expect(grouped[1]?.trunk).toBeUndefined();
  });

  it("renders a body with a marker, arms, and the rubric", () => {
    const body = experimentBody(sampleManifest(), config, "decision text");
    expect(body).toContain("<!-- cicd-optimizer:experiment fingerprint=setup-cache-yarn status=running kind=rules -->");
    expect(body).toContain("`experiments/setup-cache-yarn/lockfile`");
    expect(body).toContain("decision text");
    expect(body).toContain("Rubric score:** 4.2 / 5");
  });
});

describe("createExperiment", () => {
  it("commits the manifest to a new trunk branch and opens a labelled draft PR", async () => {
    const client = fakeClient((route) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/git/ref/")) return { object: { sha: "base" } };
      if (route.startsWith("GET /repos/{owner}/{repo}/git/commits/")) return { tree: { sha: "tree0" } };
      if (route === "POST /repos/{owner}/{repo}/git/trees") return { sha: "tree1" };
      if (route === "POST /repos/{owner}/{repo}/git/commits") return { sha: "c1" };
      if (route === "POST /repos/{owner}/{repo}/pulls") return { number: 42 };
      if (route === "GET /repos/{owner}/{repo}/labels") return [];
      return {};
    });
    const created = await createExperiment(client, repo, {
      manifest: sampleManifest(),
      baseBranch: "main",
      config,
      files: [{ path: "corpus/yarn/case.yml", content: "expected: []\n" }],
    });
    expect(created).toEqual({ trunk: "experiments/setup-cache-yarn/trunk", pullRequest: 42, sha: "c1" });
    const tree = client.calls.find((call) => call.route === "POST /repos/{owner}/{repo}/git/trees")?.parameters.tree as Array<{ path: string; content: string }>;
    expect(tree.map((entry) => entry.path)).toEqual(["experiments/setup-cache-yarn/experiment.yml", "corpus/yarn/case.yml"]);
    expect(parseManifest(tree[0]?.content ?? "").manifest?.name).toBe("setup-cache-yarn");
    expect(client.calls.find((call) => call.route === "POST /repos/{owner}/{repo}/git/refs")?.parameters).toMatchObject({ ref: "refs/heads/experiments/setup-cache-yarn/trunk", sha: "c1" });
    expect(client.calls.find((call) => call.route === "POST /repos/{owner}/{repo}/pulls")?.parameters).toMatchObject({ draft: true, head: "experiments/setup-cache-yarn/trunk", base: "main" });
    expect(client.calls.at(-1)).toMatchObject({ route: "POST /repos/{owner}/{repo}/issues/{issue_number}/labels", parameters: { issue_number: 42, labels: ["experiment"] } });
  });

  it("refuses to overwrite an existing experiment and falls back from draft PRs", async () => {
    const exists = fakeClient((route) => {
      if (route === "POST /repos/{owner}/{repo}/git/refs") throw httpError(422);
      if (route.startsWith("GET /repos/{owner}/{repo}/git/ref/")) return { object: { sha: "base" } };
      if (route.startsWith("GET /repos/{owner}/{repo}/git/commits/")) return { tree: { sha: "t" } };
      return { sha: "x" };
    });
    await expect(createExperiment(exists, repo, { manifest: sampleManifest(), baseBranch: "main", config })).rejects.toThrow(/already exists/);

    let attempts = 0;
    const noDraft = fakeClient((route, parameters) => {
      if (route === "POST /repos/{owner}/{repo}/pulls") {
        attempts += 1;
        if (parameters.draft) throw httpError(422);
        return { number: 7 };
      }
      if (route.startsWith("GET /repos/{owner}/{repo}/git/ref/")) return { object: { sha: "base" } };
      if (route.startsWith("GET /repos/{owner}/{repo}/git/commits/")) return { tree: { sha: "t" } };
      if (route === "GET /repos/{owner}/{repo}/labels") return [{ name: "experiment" }];
      return { sha: "x" };
    });
    await expect(createExperiment(noDraft, repo, { manifest: sampleManifest(), baseBranch: "main", config })).resolves.toMatchObject({ pullRequest: 7 });
    expect(attempts).toBe(2);
  });
});

describe("applyDecision", () => {
  const manifest = sampleManifest();

  it("dispatches runs (capped) and keeps a single sticky grading comment while waiting", async () => {
    const client = fakeClient((route) => {
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        return [{ id: 99, body: "<!-- cicd-optimizer:experiment fingerprint=setup-cache-yarn role=grade -->\nold" }];
      }
      return {};
    });
    const decision: Decision = {
      action: "wait",
      reason: "collecting",
      scores: [],
      dispatch: [
        { ref: "experiments/setup-cache-yarn/lockfile", arm: "lockfile", workflow: "ci.yml", runs: 9 },
        { ref: "experiments/setup-cache-yarn/trunk", arm: "trunk", workflow: "ci.yml", runs: 2 },
      ],
    };
    const result = await applyDecision(client, repo, { manifest, decision, state: state(), config });
    expect(result.dispatched).toBe(7);
    expect(routes(client).filter((route) => route.includes("dispatches"))).toHaveLength(7);
    expect(client.calls.at(-1)).toMatchObject({ route: "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", parameters: { comment_id: 99 } });
  });

  it("merges the winner, closes losers, promotes the manifest, and readies the trunk PR", async () => {
    const planned = state();
    let trunkHead = "sha-trunk";
    let body = "";
    let draft = true;
    const closed = new Set<number>();
    const client = fakeClient((route, parameters) => {
      if (route === "GET /repos/{owner}/{repo}") return { node_id: "repo-node", default_branch: "main" };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        const pull = [planned.trunk!, ...planned.arms].find((pull) => pull.number === parameters.pull_number);
        if (!pull) throw httpError(404);
        return {
          ...pull, node_id: pull.nodeId, merged_at: null, state: closed.has(pull.number) ? "closed" : pull.state,
          draft: pull.arm === "trunk" ? draft : false,
          body: pull.arm === "trunk" ? body : pull.body,
          head: { ref: pull.head, sha: pull.arm === "trunk" ? trunkHead : pull.headSha, repo: { full_name: "acme/widgets" } }, base: { ref: pull.base },
        };
      }
      if (route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge") { trunkHead = "merged-trunk"; return { merged: true, sha: trunkHead }; }
      if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}" && typeof parameters.body === "string") body = parameters.body;
      if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}" && parameters.state === "closed") closed.add(Number(parameters.pull_number));
      if (route === "POST /graphql") {
        if (String(parameters.query).includes("markPullRequestReadyForReview")) { draft = false; return { data: { markPullRequestReadyForReview: {} } }; }
        if (String(parameters.query).includes("enablePullRequestAutoMerge")) return { data: { enablePullRequestAutoMerge: {} } };
        const updates = (parameters.variables as { input: { refUpdates: Array<{ afterOid: string }> } }).input.refUpdates;
        if (updates[0]?.afterOid === "promoted") trunkHead = "promoted";
        return { data: { updateRefs: {} } };
      }
      if (route.startsWith("GET /repos/{owner}/{repo}/git/ref/")) {
        const arm = String(parameters.ref).split("/").at(-1);
        return { object: { sha: arm === "trunk" ? "trunk-head" : `sha-${arm}` } };
      }
      if (route.startsWith("GET /repos/{owner}/{repo}/git/commits/")) return { tree: { sha: "t" }, parents: [{ sha: "sha-trunk" }] };
      if (route === "POST /repos/{owner}/{repo}/git/trees") return { sha: "t2" };
      if (route === "POST /repos/{owner}/{repo}/git/commits") return { sha: "promoted" };
      if (route.startsWith("GET")) return [];
      return {};
    });
    const decision: Decision = { action: "promote", winner: "lockfile", losers: ["packagemanager"], reason: "lockfile improved", scores: [] };
    const custom = { ...config, promotion: { ...config.promotion, reviewers: ["octocat", "acme/platform"], autoMerge: true } };
    const measurements = evidence(planned);
    const result = await applyDecision(client, repo, { manifest, decision, state: planned, config: custom, measurements });
    expect(result).toMatchObject({ action: "promote", merged: 11, closed: [12] });

    const merge = client.calls.find((call) => call.route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge");
    expect(merge?.parameters).toMatchObject({ pull_number: 11, merge_method: "squash", sha: "sha-lockfile" });
    const refUpdates = client.calls.filter((call) => call.route === "POST /graphql" && String(call.parameters.query).includes("updateRefs"));
    expect(refUpdates[0]?.parameters.variables).toMatchObject({ input: { refUpdates: [{ beforeOid: "merged-trunk", afterOid: "promoted" }] } });
    const deleted = refUpdates.filter((call) =>
      (call.parameters.variables as { input: { refUpdates: Array<{ afterOid: string }> } }).input.refUpdates.some((update) => update.afterOid === "0".repeat(40)));
    expect(deleted.map((call) => call.parameters.variables)).toEqual([
      { input: { repositoryId: "repo-node", refUpdates: [{ name: "refs/heads/experiments/setup-cache-yarn/lockfile", beforeOid: "sha-lockfile", afterOid: "0".repeat(40), force: true }] } },
      { input: { repositoryId: "repo-node", refUpdates: [{ name: "refs/heads/experiments/setup-cache-yarn/packagemanager", beforeOid: "sha-packagemanager", afterOid: "0".repeat(40), force: true }] } },
    ]);
    const tree = client.calls.find((call) => call.route === "POST /repos/{owner}/{repo}/git/trees")?.parameters.tree as Array<{ content: string }>;
    expect(parseManifest(tree[0]?.content ?? "").manifest).toMatchObject({ status: "promoted", winner: "lockfile" });
    expect(client.calls.some((call) => call.route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}")).toBe(false);
    expect(client.calls.find((call) => call.route.endsWith("/requested_reviewers"))?.parameters).toMatchObject({ reviewers: ["octocat"], team_reviewers: ["platform"] });
    const mutations = client.calls.filter((call) => call.route === "POST /graphql").map((call) => String(call.parameters.query));
    expect(mutations.some((query) => query.includes("markPullRequestReadyForReview"))).toBe(true);
    expect(mutations.some((query) => query.includes("enablePullRequestAutoMerge"))).toBe(true);
    expect(client.calls.find((call) => call.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels" && call.parameters.issue_number === 10)?.parameters.labels).toContain("experiment:promote");
  });

  it("rejects a missing winner without touching anything", async () => {
    const client = fakeClient();
    const decision: Decision = { action: "promote", winner: "ghost", losers: [], reason: "", scores: [] };
    await expect(applyDecision(client, repo, { manifest, decision, state: state(), config })).rejects.toThrow("open winner and trunk");
    expect(client.calls).toHaveLength(0);
  });

  it.each(["human", "fork", "unknown"])("refuses to close an experiment with %s ownership/head evidence", async (changed) => {
    const planned = state();
    const arm = planned.arms[0]!;
    if (changed === "fork") arm.headRepository = "fork/widgets";
    if (changed === "unknown") delete arm.headRepository;
    const client = fakeClient((route, parameters) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        const pr = [planned.trunk!, ...planned.arms].find((pull) => pull.number === parameters.pull_number)!;
        return rawPull({ ...pr, headSha: changed === "human" && pr.number === arm.number ? "human" : pr.headSha });
      }
      return route.startsWith("GET") ? [] : {};
    });
    await expect(applyDecision(client, repo, {
      manifest, decision: { action: "reject", reason: "stop", scores: [] }, state: planned, config, measurements: evidence(planned),
    })).rejects.toThrow(/[Rr]ecollect/);
    expect(client.calls.every((call) => call.route.startsWith("GET"))).toBe(true);
    expect(routes(client)).not.toContain("POST /graphql");
    expect(routes(client).some((route) => route.startsWith("DELETE"))).toBe(false);
  });

  it("closes arms and the trunk, labels the outcome, and deletes the trunk on reject", async () => {
    const closedArm = pull("packagemanager", { number: 12, state: "closed" });
    const planned = { ...state(), arms: [pull("lockfile", { number: 11 }), closedArm] };
    const closed = new Set<number>([closedArm.number]);
    const client = fakeClient((route, parameters) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        const pr = [planned.trunk!, ...planned.arms].find((pull) => pull.number === parameters.pull_number)!;
        return rawPull({ ...pr, state: closed.has(pr.number) ? "closed" : pr.state });
      }
      if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}" && parameters.state === "closed") closed.add(Number(parameters.pull_number));
      if (route === "GET /repos/{owner}/{repo}") return { node_id: "repo-node", default_branch: "main" };
      if (route === "POST /graphql") return { data: { updateRefs: {} } };
      if (route.startsWith("GET /repos/{owner}/{repo}/git/ref/")) return { object: { sha: `sha-${String(parameters.ref).split("/").at(-1)}` } };
      return route.startsWith("GET") ? [] : {};
    });
    const decision: Decision = { action: "reject", reason: "no arm qualified", scores: [] };
    const result = await applyDecision(client, repo, { manifest, decision, state: planned, config, measurements: evidence(planned) });
    expect(result.closed).toEqual([11, 10]);
    expect(client.calls.find((call) => call.route === "POST /repos/{owner}/{repo}/labels")?.parameters).toMatchObject({ name: "experiment:rejected" });
    const deleted = client.calls.filter((call) => call.route === "POST /graphql");
    expect(deleted).toHaveLength(2);
    expect(deleted[1]?.parameters.variables).toMatchObject({ input: { refUpdates: [{ name: "refs/heads/experiments/setup-cache-yarn/trunk", beforeOid: "sha-trunk", afterOid: "0".repeat(40) }] } });
  });
});

describe("dispatchRuns", () => {
  it("caps runs per request", async () => {
    const client = fakeClient();
    expect(await dispatchRuns(client, repo, [{ ref: "r", arm: "a", workflow: "ci.yml", runs: 3 }], 2)).toBe(2);
  });
});
