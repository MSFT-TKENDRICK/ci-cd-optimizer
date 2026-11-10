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
  OUTCOME_LABELS,
  PROMOTE_LABEL,
  resumeExperiment,
  type ExperimentPullRequest,
  type ExperimentState,
} from "../../src/experiments/github.js";
import { parseManifest, serializeManifest } from "../../src/experiments/manifest.js";
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

  it.each(["open", "closed", "all"] as const)("exhausts %s PR pagination beyond ten full pages", async (requestedState) => {
    const client = fakeClient((_route, parameters) => {
      expect(parameters.state).toBe(requestedState);
      const page = Number(parameters.page);
      if (page <= 10) return Array.from({ length: 100 }, (_, index) =>
        rawPull(pull("trunk", { number: (page - 1) * 100 + index + 1, head: `feature/${page}-${index}` })));
      return [rawPull(pull("trunk", { number: 1001, state: requestedState === "closed" ? "closed" : "open" }))];
    });
    const pulls = await listExperimentPullRequests(client, repo, requestedState);
    expect(pulls.map((entry) => entry.number)).toEqual([1001]);
    expect(client.calls.map((call) => call.parameters.page)).toEqual(Array.from({ length: 11 }, (_, index) => index + 1));
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

  it("refuses to overwrite an existing experiment and never downgrades a failed draft request", async () => {
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
    await expect(createExperiment(noDraft, repo, { manifest: sampleManifest(), baseBranch: "main", config })).rejects.toThrow("publication did not finish");
    expect(attempts).toBe(1);
  });

  it("reports the exact retained trunk and recovery command when PR publication fails", async () => {
    const client = fakeClient((route) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/git/ref/")) return { object: { sha: "base" } };
      if (route.startsWith("GET /repos/{owner}/{repo}/git/commits/")) return { tree: { sha: "t" } };
      if (route === "POST /repos/{owner}/{repo}/pulls") throw httpError(403);
      return { sha: "a".repeat(40) };
    });
    await expect(createExperiment(client, repo, { manifest: sampleManifest(), baseBranch: "main", config }))
      .rejects.toThrow(`resume --experiment setup-cache-yarn --expected-head ${"a".repeat(40)} --base main`);
    expect(routes(client).some((route) => route.includes("DELETE") || route.includes("dispatches"))).toBe(false);
  });

  it("reports uncertain trunk creation without blindly retrying the write", async () => {
    const client = fakeClient((route) => {
      if (route.startsWith("GET /repos/{owner}/{repo}/git/ref/")) return { object: { sha: "base" } };
      if (route.startsWith("GET /repos/{owner}/{repo}/git/commits/")) return { tree: { sha: "t" } };
      if (route === "POST /repos/{owner}/{repo}/git/refs") throw httpError(502);
      return { sha: "a".repeat(40) };
    });
    await expect(createExperiment(client, repo, { manifest: sampleManifest(), baseBranch: "main", config }))
      .rejects.toThrow(`Cannot confirm creation of experiments/setup-cache-yarn/trunk at ${"a".repeat(40)}`);
    expect(routes(client).filter((route) => route.endsWith("/git/refs"))).toHaveLength(1);
    expect(routes(client)).not.toContain("POST /repos/{owner}/{repo}/pulls");
  });
});

