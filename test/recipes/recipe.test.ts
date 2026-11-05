import { describe, expect, it } from "vitest";
import { buildRecipe, classifyRisk, parseRecipe, recipePath, renderPatch, riskAtMost, serializeRecipe, sourceUrl, type PullRequestFile } from "../../src/recipes/recipe.js";
import { sampleManifest } from "../experiments/fixtures.js";
import { sampleRecipe } from "./fixtures.js";

const promoted = (overrides: Parameters<typeof sampleManifest>[0] = {}) =>
  sampleManifest({
    name: "job-timeouts",
    title: "Bound every job with timeout-minutes",
    hypothesis: "Explicit timeouts free hung runners.",
    kind: "pipeline",
    status: "promoted",
    winner: "packagemanager",
    applicability: { rules: ["workflow/job-timeout"] },
    evidence: { improvement: 0.2, metrics: [{ metric: "duration", control: 600, arm: 480, delta: 0.2, pValue: 0.01 }] },
    ...overrides,
  });

const ciChange: PullRequestFile = { filename: ".github/workflows/ci.yml", status: "modified", patch: "@@ -1 +1,2 @@\n jobs:\n+  timeout-minutes: 30" };

describe("classifyRisk", () => {
  it("rates workflow-only changes low, containers and other files medium, packages high", () => {
    expect(classifyRisk([])).toBe("low");
    expect(classifyRisk([".github/workflows/ci.yml", ".github/actions/setup/action.yml"])).toBe("low");
    expect(classifyRisk([".github/workflows/ci.yml", "Dockerfile"])).toBe("medium");
    expect(classifyRisk(["services/api/Dockerfile.build"])).toBe("medium");
    expect(classifyRisk(["scripts/ci.sh"])).toBe("medium");
    expect(classifyRisk(["package.json"])).toBe("high");
    expect(classifyRisk(["apps/web/pnpm-lock.yaml"])).toBe("high");
    expect(classifyRisk(Array.from({ length: 11 }, (_, i) => `.github/workflows/w${i}.yml`))).toBe("high");
  });

  it("orders risks", () => {
    expect(riskAtMost("low", "medium")).toBe(true);
    expect(riskAtMost("high", "medium")).toBe(false);
    expect(riskAtMost("medium", "medium")).toBe(true);
  });
});

describe("renderPatch", () => {
  it("renders added, removed, renamed, and binary files", () => {
    const patch = renderPatch([
      { filename: "a.yml", status: "added", patch: "+x" },
      { filename: "b.yml", status: "removed", patch: "-y" },
      { filename: "new.yml", previous_filename: "old.yml", status: "renamed", patch: "" },
      { filename: "logo.png", status: "modified" },
    ]);
    expect(patch).toContain("--- /dev/null\n+++ b/a.yml\n+x");
    expect(patch).toContain("--- a/b.yml\n+++ /dev/null");
    expect(patch).toContain("diff --git a/old.yml b/new.yml");
    expect(patch).toContain("(binary or too large to show)");
  });

  it("truncates large patches", () => {
    const patch = renderPatch([ciChange, { ...ciChange, filename: "x.yml", patch: "+".repeat(500) }], 200);
    expect(patch).toContain("truncated");
    expect(patch).not.toContain("x.yml");
  });
});

