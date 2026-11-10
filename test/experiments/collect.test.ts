import { describe, expect, it } from "vitest";
import { DEFAULT_HILL_CLIMB_CONFIG, type HillClimbConfig } from "../../src/experiments/config.js";
import { changedPaths, checksPassed, ciSamples, collectMeasurements, mergeMeasurement, verifyCiMeasurements } from "../../src/experiments/collect.js";
import type { ExperimentPullRequest } from "../../src/experiments/github.js";
import type { ExperimentMeasurements } from "../../src/experiments/score.js";
import { ciMeasurement, fakeClient, repo, sampleManifest, sampleSha } from "./fixtures.js";

const sha = "a".repeat(40);
const run = (id: number, sha: string, startedAt: string, updatedAt: string, branch = "b") => ({
  id,
  run_attempt: 1,
  workflow_id: 99,
  path: ".github/workflows/ci.yml",
  event: "workflow_dispatch",
  status: "completed",
  head_branch: branch,
  head_sha: sha,
  run_started_at: startedAt,
  created_at: startedAt,
  updated_at: updatedAt,
  conclusion: "success",
  repository: { full_name: "acme/widgets" },
  head_repository: { full_name: "acme/widgets" },
});

const job = (runId: number, id: number, name: string, duration: number) => ({
  id, run_id: runId, run_attempt: 1, head_sha: sha, status: "completed", name, conclusion: "success",
  started_at: "2026-11-02T00:00:00Z", completed_at: new Date(Date.parse("2026-11-02T00:00:00Z") + duration * 1000).toISOString(),
});