describe("resumeExperiment", () => {
  const sha = "a".repeat(40);
  const now = new Date("2026-11-05T00:00:00Z");
  const options = { name: "setup-cache-yarn", expectedSha: sha, config, now };
  const raw = () => rawPull(pull("trunk", { headSha: sha, body: experimentBody(sampleManifest(), config) }));

  function fixture(settings: {
    existing?: ReturnType<typeof raw>;
    manifest?: ReturnType<typeof sampleManifest>;
    head?: string;
    full?: boolean;
    unrelatedPages?: number;
    changeAfterLabel?: boolean;
    ignoreLabelWrite?: boolean;
    lostCreateResponse?: boolean;
    outcomeAfterLabel?: string;
    failClose?: boolean;
  } = {}) {
    let existing = settings.existing;
    let head = settings.head ?? sha;
    const client = fakeClient((route, parameters) => {
      if (route === "GET /repos/{owner}/{repo}") return { default_branch: "main" };
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { object: { sha: parameters.ref === "heads/main" ? "b".repeat(40) : head } };
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        expect(parameters.ref).toBe(sha);
        return { encoding: "base64", content: Buffer.from(serializeManifest(settings.manifest ?? sampleManifest())).toString("base64") };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls") {
        if (parameters.head) return existing ? [existing] : [];
        if (Number(parameters.page) <= (settings.unrelatedPages ?? 0)) {
          return Array.from({ length: 100 }, (_, index) => ({
            ...raw(), number: Number(parameters.page) * 100 + index, head: { ...raw().head, ref: `feature/${parameters.page}-${index}` },
          }));
        }
        return settings.full ? ["alpha", "beta", "gamma"].map((name) => ({
          ...raw(), head: { ...raw().head, ref: `experiments/${name}/trunk` },
        })) : [];
      }
      if (route === "POST /repos/{owner}/{repo}/pulls") {
        existing = { ...raw(), labels: [] };
        if (settings.lostCreateResponse) throw httpError(408);
        return { number: existing.number };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return existing;
      if (route === "GET /repos/{owner}/{repo}/labels") return ["experiment", ...Object.values(OUTCOME_LABELS)].map((name) => ({ name }));
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") return [];
      if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments") return { id: 1 };
      if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels") {
        if (settings.changeAfterLabel) head = "c".repeat(40);
        if (existing && !settings.ignoreLabelWrite) {
          const names = new Set([...existing.labels.map((label) => label.name), ...parameters.labels as string[]]);
          if (settings.outcomeAfterLabel) names.add(settings.outcomeAfterLabel);
          existing.labels = [...names].map((name) => ({ name }));
        }
        return [];
      }
      if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}" && settings.failClose && parameters.state === "closed") throw httpError(500);
      throw new Error(`Unexpected request: ${route}`);
    });
    return client;
  }

  it("restores a missing promotion PR without recreating the branch or starting agents", async () => {
    const client = fixture();
    await expect(resumeExperiment(client, repo, options)).resolves.toEqual({
      trunk: "experiments/setup-cache-yarn/trunk", sha, baseBranch: "main", pullRequest: 10, created: true,
    });
    expect(client.calls.filter((call) => !call.route.startsWith("GET")).map((call) => call.route)).toEqual([
      "POST /repos/{owner}/{repo}/pulls",
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
    ]);
  });

  it("reuses and repairs an existing matching PR after a partial label failure", async () => {
    const client = fixture({ existing: raw() });
    await expect(resumeExperiment(client, repo, options)).resolves.toMatchObject({ pullRequest: 10, created: false });
    expect(routes(client)).not.toContain("POST /repos/{owner}/{repo}/pulls");
  });

  it("recovers a lost creation response without creating a duplicate PR", async () => {
    const client = fixture({ lostCreateResponse: true });
    await expect(resumeExperiment(client, repo, options)).rejects.toThrow("HTTP 408");
    await expect(resumeExperiment(client, repo, options)).resolves.toMatchObject({ pullRequest: 10, created: false });
    expect(routes(client).filter((route) => route === "POST /repos/{owner}/{repo}/pulls")).toHaveLength(1);
  });

  it("previews recovery without writing or dispatching", async () => {
    const client = fixture();
    await expect(resumeExperiment(client, repo, { ...options, dryRun: true })).resolves.toMatchObject({ sha, created: false });
    expect(routes(client).every((route) => route.startsWith("GET"))).toBe(true);
  });

  it.each([
    ["stale", "trunk changed"], ["completed", "valid running experiment"], ["expired", "has expired"],
    ["closed", "not owned by this experiment"], ["foreign", "not owned by this experiment"],
    ["ready", "not owned by this experiment"],
    ["retargeted", "not owned by this experiment"], ["unmarked", "not owned by this experiment"],
    ["budget", "budget is already full"], ["rubric", "proposal rubric"], ["future", "creation time is in the future"],
  ] as const)(
    "refuses %s recovery before writing", async (scenario, error) => {
      const current = raw();
      const client = fixture({
        ...(scenario === "stale" ? { head: "c".repeat(40) } : {}),
        ...(scenario === "completed" ? { manifest: sampleManifest({ status: "rejected" }) } : {}),
        ...(scenario === "expired" ? { manifest: sampleManifest({ expiresAt: "2026-11-04T00:00:00Z" }) } : {}),
        ...(scenario === "closed" ? { existing: { ...current, state: "closed" } } : {}),
        ...(scenario === "ready" ? { existing: { ...current, draft: false } } : {}),
        ...(scenario === "foreign" ? { existing: { ...current, head: { ...current.head, repo: { full_name: "someone/else" } } } } : {}),
        ...(scenario === "retargeted" ? { existing: { ...current, base: { ref: "release" } } } : {}),
        ...(scenario === "unmarked" ? { existing: { ...current, body: "A human-owned pull request." } } : {}),
        ...(scenario === "budget" ? { full: true } : {}),
        ...(scenario === "rubric" ? { manifest: sampleManifest({ rubric: { scores: { impact: 1, evidence: 1, safety: 1, generality: 1, measurability: 1 }, rationale: "Below the bar." } }) } : {}),
        ...(scenario === "future" ? { manifest: sampleManifest({ createdAt: "2026-11-06T00:00:00Z" }) } : {}),
      });
      await expect(resumeExperiment(client, repo, options)).rejects.toThrow(error);
      expect(routes(client).every((route) => route.startsWith("GET"))).toBe(true);
    },
  );

  it("does not claim publication succeeded when the branch moves during recovery", async () => {
    const client = fixture({ changeAfterLabel: true });
    await expect(resumeExperiment(client, repo, options)).rejects.toThrow("trunk changed");
    expect(routes(client).some((route) => route.includes("dispatches") || route.includes("DELETE"))).toBe(false);
  });

  it("requires the label write to persist before confirming publication", async () => {
    const client = fixture({ ignoreLabelWrite: true });
    await expect(resumeExperiment(client, repo, options)).rejects.toThrow("publication is not confirmed");
  });

  it("does not bypass a full budget hidden behind a thousand unrelated PRs", async () => {
    const client = fixture({ full: true, unrelatedPages: 10 });
    await expect(resumeExperiment(client, repo, options)).rejects.toThrow("budget is already full");
    const inventory = client.calls.filter((call) => call.route === "GET /repos/{owner}/{repo}/pulls" && !call.parameters.head);
    expect(inventory.at(-1)?.parameters.page).toBe(11);
    expect(routes(client).every((route) => route.startsWith("GET"))).toBe(true);
  });

  it.each([PROMOTE_LABEL, ...Object.values(OUTCOME_LABELS), "EXPERIMENT:REJECTED"])("refuses the recorded outcome label %s before writing", async (name) => {
    const client = fixture({ existing: { ...raw(), labels: [{ name }] } });
    await expect(resumeExperiment(client, repo, options)).rejects.toThrow("completed, changed, or not owned");
    expect(routes(client).every((route) => route.startsWith("GET"))).toBe(true);
  });

  it("refuses an interrupted rejection after its outcome label persisted but closing failed", async () => {
    const client = fixture({ existing: raw(), failClose: true });
    const planned: ExperimentState = { name: options.name, trunk: pull("trunk", { headSha: sha }), arms: [] };
    const decision: Decision = { action: "reject", reason: "No eligible improvement.", scores: [] };
    await expect(applyDecision(client, repo, {
      manifest: sampleManifest(), decision, state: planned, config, measurements: evidence(planned),
    })).rejects.toThrow("HTTP 500");
    expect(client.calls.find((call) => call.route.endsWith("/labels") && call.route.startsWith("POST"))?.parameters.labels).toEqual([OUTCOME_LABELS.reject]);
    const beforeRecovery = client.calls.length;
    await expect(resumeExperiment(client, repo, options)).rejects.toThrow("completed, changed, or not owned");
    expect(client.calls.slice(beforeRecovery).every((call) => call.route.startsWith("GET"))).toBe(true);
  });

  it("does not confirm publication if a terminal outcome is recorded during recovery", async () => {
    const client = fixture({ outcomeAfterLabel: OUTCOME_LABELS.expire });
    await expect(resumeExperiment(client, repo, options)).rejects.toThrow("publication is not confirmed");
  });

  it.each([{ name: "../../main" }, { expectedSha: "HEAD" }])("requires a bounded name and an exact commit", async (override) => {
    const client = fixture();
    await expect(resumeExperiment(client, repo, { ...options, ...override })).rejects.toThrow("exact 40-character");
    expect(client.calls).toEqual([]);
  });
});

describe("applyDecision", () => {
  const manifest = sampleManifest();

  it("uses a separate dispatch credential without sending it to PR publication", async () => {
    const publisher = fakeClient((route) => route.endsWith("/comments") && route.startsWith("GET") ? [] : {});
    const dispatcher = fakeClient();
    const decision: Decision = {
      action: "wait", reason: "Collecting samples.", scores: [],
      dispatch: [{ ref: "experiments/setup-cache-yarn/trunk", arm: "trunk", workflow: "ci.yml", runs: 1 }],
    };
    const result = await applyDecision(publisher, repo, { manifest, decision, state: state(), config, dispatchClient: dispatcher });
    expect(result.dispatched).toBe(1);
    expect(routes(dispatcher)).toEqual(["POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches"]);
    expect(routes(publisher).some((route) => route.includes("/actions/"))).toBe(false);
    expect(routes(publisher)).toContain("POST /repos/{owner}/{repo}/issues/{issue_number}/comments");
  });

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
