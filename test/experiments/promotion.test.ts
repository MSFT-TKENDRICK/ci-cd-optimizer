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
    if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") return { tree: { sha: "tree" }, parents: [{ sha: trunk.headSha }] };
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

function expectArmsRetained(f: ReturnType<typeof fixture>): void {
  expect(f.heads[f.winner.head]).toBe(f.winner.headSha);
  expect(f.heads[f.loser.head]).toBe(f.loser.headSha);
  expect(f.current(f.loser.number).state).toBe("open");
  expect(f.client.calls.some((call) => call.route === refMutation &&
    (call.parameters.variables as { input?: { refUpdates?: Array<{ afterOid: string }> } })?.input?.refUpdates?.some((update) => update.afterOid === zero))).toBe(false);
}

describe("verified experiment promotion", () => {
  it.each([false, undefined, null])("does not promote or clean branches without a confirmed merge (%s)", async (merged) => {
    const f = fixture({ merged, sha: "merged-trunk" });
    await expect(applyDecision(f.client, repo, f.options)).rejects.toThrow("did not confirm");
    expect(f.client.calls.filter((call) => !call.route.startsWith("GET")).map((call) => call.route)).toEqual([mergeRoute]);
    expect(f.heads[f.winner.head]).toBe(f.winner.headSha);
    expect(f.current(f.loser.number).state).toBe("open");
  });

  describe("verified experiment closure", () => {
    const outcome = (f: ReturnType<typeof fixture>, action: "reject" | "expire" = "reject") => ({
      ...f.options, decision: { action, scores: [], reason: "experiment ended" } satisfies Decision,
    });

    it.each(["reject", "expire"] as const)("does not report an unpersisted %s closure as success", async (action) => {
      const f = fixture();
      const original = f.client.request.bind(f.client);
      f.client.request = async (route, parameters = {}) =>
        route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}" && parameters.state === "closed"
          ? { status: 200, data: {} } : original(route, parameters);
      await expect(applyDecision(f.client, repo, outcome(f, action))).rejects.toThrow();
      expectArmsRetained(f);
      expect(f.current(f.trunk.number).state).toBe("open");
    });

    it.each(["head", "fork"])("refuses stale %s identity before posting or closing anything", async (changed) => {
      const f = fixture();
      if (changed === "head") {
        f.current(f.winner.number).headSha = "human";
        f.heads[f.winner.head] = "human";
      } else {
        f.current(f.winner.number).headRepository = "fork/widgets";
      }
      await expect(applyDecision(f.client, repo, outcome(f))).rejects.toThrow(/[Rr]ecollect/);
      expect(f.client.calls.filter((call) => !call.route.startsWith("GET"))).toEqual([]);
      expect(f.current(f.winner.number).state).toBe("open");
    });

    it("rereads identity after the comment and before closing the PR", async () => {
      const f = fixture();
      const original = f.client.request.bind(f.client);
      let injected = false;
      f.client.request = async (route, parameters = {}) => {
        const response = await original(route, parameters);
        if (!injected && route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments") {
          injected = true;
          f.current(f.winner.number).base = "main";
        }
        return response;
      };
      await expect(applyDecision(f.client, repo, outcome(f))).rejects.toThrow(/[Rr]ecollect/);
      expect(injected).toBe(true);
      expect(f.client.calls.some((call) => call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}")).toBe(false);
      expectArmsRetained(f);
    });

    it.each(["reject", "expire"] as const)("closes verified %s targets and cleans their exact heads", async (action) => {
      const f = fixture();
      const result = await applyDecision(f.client, repo, outcome(f, action));
      expect(result).toMatchObject({ action, closed: [11, 12, 10], notes: [] });
      expect([...f.live.values()].every((pull) => pull.state === "closed")).toBe(true);
      expect(f.heads).toEqual({});
      expect(f.client.calls.filter((call) => call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}")).toHaveLength(3);
    });

    it.each(["control", "winner", "loser", "missing"] as const)("refuses %s measurement gaps before closing", async (changed) => {
      const f = fixture();
      const options: Parameters<typeof applyDecision>[2] = outcome(f);
      if (changed === "control") f.options.measurements.control.headSha = "old-control";
      if (changed === "winner") f.options.measurements.arms[0]!.headSha = "old-winner";
      if (changed === "loser") f.options.measurements.arms[1]!.pullRequest = 99;
      if (changed === "missing") delete options.measurements;
      await expect(applyDecision(f.client, repo, options)).rejects.toThrow(/[Rr]ecollect/);
      expect(f.client.calls).toEqual([]);
      expectArmsRetained(f);
    });

    it.each(["trunk base", "loser head", "closed loser", "merged trunk", "node ID", "unknown owner"])(
      "verifies every outcome target before starting the batch (%s)",
      async (changed) => {
        const f = fixture();
        if (changed === "trunk base") f.current(f.trunk.number).base = "release";
        if (changed === "loser head") f.current(f.loser.number).headSha = "human";
        if (changed === "closed loser") f.current(f.loser.number).state = "closed";
        if (changed === "merged trunk") f.current(f.trunk.number).merged = true;
        if (changed === "node ID") f.current(f.loser.number).nodeId = "another-pr";
        if (changed === "unknown owner") delete f.current(f.trunk.number).headRepository;
        await expect(applyDecision(f.client, repo, outcome(f))).rejects.toThrow(/[Rr]ecollect/);
        expect(f.client.calls.every((call) => call.route.startsWith("GET"))).toBe(true);
        expect(f.heads[f.winner.head]).toBe(f.winner.headSha);
      },
    );

    it.each(["reopened", "head changed", "retargeted", "merged", "lost response"])("does not clean up an unverified closed target (%s)", async (fault) => {
      const f = fixture();
      const original = f.client.request.bind(f.client);
      let injected = false;
      f.client.request = async (route, parameters = {}) => {
        const response = await original(route, parameters);
        if (!injected && route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}" && parameters.state === "closed") {
          injected = true;
          if (fault === "reopened") f.current(f.winner.number).state = "open";
          if (fault === "head changed") {
            f.current(f.winner.number).headSha = "human";
            f.heads[f.winner.head] = "human";
          }
          if (fault === "retargeted") f.current(f.winner.number).base = "main";
          if (fault === "merged") f.current(f.winner.number).merged = true;
          if (fault === "lost response") throw httpError(500);
        }
        return response;
      };
      await expect(applyDecision(f.client, repo, outcome(f))).rejects.toThrow();
      expect(injected).toBe(true);
      expect(f.heads[f.winner.head]).toBe(fault === "head changed" ? "human" : f.winner.headSha);
      expect(f.heads[f.loser.head]).toBe(f.loser.headSha);
      expect(f.current(f.loser.number).state).toBe("open");
      expect(f.client.calls.some((call) => call.route === refMutation)).toBe(false);
    });

    it.each(["trunk closure", "trunk labels", "promotion loser"])("applies closure verification to %s", async (fault) => {
      const f = fixture();
      const target = fault === "promotion loser" ? f.loser : f.trunk;
      const original = f.client.request.bind(f.client);
      let injected = false;
      f.client.request = async (route, parameters = {}) => {
        if (fault !== "trunk labels" && route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}" &&
          parameters.pull_number === target.number && parameters.state === "closed") {
          injected = true;
          return { status: 200, data: {} };
        }
        const response = await original(route, parameters);
        if (fault === "trunk labels" && route === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels") {
          injected = true;
          f.current(f.trunk.number).base = "release";
        }
        return response;
      };
      await expect(applyDecision(f.client, repo, fault === "promotion loser" ? f.options : outcome(f))).rejects.toThrow();
      expect(injected).toBe(true);
      expect(f.current(target.number).state).toBe("open");
      expect(f.heads[target.head]).toBe(target.headSha);
    });
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

  it.each([null, {}, { merged: true }, { merged: true, sha: "" }, { merged: true, sha: " " }, { merged: "true", sha: "merged-trunk" }])(
    "rejects a malformed merge acknowledgement (%j)",
    async (response) => {
      const f = fixture(response);
      await expect(applyDecision(f.client, repo, f.options)).rejects.toThrow("did not confirm");
      expectArmsRetained(f);
    },
  );

  it.each(["control PR", "winner PR", "loser head", "missing head", "duplicate arm"])("requires complete evidence binding (%s)", async (missing) => {
    const f = fixture();
    if (missing === "control PR") delete f.options.measurements.control.pullRequest;
    if (missing === "winner PR") f.options.measurements.arms[0]!.pullRequest = 99;
    if (missing === "loser head") f.options.measurements.arms[1]!.headSha = "old-loser";
    if (missing === "missing head") delete f.options.measurements.arms[0]!.headSha;
    if (missing === "duplicate arm") f.options.measurements.arms.push(structuredClone(f.options.measurements.arms[0]!));
    await expect(applyDecision(f.client, repo, f.options)).rejects.toThrow(/[Rr]ecollect/);
    expect(f.client.calls).toEqual([]);
  });

  it("requires measurements for applied promotion rather than trusting a decision alone", async () => {
    const f = fixture();
    const { manifest, state, decision, config } = f.options;
    await expect(applyDecision(f.client, repo, { manifest, state, decision, config })).rejects.toThrow(/[Rr]ecollect/);
    expect(f.client.calls).toEqual([]);
  });

  it.each(["winner head", "trunk head", "loser head", "fork", "unknown owner", "winner base", "trunk base", "closed trunk", "draft winner", "node ID"])(
    "rereads promotion PR identity before merging (%s)",
    async (changed) => {
      const f = fixture();
      if (changed === "winner head") f.current(f.winner.number).headSha = "human";
      if (changed === "trunk head") f.current(f.trunk.number).headSha = "human";
      if (changed === "loser head") f.current(f.loser.number).headSha = "human";
      if (changed === "fork") f.current(f.winner.number).headRepository = "fork/widgets";
      if (changed === "unknown owner") delete f.current(f.trunk.number).headRepository;
      if (changed === "winner base") f.current(f.winner.number).base = "main";
      if (changed === "trunk base") f.current(f.trunk.number).base = "release";
      if (changed === "closed trunk") f.current(f.trunk.number).state = "closed";
      if (changed === "draft winner") f.current(f.winner.number).draft = true;
      if (changed === "node ID") f.current(f.trunk.number).nodeId = "another-pr";
      await expect(applyDecision(f.client, repo, f.options)).rejects.toThrow(/[Rr]ecollect/);
      expect(f.client.calls.filter((call) => !call.route.startsWith("GET"))).toEqual([]);
      expectArmsRetained(f);
    },
  );

  it.each(["after merge", "before ref write", "after ref write", "lost ref response"])("retains arms after interrupted promotion (%s)", async (fault) => {
    const f = fixture();
    const original = f.client.request.bind(f.client);
    let injected = false;
    f.client.request = async (route, parameters = {}) => {
      const response = await original(route, parameters);
      const writingRef = route === refMutation && String(parameters.query).includes("updateRefs");
      if (!injected && ((fault === "after merge" && route === mergeRoute) ||
        (fault === "before ref write" && route === "POST /repos/{owner}/{repo}/git/commits") ||
        ((fault === "after ref write" || fault === "lost ref response") && writingRef))) {
        injected = true;
        if (fault === "lost ref response") throw httpError(500);
        f.heads[f.trunk.head] = "human";
        f.current(f.trunk.number).headSha = "human";
      }
      return response;
    };
    await expect(applyDecision(f.client, repo, f.options)).rejects.toThrow();
    expect(injected).toBe(true);
    expect(f.heads[f.trunk.head]).toBe(fault === "lost ref response" ? "promoted" : "human");
    expectArmsRetained(f);
    expect(f.current(f.trunk.number).body).toBe("");
  });

  it.each([
    { parents: undefined },
    { parents: [] },
    { parents: [{ sha: "newer-control" }] },
    { parents: [{ sha: "sha-trunk" }, { sha: "another-parent" }] },
  ])(
    "refuses a squash merge with an unverified control parent (%j)",
    async ({ parents }) => {
      const f = fixture();
      const original = f.client.request.bind(f.client);
      f.client.request = async (route, parameters) => route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}"
        ? { status: 200, data: { tree: { sha: "tree" }, parents } } : original(route, parameters);
      await expect(applyDecision(f.client, repo, f.options)).rejects.toThrow("not based on the measured control");
      expectArmsRetained(f);
      expect(f.client.calls.some((call) => call.route === "POST /repos/{owner}/{repo}/git/commits")).toBe(false);
    },
  );

  it.each(["ready null", "ready not persisted", "body not persisted", "ref null"])("does not clean up on an unconfirmed acknowledgement (%s)", async (fault) => {
    const f = fixture();
    const original = f.client.request.bind(f.client);
    let injected = false;
    f.client.request = async (route, parameters = {}) => {
      const ready = route === refMutation && String(parameters.query).includes("markPullRequestReadyForReview");
      if (fault === "ready not persisted" && ready) {
        injected = true;
        return { status: 200, data: { data: { markPullRequestReadyForReview: {} } } };
      }
      if (fault === "body not persisted" && route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}" && typeof parameters.body === "string") {
        injected = true;
        return { status: 200, data: {} };
      }
      const response = await original(route, parameters);
      if (fault === "ready null" && ready) {
        injected = true;
        return { status: 200, data: { data: { markPullRequestReadyForReview: null } } };
      }
      if (fault === "ref null" && route === refMutation && String(parameters.query).includes("updateRefs")) {
        injected = true;
        return { status: 200, data: { data: { updateRefs: null } } };
      }
      return response;
    };
    await expect(applyDecision(f.client, repo, f.options)).rejects.toThrow(/not acknowledge|not confirmed/);
    expect(injected).toBe(true);
    expectArmsRetained(f);
  });

  it.each([null, undefined, true, "ok", []].map((payload) => ({ payload })))("reports an unacknowledged optional auto-merge (%j)", async ({ payload }) => {
    const f = fixture();
    const original = f.client.request.bind(f.client);
    f.client.request = async (route, parameters = {}) =>
      route === refMutation && String(parameters.query).includes("enablePullRequestAutoMerge")
        ? { status: 200, data: { data: { enablePullRequestAutoMerge: payload } } } : original(route, parameters);
    const config = { ...f.options.config, promotion: { ...f.options.config.promotion, autoMerge: true } };
    const result = await applyDecision(f.client, repo, { ...f.options, config });
    expect(result.notes.join(" ")).toContain("auto-merge unavailable: GitHub did not acknowledge");
    expect(result).toMatchObject({ merged: 11, closed: [12] });
  });

  it("does not treat an accepted-but-incomplete HTTP response as a completed merge", async () => {
    const f = fixture();
    const original = f.client.request.bind(f.client);
    f.client.request = async (route, parameters) => {
      const response = await original(route, parameters);
      return route === mergeRoute ? { ...response, status: 202 } : response;
    };
    await expect(applyDecision(f.client, repo, f.options)).rejects.toThrow("did not confirm");
    expectArmsRetained(f);
  });

  it("retains a winner branch reused by another open PR before cleanup", async () => {
    const f = fixture();
    const original = f.client.request.bind(f.client);
    let injected = false;
    f.client.request = async (route, parameters = {}) => {
      const response = await original(route, parameters);
      if (!injected && route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        injected = true;
        f.live.set(99, { ...f.winner, number: 99, nodeId: "PR_99", state: "open" });
      }
      return response;
    };
    const result = await applyDecision(f.client, repo, f.options);
    expect(injected).toBe(true);
    expect(result.notes.join(" ")).toContain("an open PR uses it");
    expect(f.heads[f.winner.head]).toBe(f.winner.headSha);
  });
});
