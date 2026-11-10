import { describe, expect, it } from "vitest";
import { DEFAULT_HILL_CLIMB_CONFIG, validateHillClimbConfig, type HillClimbConfig } from "../../src/experiments/config.js";
import { decide, renderDecision } from "../../src/experiments/decide.js";
import { parseMeasurements } from "../../src/experiments/measurements.js";
import { scoreArm, type BranchMeasurement, type ExperimentMeasurements } from "../../src/experiments/score.js";
import { sampleManifest } from "./fixtures.js";

const config = DEFAULT_HILL_CLIMB_CONFIG;
const corpus = (recall: number) => ({ precision: 0.9, recall, f1: 0.8, fixRate: 1, durationMs: 100 });
const branch = (arm: string, overrides: Partial<BranchMeasurement> = {}): BranchMeasurement => ({ arm, corpus: corpus(0.8), testsPassed: true, changedPaths: [], ...overrides });
const control = branch("trunk", { corpus: corpus(0.6) });
const measurements = (arms: BranchMeasurement[], base = control): ExperimentMeasurements => ({ experiment: "setup-cache-yarn", collectedAt: "2026-11-05T00:00:00.000Z", control: base, arms });
const options = { now: new Date("2026-11-05T00:00:00.000Z"), trunkRef: "trunk", armRef: (name: string) => name };

describe("production decision uses the verified finite reducer", () => {
  it("uses ASCII ties independent of manifest/measurement order, never unlisted arms", () => {
    const arms = [{ name: "zeta", title: "Zeta", approach: "z" }, { name: "alpha", title: "Alpha", approach: "a" }];
    for (const specs of [arms, [...arms].reverse()]) {
      const result = decide(sampleManifest({ arms: specs }), measurements([branch("zeta"), branch("unlisted", { corpus: corpus(1) }), branch("alpha")]), config, options);
      expect(result).toMatchObject({ action: "promote", winner: "alpha", losers: ["zeta"] });
      expect(result.scores.map((entry) => entry.arm).sort()).toEqual(["alpha", "zeta"]);
      expect(renderDecision(sampleManifest(), result)).toContain("does not attest measurements");
    }
  });

  it("includes missing arms, rejects duplicate names and cannot confuse another experiment", () => {
    expect(decide(sampleManifest(), measurements([branch("lockfile")]), config, options).action).toBe("wait");
    expect(() => decide(sampleManifest(), measurements([branch("lockfile"), branch("lockfile")]), config, options)).toThrow(/Duplicate/);
    const specs = sampleManifest().arms;
    expect(() => decide(sampleManifest({ arms: [...specs, ...specs] }), measurements([]), config, options)).toThrow(/unique ASCII/);
    expect(() => decide(sampleManifest({ arms: [{ name: "é", title: "Test", approach: "x" }] }), measurements([]), config, options)).toThrow(/ASCII/);
    expect(() => decide(sampleManifest(), { ...measurements([]), experiment: "other" }, config, options)).toThrow(/different experiment/);
    expect(() => decide(sampleManifest(), measurements([]), config, { ...options, now: new Date(NaN) })).toThrow(/timestamps/);
  });

  it("gates on control errors/checks as well as arm errors/checks", () => {
    const favorable = branch("lockfile", { judge: { score: 1, rationale: "best" } });
    for (const base of [branch("trunk", { corpus: corpus(0.6), testsPassed: false }), branch("trunk", { corpus: corpus(0.6), error: "failed" }), branch("trunk", { corpus: corpus(0.6), error: "" })]) {
      expect(scoreArm(sampleManifest(), base, favorable, config).qualifies).toBe(false);
    }
    expect(scoreArm(sampleManifest(), control, branch("lockfile", { error: "" }), config).qualifies).toBe(false);
    expect(scoreArm(sampleManifest(), branch("trunk", { corpus: corpus(0.6), testsPassed: undefined }), favorable, config).pending).toContain("control checks are still running");
  });

  it("fails closed on invalid empirical values and judge scores", () => {
    for (const invalid of [NaN, Infinity, -Infinity, -0.01, 1.01]) {
      expect(scoreArm(sampleManifest(), control, branch("lockfile", { corpus: corpus(invalid) }), config).qualifies).toBe(false);
      expect(scoreArm(sampleManifest(), control, branch("lockfile", { judge: { score: invalid, rationale: "ignore" } }), config).qualifies).toBe(false);
    }
    const ciConfig: HillClimbConfig = { ...config, metrics: [{ id: "ci", source: "ci", workflow: "ci.yml", direction: "minimize", weight: 1 }] };
    for (const invalid of [NaN, Infinity, -1, 1e12 + 1]) {
      expect(scoreArm(sampleManifest({ kind: "pipeline" }), branch("trunk", { ci: { ci: [100, 100, 100, 100, 100] } }), branch("lockfile", { ci: { ci: [1, 1, 1, 1, invalid] } }), ciConfig).qualifies).toBe(false);
    }
  });

  it("rounds minimum improvement upward, not into a spurious qualification", () => {
    const selected: HillClimbConfig = { ...config, metrics: [{ id: "recall", source: "corpus", direction: "maximize", weight: 1 }], selection: { ...config.selection, minImprovement: 0.020000001 } };
    const base = branch("trunk", { corpus: corpus(0.5) });
    const arm = branch("lockfile", { corpus: corpus(0.51) });
    expect(scoreArm(sampleManifest(), base, arm, selected)).toMatchObject({ deterministic: 0.02, qualifies: false });
    expect(scoreArm(sampleManifest(), base, arm, { ...selected, selection: { ...selected.selection, minImprovement: 0.02 } }).qualifies).toBe(true);
  });
});