describe("ciSamples", () => {
  const spec = { id: "ci", source: "ci" as const, direction: "minimize" as const, weight: 1, workflow: "ci.yml" };

  it("measures only runs of the exact head SHA", async () => {
    const client = fakeClient(() => ({
      workflow_runs: [
        run(1, sha, "2026-11-02T00:00:00Z", "2026-11-02T00:01:40Z"),
        run(2, "old", "2026-11-02T00:00:00Z", "2026-11-02T00:10:00Z"),
        run(3, sha, "2026-11-02T00:00:00Z", "2026-11-02T00:02:00Z"),
      ],
    }));
    const evidence = await ciSamples(client, repo, spec, { branch: "b", headSha: sha, since: "2026-11-01T12:00:00Z" });
    expect(evidence.samples.map((sample) => sample.seconds)).toEqual([100, 120]);
    expect(evidence).toMatchObject({ schema: "cicd-optimizer/ci-evidence-v1", repository: "acme/widgets", workflow: "ci.yml" });
    expect(evidence.samples[0]).toMatchObject({ runId: 1, attempt: 1, headSha: sha, event: "workflow_dispatch", workflowId: 99 });
    expect(client.calls[0]?.parameters).toMatchObject({ workflow_id: "ci.yml", branch: "b", head_sha: sha, event: "workflow_dispatch", status: "success", created: ">=2026-11-01" });
  });

  it("uses successful job durations when a job is configured", async () => {
    const client = fakeClient((route, parameters) => {
      if (route.endsWith("/runs")) return { workflow_runs: [run(1, sha, "2026-11-02T00:00:00Z", "2026-11-02T00:10:00Z"), run(2, sha, "2026-11-02T00:00:00Z", "2026-11-02T00:10:00Z")] };
      return {
        total_count: 2, jobs: [job(Number(parameters.run_id), 101, "test", 30), job(Number(parameters.run_id), 102, "lint", 300)],
      };
    });
    expect((await ciSamples(client, repo, { ...spec, job: "test" }, { branch: "b", headSha: sha, since: "2026-11-01" })).samples.map((sample) => sample.seconds)).toEqual([30, 30]);
    expect(client.calls.filter((call) => call.route.endsWith("/jobs")).every((call) =>
      call.route.includes("/attempts/{attempt_number}/") && call.parameters.attempt_number === 1)).toBe(true);
  });

  it("returns nothing without a workflow", async () => {
    expect((await ciSamples(fakeClient(), repo, { ...spec, workflow: undefined } as never, { branch: "b", since: "2026-11-01" })).samples).toEqual([]);
  });

  it("accepts a direct-head dispatch that GitHub associates with a pull request", async () => {
    const client = fakeClient(() => ({ workflow_runs: [{
      ...run(42731542061, sha, "2026-11-02T00:00:00Z", "2026-11-02T00:01:00Z"),
      pull_requests: [{ number: 33, head: { sha }, base: { sha: "b".repeat(40) } }],
    }] }));
    const evidence = await ciSamples(client, repo, spec, { branch: "b", headSha: sha, since: "2026-11-01" });
    expect(evidence.samples.map((sample) => sample.runId)).toEqual([42731542061]);
  });

  it("does not infer an exact head from a branch or accept PR merges, retries, or foreign contexts", async () => {
    const valid = run(1, sha, "2026-11-02T00:00:00Z", "2026-11-02T00:01:40Z");
    const invalid = [
      { ...valid, id: 2, event: "pull_request" }, { ...valid, id: 3, run_attempt: 2 },
      { ...valid, id: 4, head_branch: "other" }, { ...valid, id: 5, head_sha: "b".repeat(40) },
      { ...valid, id: 6, path: ".github/workflows/other.yml" }, { ...valid, id: 7, conclusion: "failure" },
      { ...valid, id: 8, repository: { full_name: "other/widgets" } }, { ...valid, id: 9, head_repository: { full_name: "fork/widgets" } },
      { ...valid, id: 10, run_started_at: "" }, { ...valid, id: 11, status: "in_progress" },
      { ...valid, id: 12, created_at: "2026-11-01T01:00:00Z" }, { ...valid, id: 13, updated_at: "2026-11-01T00:00:00Z" },
    ];
    const client = fakeClient(() => ({ workflow_runs: [...invalid, valid, valid] }));
    expect((await ciSamples(client, repo, spec, { branch: "b", since: "2026-11-01T12:00:00Z" })).samples).toEqual([]);
    expect(client.calls).toHaveLength(0);
    expect((await ciSamples(client, repo, spec, { branch: "b", headSha: sha, since: "2026-11-01T12:00:00Z" })).samples.map((sample) => sample.runId)).toEqual([1]);
  });

  it("paginates past unsupported runs, and counts distinct supported observations toward the cap", async () => {
    const first = Array.from({ length: 100 }, (_, id) => ({ ...run(id + 1, sha, "2026-11-02T00:00:00Z", "2026-11-02T00:01:00Z"), event: "pull_request" }));
    const client = fakeClient((_route, parameters) => ({
      workflow_runs: parameters.page === 1 ? first : [first[0], run(101, sha, "2026-11-02T00:00:00Z", "2026-11-02T00:01:00Z"), run(102, sha, "2026-11-02T00:00:00Z", "2026-11-02T00:02:00Z")],
    }));
    const evidence = await ciSamples(client, repo, spec, { branch: "b", headSha: sha, since: "2026-11-01", maxRuns: 1 });
    expect(evidence.samples.map((sample) => sample.runId)).toEqual([101]);
    expect(client.calls.map((call) => call.parameters.page)).toEqual([1, 2]);
  });

  it("paginates attempt-specific jobs and rejects ambiguous or truncated job evidence", async () => {
    const workflow = run(1, sha, "2026-11-02T00:00:00Z", "2026-11-02T00:10:00Z");
    const first = Array.from({ length: 100 }, (_, index) => job(1, index + 1, `other-${index}`, 1));
    const client = fakeClient((route, parameters) => route.endsWith("/runs") ? { workflow_runs: [workflow] } :
      { total_count: 101, jobs: parameters.page === 1 ? first : [job(1, 101, "test", 30)] });
    expect((await ciSamples(client, repo, { ...spec, job: "test" }, { branch: "b", headSha: sha, since: "2026-11-01" })).samples[0]?.job).toMatchObject({ id: 101, name: "test" });
    const ambiguous = fakeClient((route) => route.endsWith("/runs") ? { workflow_runs: [workflow] } :
      { total_count: 2, jobs: [job(1, 101, "test", 30), job(1, 102, "test", 40)] });
    expect((await ciSamples(ambiguous, repo, { ...spec, job: "test" }, { branch: "b", headSha: sha, since: "2026-11-01" })).samples).toEqual([]);
    const truncated = fakeClient((route) => route.endsWith("/runs") ? { workflow_runs: [workflow] } : { total_count: 2, jobs: [job(1, 101, "test", 30)] });
    await expect(ciSamples(truncated, repo, { ...spec, job: "test" }, { branch: "b", headSha: sha, since: "2026-11-01" })).rejects.toThrow("Incomplete CI job inventory");
  });
});

