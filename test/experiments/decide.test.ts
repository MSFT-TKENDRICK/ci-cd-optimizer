import { describe, expect, it } from "vitest";
import { DEFAULT_HILL_CLIMB_CONFIG, type HillClimbConfig } from "../../src/experiments/config.js";
import { decide, isExpired, renderDecision } from "../../src/experiments/decide.js";
import { armBranch, trunkBranch } from "../../src/experiments/manifest.js";
import { scoreArm, type BranchMeasurement, type ExperimentMeasurements } from "../../src/experiments/score.js";
import { sampleManifest } from "./fixtures.js";

const config = DEFAULT_HILL_CLIMB_CONFIG;
const corpus = (precision: number, recall: number, fixRate = 1, durationMs = 100) => ({ precision, recall, f1: 0, fixRate, durationMs });
const branch = (arm: string, overrides: Partial<BranchMeasurement> = {}): BranchMeasurement => ({ arm, changedPaths: [], testsPassed: true, ...overrides });
const control = branch("trunk", { corpus: corpus(0.9, 0.6) });
const refs = { trunkRef: trunkBranch("setup-cache-yarn"), armRef: (arm: string) => armBranch("setup-cache-yarn", arm) };
const measurements = (arms: BranchMeasurement[], base = control): ExperimentMeasurements => ({ experiment: "setup-cache-yarn", collectedAt: "", control: base, arms });
const now = new Date("2026-11-05T00:00:00Z");

describe("scoreArm (corpus)", () => {
  it("computes direction-aware relative deltas and a weighted score", () => {
    const score = scoreArm(sampleManifest(), control, branch("lockfile", { corpus: corpus(0.9, 0.75, 1, 50) }), config);
    expect(score.metrics.map((metric) => [metric.id, metric.delta])).toEqual([
      ["precision", 0],
      ["recall", 0.25],
      ["fixRate", 0],
      ["durationMs", 0.5],
    ]);
    expect(score.deterministic).toBe(0.1625);
    expect(score.qualifies).toBe(true);
  });

  it("gates on regressions, failing tests, protected paths, and evaluation errors", () => {
    const manifest = sampleManifest();
    expect(scoreArm(manifest, control, branch("a", { corpus: corpus(0.8, 0.9) }), config).failures).toEqual(["precision regressed 11% (limit 2%)"]);
    expect(scoreArm(manifest, control, branch("a", { corpus: corpus(0.9, 0.9), testsPassed: false }), config).failures).toEqual(["checks failed"]);
    expect(scoreArm(manifest, control, branch("a", { corpus: corpus(0.9, 0.9), changedPaths: ["corpus/x/case.yml", "src/a.ts"] }), config).failures).toEqual([
      "modified protected paths: corpus/x/case.yml",
    ]);
    const crashed = scoreArm(manifest, control, branch("a", { error: "build failed" }), config);
    expect(crashed.failures).toEqual(["evaluation failed: build failed"]);
    expect(crashed.qualifies).toBe(false);
  });

  it("is pending until checks finish and metrics exist", () => {
    const score = scoreArm(sampleManifest(), control, branch("a", { testsPassed: undefined }), config);
    expect(score.pending).toContain("checks are still running");
    expect(score.pending).toContain("precision has not been measured");
  });

  it("lets the judge reorder qualifying arms only within its weight", () => {
    const strong = scoreArm(sampleManifest(), control, branch("a", { corpus: corpus(0.9, 0.66), judge: { score: 1, rationale: "" } }), config);
    expect(strong.rank).toBeCloseTo(0.8 * strong.deterministic + 0.2, 4);
    const weak = scoreArm(sampleManifest(), control, branch("a", { corpus: corpus(0.9, 0.6), judge: { score: 1, rationale: "" } }), config);
    expect(weak.qualifies).toBe(false);
  });
});

