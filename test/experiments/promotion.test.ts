import { describe, expect, it } from "vitest";
import { DEFAULT_HILL_CLIMB_CONFIG } from "../../src/experiments/config.js";
import type { Decision } from "../../src/experiments/decide.js";
import { applyDecision, type ExperimentPullRequest, type ExperimentState } from "../../src/experiments/github.js";
import type { ExperimentMeasurements } from "../../src/experiments/score.js";
import { fakeClient, httpError, repo, sampleManifest } from "./fixtures.js";

const mergeRoute = "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge";
const refMutation = "POST /graphql";
const zero = "0".repeat(40);

function fixture(mergeResponse: unknown = { merged: true, sha: "merged-trunk" }) {
  const manifest = sampleManifest();
  const branch = (arm: string) => `experiments/${manifest.name}/${arm}`;
  const pr = (arm: string, number: number): ExperimentPullRequest => ({
    number, nodeId: `PR_${number}`, state: "open", merged: false, draft: arm === "trunk",
    title: arm, body: "", labels: ["experiment"], head: branch(arm), headSha: `sha-${arm}`,
    headRepository: "acme/widgets", base: arm === "trunk" ? "main" : branch("trunk"), experiment: manifest.name, arm,
  });
  const trunk = pr("trunk", 10);
  const winner = pr("lockfile", 11);
  const loser = pr("packagemanager", 12);
  const state: ExperimentState = { name: manifest.name, trunk, arms: [winner, loser] };
  const live = new Map([trunk, winner, loser].map((pull) => [pull.number, structuredClone(pull)]));
  const heads: Record<string, string> = Object.fromEntries([trunk, winner, loser].map((pull) => [pull.head, pull.headSha]));
  const measurements: ExperimentMeasurements = {
    experiment: manifest.name, collectedAt: manifest.createdAt,
    control: { arm: "trunk", headSha: trunk.headSha, pullRequest: trunk.number, changedPaths: [] },
    arms: [winner, loser].map((pull) => ({ arm: pull.arm, headSha: pull.headSha, pullRequest: pull.number, changedPaths: [] })),
  };
  const decision: Decision = { action: "promote", winner: "lockfile", losers: ["packagemanager"], scores: [], reason: "measured improvement" };
  const options = { manifest, state, measurements, decision, config: DEFAULT_HILL_CLIMB_CONFIG };
  const current = (number: number) => {
    const pull = live.get(number);
    if (!pull) throw httpError(404);
    return pull;
  };
  const raw = (pull: ExperimentPullRequest) => ({
    ...pull, node_id: pull.nodeId, merged_at: pull.merged ? "2026-11-02T00:00:00Z" : null,
    head: { ref: pull.head, sha: pull.headSha, repo: pull.headRepository ? { full_name: pull.headRepository } : null },
    base: { ref: pull.base }, labels: pull.labels.map((name) => ({ name })),
  });
  const update = (ref: string, sha: string) => {
    if (sha === zero) delete heads[ref];
    else {
      heads[ref] = sha;
      for (const pull of live.values()) if (pull.head === ref) pull.headSha = sha;
    }
  };
  const client = fakeClient((route, parameters) => {
    if (route === "GET /repos/{owner}/{repo}") return { node_id: "repo-node", default_branch: "main" };
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return raw(current(Number(parameters.pull_number)));
    if (route === "GET /repos/{owner}/{repo}/pulls") return [...live.values()]
      .filter((pull) => pull.state === parameters.state && `${repo.owner}:${pull.head}` === parameters.head).map(raw);
    if (route === mergeRoute) {
      if (typeof mergeResponse === "object" && mergeResponse !== null && "merged" in mergeResponse && mergeResponse.merged === true) {
        current(winner.number).state = "closed";
        current(winner.number).merged = true;
        update(trunk.head, "merged-trunk");
      }
      return mergeResponse;
    }
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      const sha = heads[String(parameters.ref).slice("heads/".length)];
      if (!sha) throw httpError(404);
      return { object: { sha } };
    }
    if (route === refMutation) {
      const query = String(parameters.query);
      if (query.includes("updateRefs")) {
        const variables = parameters.variables as { input: { refUpdates: Array<{ name: string; beforeOid: string; afterOid: string }> } };
        for (const ref of variables.input.refUpdates) {
          const name = ref.name.slice("refs/heads/".length);
          if (heads[name] !== ref.beforeOid) return { data: { updateRefs: null }, errors: [{ message: "Reference no longer points to the expected commit" }] };
          update(name, ref.afterOid);
        }
        return { data: { updateRefs: {} } };
      }
      if (query.includes("markPullRequestReadyForReview")) {
        current(trunk.number).draft = false;
        return { data: { markPullRequestReadyForReview: {} } };
      }
      if (query.includes("enablePullRequestAutoMerge")) return { data: { enablePullRequestAutoMerge: {} } };
      throw new Error(`Unexpected mutation: ${query}`);
    }
    if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") return { tree: { sha: "tree" } };
    if (route === "POST /repos/{owner}/{repo}/git/trees") return { sha: "promoted-tree" };
    if (route === "POST /repos/{owner}/{repo}/git/commits") return { sha: "promoted" };
    if (route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}") {
      update(String(parameters.ref).slice("heads/".length), String(parameters.sha));
      return { object: { sha: parameters.sha } };
    }
    if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") {
      const pull = current(Number(parameters.pull_number));
      if (parameters.state === "closed") pull.state = "closed";
      if (typeof parameters.body === "string") pull.body = parameters.body;
      return raw(pull);
    }
    if (route.startsWith("GET")) return [];
    return {};
  });
  return { client, options, heads, live, current, trunk, winner, loser };
}

describe("verified experiment promotion", () => {
  it.each([false, undefined, null])("does not promote or clean branches without a confirmed merge (%s)", async (merged) => {
    const f = fixture({ merged, sha: "merged-trunk" });
    await expect(applyDecision(f.client, repo, f.options)).rejects.toThrow("did not confirm");
    expect(f.client.calls.filter((call) => !call.route.startsWith("GET")).map((call) => call.route)).toEqual([mergeRoute]);
    expect(f.heads[f.winner.head]).toBe(f.winner.headSha);
    expect(f.current(f.loser.number).state).toBe("open");
  });

  it.each(["winner", "control"])("does not promote a %s commit that differs from the collected evidence", async (changed) => {
    const f = fixture();
    if (changed === "winner") f.options.measurements.arms[0]!.headSha = "previous-winner";
    else f.options.measurements.control.headSha = "previous-control";
    await expect(applyDecision(f.client, repo, f.options)).rejects.toThrow(/[Rr]ecollect/);
    expect(f.client.calls.filter((call) => !call.route.startsWith("GET"))).toEqual([]);
    expect(f.heads[f.winner.head]).toBe(f.winner.headSha);
    expect(f.heads[f.trunk.head]).toBe(f.trunk.headSha);
  });
});