describe("buildRecipe", () => {
  it("builds a recipe from a promoted pipeline experiment", () => {
    const result = buildRecipe({ manifest: promoted(), repository: "acme/platform", files: [ciChange, { filename: "experiments/job-timeouts/experiment.yml", status: "modified" }], pullRequest: 12, promotedAt: "2026-11-03T00:00:00Z" });
    if (!("recipe" in result)) throw new Error(result.error);
    expect(result.changed).toBe(true);
    expect(result.recipe).toMatchObject({
      id: "job-timeouts",
      revision: 1,
      risk: "low",
      rules: ["workflow/job-timeout"],
      files: [],
      instructions: "packageManager field: Read package.json packageManager.",
      evidence: { improvement: 0.2 },
      source: { repository: "acme/platform", experiment: "job-timeouts", arm: "packagemanager", pullRequest: 12, promotedAt: "2026-11-03T00:00:00Z" },
      patchFiles: [".github/workflows/ci.yml"],
      compatibility: { passed: 0, failed: 0 },
    });
    expect(result.recipe.patch).toContain("timeout-minutes: 30");
    expect(result.recipe.patch).not.toContain("experiments/");
  });

  it("skips experiments that are not promoted pipeline changes", () => {
    expect(buildRecipe({ manifest: promoted({ kind: "rules" }), repository: "a/b", files: [] })).toMatchObject({ skipped: true });
    expect(buildRecipe({ manifest: promoted({ status: "running" }), repository: "a/b", files: [] })).toMatchObject({ skipped: true });
  });

  it("rejects unknown winners and recipes without applicability", () => {
    expect(buildRecipe({ manifest: promoted({ winner: "ghost" }), repository: "a/b", files: [] })).toMatchObject({ error: expect.stringContaining("ghost") });
    const result = buildRecipe({ manifest: promoted({ applicability: {} }), repository: "a/b", files: [] });
    expect(result).toMatchObject({ error: expect.stringContaining("no applicability") });
    expect("skipped" in result && result.skipped).toBeFalsy();
  });

  it("falls back to the changed files when there are no rules or globs", () => {
    const result = buildRecipe({ manifest: promoted({ applicability: {} }), repository: "a/b", files: [ciChange] });
    expect("recipe" in result && result.recipe.files).toEqual([".github/workflows/ci.yml"]);
  });

  it("keeps the revision and compatibility when content is unchanged, bumps and resets otherwise", () => {
    const first = buildRecipe({ manifest: promoted(), repository: "a/b", files: [ciChange] });
    if (!("recipe" in first)) throw new Error(first.error);
    const previous = { ...first.recipe, compatibility: { passed: 4, failed: 1 } };
    const same = buildRecipe({ manifest: promoted(), repository: "a/b", files: [ciChange], previous });
    expect(same).toMatchObject({ changed: false, recipe: { revision: 1, compatibility: { passed: 4, failed: 1 } } });
    const changed = buildRecipe({ manifest: promoted(), repository: "a/b", files: [{ ...ciChange, patch: "+  timeout-minutes: 20" }], previous });
    expect(changed).toMatchObject({ changed: true, recipe: { revision: 2, compatibility: { passed: 0, failed: 0 } } });
    const changedDefinition = buildRecipe({ manifest: promoted({ title: "Revised mitigation title" }), repository: "a/b", files: [ciChange], previous });
    expect(changedDefinition).toMatchObject({ changed: true, recipe: { revision: 2, compatibility: { passed: 0, failed: 0 } } });
  });

  it("honors custom excludes", () => {
    const result = buildRecipe({ manifest: promoted(), repository: "a/b", files: [ciChange], excludes: [".github/**"] });
    expect("recipe" in result && result.recipe.patchFiles).toEqual([]);
  });
});

describe("parseRecipe", () => {
  it("round-trips serialized recipes", () => {
    const recipe = sampleRecipe({ description: "Only for GitHub-hosted runners." });
    expect(parseRecipe(serializeRecipe(recipe))).toEqual({ problems: [], recipe });
  });

  it("reports invalid recipes", () => {
    expect(parseRecipe("[").problems[0]).toMatch(/Invalid YAML/);
    expect(parseRecipe("- a").problems).toEqual(["A recipe must be a mapping."]);
    const problems = parseRecipe("schemaVersion: 2\nid: Bad_Id\nrisk: extreme\n").problems;
    expect(problems).toEqual(
      expect.arrayContaining([
        "schemaVersion must be 1.",
        "id must be lowercase letters, digits and dashes.",
        "title is required.",
        "risk must be one of low, medium, high.",
        "source.repository, source.experiment and source.arm are required.",
        "A recipe needs rules or files to decide where it applies.",
      ]),
    );
  });

  it("normalizes optional numbers", () => {
    const text = serializeRecipe(sampleRecipe()).replace("revision: 1", "revision: 0").replace("passed: 0", "passed: -3");
    expect(parseRecipe(text).recipe).toMatchObject({ revision: 1, compatibility: { passed: 0 } });
  });
});

describe("helpers", () => {
  it("builds paths and source links", () => {
    expect(recipePath("job-timeouts")).toBe("recipes/job-timeouts.yml");
    expect(recipePath("x", "out/")).toBe("out/x.yml");
    expect(sourceUrl(sampleRecipe())).toBe("https://github.com/acme/platform/pull/7");
    expect(sourceUrl(sampleRecipe({ source: { repository: "a/b", experiment: "e", arm: "x" } }), "https://ghe.example")).toBe("https://ghe.example/a/b");
  });
});