describe("scoreArm (CI)", () => {
  const ciConfig: HillClimbConfig = {
    ...config,
    metrics: [{ id: "ci", source: "ci", direction: "minimize", weight: 1, workflow: "ci.yml", maxRegression: 0.1 }],
  };
  const manifest = sampleManifest({ kind: "pipeline" });
  const slow = [300, 310, 305, 320, 298, 315];
  const fast = [200, 210, 190, 205, 199, 220];

  it("needs minSamples on both sides", () => {
    const score = scoreArm(manifest, branch("trunk", { ci: { ci: slow } }), branch("a", { ci: { ci: fast.slice(0, 2) } }), ciConfig);
    expect(score.metrics[0]?.needs).toEqual({ control: 0, arm: 3 });
    expect(score.pending).toEqual(["ci needs more CI samples"]);
  });

  it("counts significant speedups and ignores noise", () => {
    const significant = scoreArm(manifest, branch("trunk", { ci: { ci: slow } }), branch("a", { ci: { ci: fast } }), ciConfig);
    expect(significant.metrics[0]?.pValue).toBeLessThan(0.05);
    expect(significant.deterministic).toBeGreaterThan(0.3);
    expect(significant.qualifies).toBe(true);
    const noisy = scoreArm(manifest, branch("trunk", { ci: { ci: [300, 100, 250, 120, 280] } }), branch("a", { ci: { ci: [290, 110, 240, 130, 260] } }), ciConfig);
    expect(noisy.metrics[0]?.delta).toBe(0);
    expect(noisy.qualifies).toBe(false);
  });

  it("fails significant slowdowns beyond the regression budget", () => {
    const score = scoreArm(manifest, branch("trunk", { ci: { ci: fast } }), branch("a", { ci: { ci: slow } }), ciConfig);
    expect(score.failures[0]).toMatch(/^ci regressed/);
  });
});

describe("decide", () => {
  it("promotes the best qualifying arm once every arm is measured", () => {
    const decision = decide(
      sampleManifest(),
      measurements([branch("lockfile", { corpus: corpus(0.9, 0.7) }), branch("packagemanager", { corpus: corpus(0.9, 0.8) })]),
      config,
      { ...refs, now },
    );
    expect(decision).toMatchObject({ action: "promote", winner: "packagemanager", losers: ["lockfile"] });
  });

  it("waits for unfinished arms that could still win", () => {
    const decision = decide(sampleManifest(), measurements([branch("lockfile", { corpus: corpus(0.9, 0.7) })]), config, { ...refs, now });
    expect(decision.action).toBe("wait");
  });

  it("promotes the leader at expiry even if another arm never finished", () => {
    const expiredAt = new Date("2026-11-20T00:00:00Z");
    expect(isExpired(sampleManifest(), config, expiredAt)).toBe(true);
    const decision = decide(sampleManifest(), measurements([branch("lockfile", { corpus: corpus(0.9, 0.7) })]), config, { ...refs, now: expiredAt });
    expect(decision).toMatchObject({ action: "promote", winner: "lockfile" });
    const none = decide(sampleManifest(), measurements([]), config, { ...refs, now: expiredAt });
    expect(none.action).toBe("expire");
  });

  it("rejects when every arm is measured and none qualifies", () => {
    const decision = decide(
      sampleManifest(),
      measurements([branch("lockfile", { corpus: corpus(0.9, 0.6) }), branch("packagemanager", { corpus: corpus(0.5, 0.9) })]),
      config,
      { ...refs, now },
    );
    expect(decision.action).toBe("reject");
    expect(decision.reason).toMatch(/precision regressed/);
  });

  it("skips experiments that are no longer running", () => {
    expect(decide(sampleManifest({ status: "promoted" }), measurements([]), config, { ...refs, now }).action).toBe("skip");
  });

  it("requests the missing CI runs for arms and the control", () => {
    const ciConfig: HillClimbConfig = { ...config, metrics: [{ id: "ci", source: "ci", direction: "minimize", weight: 1, workflow: "ci.yml" }] };
    const manifest = sampleManifest({ kind: "pipeline" });
    const decision = decide(
      manifest,
      measurements([branch("lockfile", { ci: { ci: [1, 2] } }), branch("packagemanager", { ci: { ci: [] } })], branch("trunk", { ci: { ci: [1, 2, 3] } })),
      ciConfig,
      { ...refs, now },
    );
    expect(decision.action).toBe("wait");
    expect(decision.action === "wait" && decision.dispatch).toEqual([
      { ref: "experiments/setup-cache-yarn/lockfile", arm: "lockfile", workflow: "ci.yml", runs: 3 },
      { ref: "experiments/setup-cache-yarn/packagemanager", arm: "packagemanager", workflow: "ci.yml", runs: 5 },
      { ref: "experiments/setup-cache-yarn/trunk", arm: "trunk", workflow: "ci.yml", runs: 2 },
    ]);
  });

  it("renders a results table", () => {
    const manifest = sampleManifest();
    const decision = decide(manifest, measurements([branch("lockfile", { corpus: corpus(0.9, 0.7) }), branch("packagemanager", { testsPassed: false, corpus: corpus(0.9, 0.9) })]), config, { ...refs, now });
    const text = renderDecision(manifest, decision);
    expect(text).toContain("🏆 Promoting `lockfile`");
    expect(text).toContain("| `lockfile` |");
    expect(text).toContain("0.6 → 0.7 +16.7%");
    expect(text).toContain("❌ checks failed");
  });
});
