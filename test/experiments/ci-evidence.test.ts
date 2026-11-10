import { describe, expect, it } from "vitest";
import { validatedCiSeries, type CiEvidence, type CiSample } from "../../src/experiments/ci-evidence.js";
import { DEFAULT_HILL_CLIMB_CONFIG } from "../../src/experiments/config.js";
import { decide } from "../../src/experiments/decide.js";
import { armBranch, trunkBranch } from "../../src/experiments/manifest.js";
import { parseMeasurements } from "../../src/experiments/measurements.js";
import { scoreArm, type BranchMeasurement, type ExperimentMeasurements } from "../../src/experiments/score.js";
import { ciMeasurement, sampleManifest } from "./fixtures.js";

const spec = { id: "ci", source: "ci" as const, direction: "minimize" as const, weight: 1, workflow: "ci.yml" };
const config = { ...DEFAULT_HILL_CLIMB_CONFIG, metrics: [spec] };
const manifest = sampleManifest({ kind: "pipeline" });
const refs = { trunkRef: trunkBranch(manifest.name), armRef: (arm: string) => armBranch(manifest.name, arm) };
const slow = [300, 310, 305, 320, 298, 315];
const fast = [200, 210, 190, 205, 199, 220];
const evidence = (branch: BranchMeasurement): CiEvidence => {
  const result = branch.ciEvidence?.ci;
  if (!result) throw new Error("Missing test fixture evidence.");
  return result;
};
const data = (): ExperimentMeasurements => ({
  experiment: manifest.name, collectedAt: "2026-11-03T00:00:00Z",
  control: ciMeasurement("trunk", slow), arms: [ciMeasurement("lockfile", fast), ciMeasurement("packagemanager", slow)],
});

describe("CI provenance eligibility", () => {
  it("uses supported observations in the actual verified reducer", () => {
    const measurements = data();
    expect(decide(manifest, measurements, config, { ...refs, now: new Date("2026-11-05") })).toMatchObject({ action: "promote", winner: "lockfile" });
    expect(parseMeasurements(JSON.stringify(measurements))).toEqual(measurements);
  });

  it("does not promote from legacy PR/draft timings, even if the numeric speedup is significant", () => {
    const measurements = data();
    for (const branch of [measurements.control, ...measurements.arms]) delete branch.ciEvidence;
    const result = decide(manifest, measurements, config, { ...refs, now: new Date("2026-11-05") });
    expect(result.action).toBe("wait");
    if (result.action !== "wait") throw new Error("Expected wait.");
    expect(result.dispatch.map((request) => request.runs)).toEqual([5, 5, 5]);
    expect(result.scores[0]?.pending.join(" ")).toContain("recollect legacy evidence");
    expect(decide(manifest, measurements, config, { ...refs, now: new Date("2026-11-20") }).action).toBe("expire");
  });

  const unsupported: Array<[string, Partial<CiSample>]> = [
    ["PR merge context", { event: "pull_request" }],
    ["retry", { attempt: 2 }],
    ["failed run", { conclusion: "failure" }],
    ["unfinished run", { status: "in_progress" }],
    ["stale head", { headSha: "0".repeat(40) }],
    ["wrong branch", { branch: "experiments/setup-cache-yarn/trunk" }],
    ["wrong workflow", { workflowPath: ".github/workflows/other.yml" }],
    ["before experiment", { createdAt: "2026-10-01T00:00:00Z" }],
    ["unordered timestamps", { createdAt: "2026-11-09T00:00:00Z" }],
    ["missing start", { startedAt: "" }],
    ["invalid time", { updatedAt: "invalid" }],
    ["duration forgery", { seconds: 1 }],
    ["invalid run id", { runId: 0 }],
    ["invalid workflow id", { workflowId: 0 }],
  ];
  it.each(unsupported)("rejects an otherwise attractive series with %s", (_description, change) => {
    const arm = ciMeasurement("lockfile", fast);
    Object.assign(evidence(arm).samples[0] ?? {}, change);
    const score = scoreArm(manifest, ciMeasurement("trunk", slow), arm, config);
    expect(score.qualifies).toBe(false);
    expect(score.metrics[0]?.needs).toEqual({ control: 0, arm: 5 });
    expect(score.pending.join(" ")).toMatch(/unsupported|context/);
  });

  it("rejects duplicated samples rather than treating one run as independent replications", () => {
    const arm = ciMeasurement("lockfile", fast);
    const samples = evidence(arm).samples;
    if (!samples[0] || !samples[1]) throw new Error("Missing samples.");
    samples[1].runId = samples[0].runId;
    expect(scoreArm(manifest, ciMeasurement("trunk", slow), arm, config).pending.join(" ")).toContain("repeats a CI run");
  });

  it("binds display arrays to recomputed durations", () => {
    const arm = ciMeasurement("lockfile", fast);
    arm.ci = { ci: fast.map((value) => value / 2) };
    expect(scoreArm(manifest, ciMeasurement("trunk", slow), arm, config).pending.join(" ")).toContain("do not match");
  });

  it.each(["repository", "workflowId", "runId"])("rejects mismatched/reused cross-branch %s", (field) => {
    const control = ciMeasurement("trunk", slow);
    const arm = ciMeasurement("lockfile", fast);
    if (field === "repository") evidence(arm).repository = "other/repository";
    if (field === "workflowId") for (const sample of evidence(arm).samples) sample.workflowId = 100;
    if (field === "runId") {
      const sample = evidence(arm).samples[0];
      const controlSample = evidence(control).samples[0];
      if (!sample || !controlSample) throw new Error("Missing samples.");
      sample.runId = controlSample.runId;
    }
    const score = scoreArm(manifest, control, arm, config);
    expect(score.qualifies).toBe(false);
    expect(score.metrics[0]?.needs).toEqual({ control: 5, arm: 5 });
    expect(score.pending.join(" ")).toMatch(/mixes repositories|reuses/);
  });

  it("rejects multiple workflow identities within one branch", () => {
    const arm = ciMeasurement("lockfile", fast);
    const sample = evidence(arm).samples[0];
    if (!sample) throw new Error("Missing sample.");
    sample.workflowId = 100;
    expect(scoreArm(manifest, ciMeasurement("trunk", slow), arm, config).pending.join(" ")).toContain("mixes workflow identities");
  });

  it("matches an explicitly configured numeric workflow id", () => {
    const arm = ciMeasurement("lockfile", fast);
    evidence(arm).workflow = "99";
    const context = { branch: "experiments/setup-cache-yarn/lockfile", since: manifest.createdAt };
    expect(validatedCiSeries({ ...spec, workflow: "99" }, arm, context).values).toEqual(fast);
    evidence(arm).workflow = "100";
    expect(validatedCiSeries({ ...spec, workflow: "100" }, arm, context).values).toEqual([]);
  });

  it("cannot silently downgrade to a caller-supplied eligibility or attestation flag", () => {
    const measurements = data();
    const serialized = JSON.stringify(measurements);
    expect(() => parseMeasurements(serialized.replace('"schema":"cicd-optimizer/ci-evidence-v1"', '"schema":"cicd-optimizer/ci-evidence-v1","authenticated":true'))).toThrow(/Unknown|unexpected|allowed/i);
    expect(() => parseMeasurements(serialized.replace('"runId":', '"runId":0,"runId":'))).toThrow(/duplicate/i);
    expect(() => parseMeasurements(serialized.replace('"attempt":1', '"attempt":1.5'))).toThrow(/integer/i);
    expect(() => parseMeasurements(serialized.replace('"seconds":300', '"seconds":-1'))).toThrow(/duration/i);
  });
});