describe("checksPassed", () => {
  const withRuns = (runs: Array<{ status: string; conclusion: string | null }>) => fakeClient(() => ({ check_runs: runs }));

  it("distinguishes passing, failing, running, and absent checks", async () => {
    expect(await checksPassed(withRuns([]), repo, "s")).toBeUndefined();
    expect(await checksPassed(withRuns([{ status: "completed", conclusion: "skipped" }]), repo, "s")).toBeUndefined();
    expect(await checksPassed(withRuns([{ status: "completed", conclusion: null }]), repo, "s")).toBeUndefined();
    expect(await checksPassed(withRuns([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }]), repo, "s")).toBe(true);
    expect(await checksPassed(withRuns([{ status: "completed", conclusion: "success" }, { status: "in_progress", conclusion: null }]), repo, "s")).toBeUndefined();
    expect(await checksPassed(withRuns([{ status: "in_progress", conclusion: null }, { status: "completed", conclusion: "failure" }]), repo, "s")).toBe(false);
  });

  it("does not hide a failure on the second check page", async () => {
    const client = fakeClient((_route, parameters) => ({
      check_runs: parameters.page === 1 ? Array.from({ length: 100 }, () => ({ status: "completed", conclusion: "success" })) : [{ status: "completed", conclusion: "failure" }],
    }));
    expect(await checksPassed(client, repo, "s")).toBe(false);
    expect(client.calls).toHaveLength(2);
  });
});

describe("collectMeasurements", () => {
  it("collects control and open arms, including renamed paths and errors", async () => {
    const config: HillClimbConfig = {
      ...DEFAULT_HILL_CLIMB_CONFIG,
      metrics: [{ id: "ci", source: "ci", direction: "minimize", weight: 1, workflow: "ci.yml" }],
    };
    const manifest = sampleManifest({ kind: "pipeline" });
    const pr = (arm: string, number: number) =>
      ({ number, arm, state: "open", headSha: sampleSha(arm), experiment: manifest.name }) as ExperimentPullRequest;
    const client = fakeClient((route, parameters) => {
      if (route.endsWith("/runs")) {
        if (parameters.branch === "experiments/setup-cache-yarn/packagemanager") throw new Error("boom");
        return { workflow_runs: [run(1, String(parameters.head_sha), "2026-11-02T00:00:00Z", "2026-11-02T00:01:00Z", String(parameters.branch))] };
      }
      if (route.startsWith("GET /repos/{owner}/{repo}/compare/")) return { files: [{ filename: "a.yml" }, { filename: "b.yml", previous_filename: "old.yml" }] };
      if (route.endsWith("/check-runs")) return { check_runs: [{ status: "completed", conclusion: "success" }] };
      return {};
    });
    const measurements = await collectMeasurements(client, repo, {
      manifest,
      state: { name: manifest.name, trunk: pr("trunk", 1), arms: [pr("lockfile", 2), pr("packagemanager", 3)] },
      config,
      now: new Date("2026-11-03T00:00:00Z"),
    });
    expect(measurements.collectedAt).toBe("2026-11-03T00:00:00.000Z");
    expect(measurements.control).toMatchObject({ arm: "trunk", headSha: sampleSha("trunk"), pullRequest: 1, ci: { ci: [60] }, testsPassed: true, changedPaths: [] });
    expect(measurements.control.ciEvidence?.ci?.samples[0]).toMatchObject({ headSha: sampleSha("trunk"), event: "workflow_dispatch", attempt: 1 });
    expect(measurements.arms[0]).toMatchObject({ arm: "lockfile", pullRequest: 2, ci: { ci: [60] }, testsPassed: true, changedPaths: ["a.yml", "b.yml", "old.yml"] });
    expect(measurements.arms[1]).toMatchObject({ arm: "packagemanager", error: "boom" });
    const compare = client.calls.find((call) => call.route.startsWith("GET /repos/{owner}/{repo}/compare/"));
    expect(compare?.parameters.basehead).toBe(`${sampleSha("trunk")}...${sampleSha("lockfile")}`);
    expect(client.calls.filter((call) => call.route.endsWith("/check-runs")).map((call) => call.parameters.ref)).toContain(sampleSha("trunk"));
  });

  it("does not give the control an unconditional passing check gate", async () => {
    const manifest = sampleManifest();
    const client = fakeClient(() => ({ check_runs: [{ status: "completed", conclusion: "failure" }] }));
    const result = await collectMeasurements(client, repo, {
      manifest, config: DEFAULT_HILL_CLIMB_CONFIG,
      state: { name: manifest.name, arms: [], trunk: { number: 1, arm: "trunk", state: "open", headSha: sha } as ExperimentPullRequest },
    });
    expect(result.control.testsPassed).toBe(false);
  });

  it("does not present potentially truncated path evidence as complete", async () => {
    await expect(changedPaths(fakeClient(() => ({ files: Array.from({ length: 300 }, (_, id) => ({ filename: `${id}.ts` })) })), repo, "base", "head")).rejects.toThrow("potentially truncated");
  });
});