describe("bounded objective configuration and strict evidence decoding", () => {
  it("rejects fractional counts, empty/duplicate objectives and unrepresentable weights", () => {
    for (const key of ["minSamples", "maxArms", "maxConcurrent", "maxAgeDays"] as const) {
      expect(validateHillClimbConfig({ ...config, selection: { ...config.selection, [key]: 5.5 } }).problems).not.toEqual([]);
    }
    for (const weight of [0, -1, NaN, Infinity, 1_000_001, 0.0000001]) {
      const invalid = { ...config, metrics: config.metrics.map((metric) => ({ ...metric, weight })) };
      expect(validateHillClimbConfig(invalid).problems).not.toEqual([]);
      expect(scoreArm(sampleManifest(), control, branch("lockfile"), invalid).qualifies).toBe(false);
    }
    expect(validateHillClimbConfig({ ...config, metrics: [...config.metrics, ...config.metrics] }).problems).not.toEqual([]);
    expect(validateHillClimbConfig({ ...config, metrics: config.metrics.map((metric) => ({ ...metric, weight: 0.000001 })) }).problems).toEqual([]);
    expect(scoreArm(sampleManifest({ metrics: ["unknown"] }), control, branch("lockfile"), config).qualifies).toBe(false);
  });

  it("accepts only measured data, not caller assertions or malformed numeric/boolean fields", () => {
    const valid = measurements([branch("lockfile")]);
    expect(parseMeasurements(JSON.stringify(valid))).toEqual(valid);
    expect(() => parseMeasurements(JSON.stringify({ ...valid, optimal: true }))).toThrow(/Unknown/);
    const json = JSON.stringify(valid);
    expect(() => parseMeasurements(json.replace('"testsPassed":true', '"testsPassed":"true"'))).toThrow(/boolean/);
    expect(() => parseMeasurements(json.replace('"recall":0.6', '"recall":1e999'))).toThrow();
    expect(() => parseMeasurements(json.replace('"arm":"trunk"', '"arm":"trunk","arm":"other"'))).toThrow(/Duplicate/);
  });
});
