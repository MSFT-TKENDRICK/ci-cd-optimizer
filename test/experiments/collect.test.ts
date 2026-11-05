import { describe, expect, it } from "vitest";
import { DEFAULT_HILL_CLIMB_CONFIG, type HillClimbConfig } from "../../src/experiments/config.js";
import { checksPassed, ciSamples, collectMeasurements, mergeMeasurement } from "../../src/experiments/collect.js";
import type { ExperimentPullRequest } from "../../src/experiments/github.js";
import type { ExperimentMeasurements } from "../../src/experiments/score.js";
import { fakeClient, repo, sampleManifest } from "./fixtures.js";

const run = (id: number, sha: string, startedAt: string, updatedAt: string) => ({
  id,
  head_sha: sha,
  run_started_at: startedAt,
  created_at: startedAt,
  updated_at: updatedAt,
  conclusion: "success",
});

describe("ciSamples", () => {
  const spec = { id: "ci", source: "ci" as const, direction: "minimize" as const, weight: 1, workflow: "ci.yml" };

  it("measures only runs of the exact head SHA", async () => {
    const client = fakeClient(() => ({
      workflow_runs: [
        run(1, "abc", "2026-11-02T00:00:00Z", "2026-11-02T00:01:40Z"),
        run(2, "old", "2026-11-02T00:00:00Z", "2026-11-02T00:10:00Z"),
        run(3, "abc", "2026-11-02T00:00:00Z", "2026-11-02T00:02:00Z"),
      ],
    }));
    expect(await ciSamples(client, repo, spec, { branch: "b", headSha: "abc", since: "2026-11-01T12:00:00Z" })).toEqual([100, 120]);
    expect(client.calls[0]?.parameters).toMatchObject({ workflow_id: "ci.yml", branch: "b", status: "success", created: ">=2026-11-01" });
  });

  it("uses successful job durations when a job is configured", async () => {
    const client = fakeClient((route) => {
      if (route.endsWith("/runs")) return { workflow_runs: [run(1, "abc", "2026-11-02T00:00:00Z", "2026-11-02T00:10:00Z"), run(2, "abc", "2026-11-02T00:00:00Z", "2026-11-02T00:10:00Z")] };
      return {
        jobs: [
          { name: "test", started_at: "2026-11-02T00:00:00Z", completed_at: "2026-11-02T00:00:30Z", conclusion: "success" },
          { name: "lint", started_at: "2026-11-02T00:00:00Z", completed_at: "2026-11-02T00:05:00Z", conclusion: "success" },
        ],
      };
    });
    expect(await ciSamples(client, repo, { ...spec, job: "test" }, { branch: "b", since: "2026-11-01" })).toEqual([30, 30]);
  });

  it("returns nothing without a workflow", async () => {
    expect(await ciSamples(fakeClient(), repo, { ...spec, workflow: undefined } as never, { branch: "b", since: "2026-11-01" })).toEqual([]);
  });
});

describe("checksPassed", () => {
  const withRuns = (runs: Array<{ status: string; conclusion: string | null }>) => fakeClient(() => ({ check_runs: runs }));

  it("distinguishes passing, failing, running, and absent checks", async () => {
    expect(await checksPassed(withRuns([]), repo, "s")).toBeUndefined();
    expect(await checksPassed(withRuns([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }]), repo, "s")).toBe(true);
    expect(await checksPassed(withRuns([{ status: "completed", conclusion: "success" }, { status: "in_progress", conclusion: null }]), repo, "s")).toBeUndefined();
    expect(await checksPassed(withRuns([{ status: "in_progress", conclusion: null }, { status: "completed", conclusion: "failure" }]), repo, "s")).toBe(false);
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
      ({ number, arm, state: "open", headSha: `sha-${arm}`, experiment: manifest.name }) as ExperimentPullRequest;
    const client = fakeClient((route, parameters) => {
      if (route.endsWith("/runs")) {
        if (parameters.branch === "experiments/setup-cache-yarn/packagemanager") throw new Error("boom");
        return { workflow_runs: [run(1, String(parameters.branch).endsWith("trunk") ? "sha-trunk" : "sha-lockfile", "2026-11-02T00:00:00Z", "2026-11-02T00:01:00Z")] };
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
    expect(measurements.control).toMatchObject({ arm: "trunk", headSha: "sha-trunk", pullRequest: 1, ci: { ci: [60] }, testsPassed: true, changedPaths: [] });
    expect(measurements.arms[0]).toMatchObject({ arm: "lockfile", pullRequest: 2, ci: { ci: [60] }, testsPassed: true, changedPaths: ["a.yml", "b.yml", "old.yml"] });
    expect(measurements.arms[1]).toMatchObject({ arm: "packagemanager", error: "boom" });
    const compare = client.calls.find((call) => call.route.startsWith("GET /repos/{owner}/{repo}/compare/"));
    expect(compare?.parameters.basehead).toBe("sha-trunk...sha-lockfile");
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