describe("verifyCiMeasurements", () => {
  const config: HillClimbConfig = { ...DEFAULT_HILL_CLIMB_CONFIG, metrics: [{ id: "ci", source: "ci", direction: "minimize", weight: 1, workflow: "ci.yml" }] };
  const measurements = (): ExperimentMeasurements => ({
    experiment: "setup-cache-yarn", collectedAt: "2026-11-03T00:00:00Z",
    control: ciMeasurement("trunk", [100]), arms: [ciMeasurement("lockfile", [60])],
  });
  const metadataClient = (input: ExperimentMeasurements, mutate: (value: ReturnType<typeof run>) => ReturnType<typeof run> = (value) => value) => fakeClient((_route, parameters) => {
    const sample = [input.control, ...input.arms].flatMap((branch) => branch.ciEvidence?.ci?.samples ?? []).find((sample) => sample.runId === parameters.run_id);
    if (!sample) throw new Error("Unknown run.");
    return mutate(run(sample.runId, sample.headSha, sample.startedAt, sample.updatedAt, sample.branch));
  });

  it("re-reads each actually consumed observation before publication", async () => {
    const input = measurements();
    const client = metadataClient(input);
    await verifyCiMeasurements(client, repo, { manifest: sampleManifest({ kind: "pipeline" }), measurements: input, config });
    expect(client.calls).toHaveLength(2);
    expect(client.calls.every((call) => call.route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}")).toBe(true);
  });

  it.each(["pull_request", "workflow_dispatch"])("rejects forged or subsequently retried metadata (%s)", async (event) => {
    const input = measurements();
    const client = metadataClient(input, (row) => ({ ...row, event, run_attempt: event === "workflow_dispatch" ? 2 : 1 }));
    await expect(verifyCiMeasurements(client, repo, { manifest: sampleManifest({ kind: "pipeline" }), measurements: input, config })).rejects.toThrow("no longer matches");
  });

  it("rejects a forged duration even when its serialized timestamps were edited consistently", async () => {
    const input = measurements();
    const client = metadataClient(input, (row) => ({ ...row, updated_at: new Date(Date.parse(row.updated_at) + 60_000).toISOString() }));
    await expect(verifyCiMeasurements(client, repo, { manifest: sampleManifest({ kind: "pipeline" }), measurements: input, config })).rejects.toThrow("timing context");
  });
});

describe("mergeMeasurement", () => {
  const base: ExperimentMeasurements = {
    experiment: "x",
    collectedAt: "2026-11-03T00:00:00Z",
    control: { arm: "trunk", changedPaths: [], testsPassed: true },
    arms: [{ arm: "a", changedPaths: ["x.yml"], testsPassed: false }],
  };

  it("merges local evidence without letting a pass hide a failure", () => {
    const corpus = { precision: 1, recall: 1, f1: 1, fixRate: 1, durationMs: 1 };
    const merged = mergeMeasurement(base, { arm: "a", testsPassed: true, corpus });
    expect(merged.arms[0]).toMatchObject({ testsPassed: false, corpus, changedPaths: ["x.yml"] });
    expect(mergeMeasurement(base, { arm: "trunk", testsPassed: false }).control.testsPassed).toBe(false);
    expect(mergeMeasurement(base, { arm: "b", testsPassed: true }).arms[1]).toEqual({ arm: "b", changedPaths: [], testsPassed: true });
  });
});
