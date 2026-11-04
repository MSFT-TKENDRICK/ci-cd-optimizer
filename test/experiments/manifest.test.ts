import { describe, expect, it } from "vitest";
import { DEFAULT_HILL_CLIMB_CONFIG, parseHillClimbConfig } from "../../src/experiments/config.js";
import {
  armBranch,
  manifestPath,
  parseExperimentRef,
  parseManifest,
  renderRubric,
  scoreRubric,
  serializeManifest,
  trunkBranch,
} from "../../src/experiments/manifest.js";
import { sampleManifest } from "./fixtures.js";

describe("hill-climb config", () => {
  it("uses defaults when the file is absent or empty", () => {
    expect(parseHillClimbConfig(undefined)).toEqual({ config: DEFAULT_HILL_CLIMB_CONFIG, problems: [] });
    expect(parseHillClimbConfig("").config).toEqual(DEFAULT_HILL_CLIMB_CONFIG);
  });

  it("validates metrics, selection, and unknown keys", () => {
    const { config, problems } = parseHillClimbConfig(
      [
        "metrics:",
        "  - { id: ci-duration, source: ci, direction: minimize, weight: 1, workflow: ci.yml, job: test }",
        "  - { id: bogus, source: corpus, direction: maximize, weight: 1 }",
        "  - { id: no-workflow, source: ci, direction: minimize, weight: 1 }",
        "selection: { judgeWeight: 0.9, minSamples: 8 }",
        "promotion: { autoMerge: true, reviewers: [octocat, acme/platform] }",
        "surprise: true",
      ].join("\n"),
    );
    expect(config.metrics[0]).toEqual({ id: "ci-duration", source: "ci", direction: "minimize", weight: 1, workflow: "ci.yml", job: "test" });
    expect(config.selection.minSamples).toBe(8);
    expect(config.promotion).toEqual({ autoMerge: true, reviewers: ["octocat", "acme/platform"], labels: [] });
    expect(problems.map((problem) => problem.path).sort()).toEqual(["metrics[1].id", "metrics[2].workflow", "selection.judgeWeight", "surprise"]);
  });

  it("reports invalid YAML without throwing", () => {
    const { config, problems } = parseHillClimbConfig("rubric: [");
    expect(config).toEqual(DEFAULT_HILL_CLIMB_CONFIG);
    expect(problems).toHaveLength(1);
  });
});

describe("experiment branches", () => {
  it("uses a trunk branch so arms can live under the experiment prefix", () => {
    expect(trunkBranch("faster-ci")).toBe("experiments/faster-ci/trunk");
    expect(armBranch("faster-ci", "arm-a")).toBe("experiments/faster-ci/arm-a");
    expect(manifestPath("faster-ci")).toBe("experiments/faster-ci/experiment.yml");
  });

  it("parses experiment refs and rejects anything else", () => {
    expect(parseExperimentRef("refs/heads/experiments/faster-ci/arm-a")).toEqual({ experiment: "faster-ci", arm: "arm-a" });
    expect(parseExperimentRef("experiments/faster-ci/trunk")).toEqual({ experiment: "faster-ci", arm: "trunk" });
    for (const ref of ["experiments/faster-ci", "experiments/a/b/c", "feature/x", "experiments/Faster/arm"]) {
      expect(parseExperimentRef(ref)).toBeUndefined();
    }
  });
});

describe("manifest", () => {
  it("round-trips through YAML", () => {
    const manifest = sampleManifest({ metrics: ["precision", "recall"], applicability: { rules: ["caching/setup-cache"] } });
    expect(parseManifest(serializeManifest(manifest), { config: DEFAULT_HILL_CLIMB_CONFIG })).toEqual({ manifest, problems: [] });
  });

  it("rejects invalid names, duplicate or trunk arms, unknown metrics, and too many arms", () => {
    const manifest = sampleManifest({
      name: "Bad Name",
      metrics: ["latency"],
      arms: [
        { name: "trunk", title: "t", approach: "x" },
        { name: "a1", title: "a", approach: "x" },
        { name: "a1", title: "b", approach: "" },
        { name: "a2", title: "c", approach: "x" },
        { name: "a3", title: "d", approach: "x" },
      ],
    });
    const { manifest: parsed, problems } = parseManifest(serializeManifest(manifest), { config: DEFAULT_HILL_CLIMB_CONFIG });
    expect(parsed).toBeUndefined();
    expect(problems.map((problem) => problem.path)).toEqual(["name", "arms[0].name", "arms[2].name", "arms[2].approach", "arms", "metrics"]);
  });

  it("requires a hypothesis and at least one arm", () => {
    const { problems } = parseManifest("name: ok-name\ntitle: T\nkind: rules\ncreatedAt: 2026-01-01\nexpiresAt: 2026-01-02\n");
    expect(problems.map((problem) => problem.path)).toEqual(["hypothesis", "arms"]);
  });
});

describe("rubric", () => {
  const rubric = DEFAULT_HILL_CLIMB_CONFIG.rubric;

  it("computes a weighted mean and applies the bar", () => {
    expect(scoreRubric({ impact: 4, evidence: 4, safety: 5, generality: 4, measurability: 4 }, rubric)).toEqual({ score: 4.2, passed: true, missing: [] });
    expect(scoreRubric({ impact: 3, evidence: 3, safety: 3, generality: 3, measurability: 3 }, rubric).passed).toBe(false);
  });

  it("treats missing criteria as failing and clamps out-of-range scores", () => {
    const result = scoreRubric({ impact: 9, evidence: 5, safety: 5, generality: 5 }, rubric);
    expect(result.missing).toEqual(["measurability"]);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(4.4);
  });

  it("renders a table for the generator prompt", () => {
    expect(renderRubric(rubric)).toContain("| `impact` | 0.3 |");
  });
});
