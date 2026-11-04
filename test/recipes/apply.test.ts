import { describe, expect, it } from "vitest";
import { activeRecipeRules, planRecipe, recipeGroup, recipeIssue, recipeLintConfig, recipePullRequestBody, recipeTitle } from "../../src/recipes/apply.js";
import { compatibility } from "../../src/recipes/compat.js";
import { findMarker, parseMarker } from "../../src/issues/markers.js";
import { CLEAN, defaultConfig, EXCESSIVE_TIMEOUT, MISSING_TIMEOUT, MIXED_TIMEOUTS, sampleRecipe, workflowInput } from "./fixtures.js";

const config = defaultConfig();
const render = { compatibility: compatibility({ passed: 0, failed: 0 }) };

describe("planRecipe", () => {
  it("opens an autofix change when rule fixes resolve every finding", () => {
    const plan = planRecipe({ recipe: sampleRecipe(), input: workflowInput(MISSING_TIMEOUT), config });
    expect(plan).toMatchObject({ status: "autofix", rules: ["workflow/job-timeout"], remaining: [] });
    expect(plan.change?.group).toBe(recipeGroup(sampleRecipe()));
    expect(plan.change?.files[0]?.content).toContain("timeout-minutes: 30");
  });

  it("is partial when only some findings can be fixed", () => {
    const plan = planRecipe({ recipe: sampleRecipe(), input: workflowInput(MIXED_TIMEOUTS), config });
    expect(plan.status).toBe("partial");
    expect(plan.change).toBeDefined();
    expect(plan.remaining).toHaveLength(1);
    expect(plan.remaining[0]?.message).toContain("above the configured maximum");
  });

  it("needs adaptation when no autofix applies", () => {
    const plan = planRecipe({ recipe: sampleRecipe(), input: workflowInput(EXCESSIVE_TIMEOUT), config });
    expect(plan).toMatchObject({ status: "adapt" });
    expect(plan.change).toBeUndefined();
    expect(plan.remaining).toHaveLength(1);
  });

  it("does not apply to clean repositories", () => {
    expect(planRecipe({ recipe: sampleRecipe(), input: workflowInput(CLEAN), config }).status).toBe("not-applicable");
  });

  it("respects the target's opt-outs and risk tolerance", () => {
    const input = workflowInput(MISSING_TIMEOUT);
    expect(planRecipe({ recipe: sampleRecipe(), input, config: defaultConfig({ enabled: false }) }).status).toBe("ignored");
    expect(planRecipe({ recipe: sampleRecipe(), input, config: defaultConfig({ recipes: { ...config.recipes, enabled: false } }) }).status).toBe("ignored");
    expect(planRecipe({ recipe: sampleRecipe(), input, config: defaultConfig({ recipes: { ...config.recipes, ignore: ["job-timeouts"] } }) }).status).toBe("ignored");
    expect(planRecipe({ recipe: sampleRecipe({ risk: "high" }), input, config }).status).toBe("too-risky");
    expect(planRecipe({ recipe: sampleRecipe(), input, config: defaultConfig({ rules: { "workflow/job-timeout": "off" } }) })).toMatchObject({
      status: "ignored",
      reason: expect.stringContaining("turned off"),
    });
  });

  it("keeps the target's rule options", () => {
    const plan = planRecipe({ recipe: sampleRecipe(), input: workflowInput(MISSING_TIMEOUT), config: defaultConfig({ rules: { "workflow/job-timeout": ["error", { defaultMinutes: 12 }] } }) });
    expect(plan.change?.files[0]?.content).toContain("timeout-minutes: 12");
  });

  it("does not resolve findings the target ignores for fixes", () => {
    const ignoring = defaultConfig({ fixes: { ...config.fixes, ignore: [{ rule: "workflow/job-timeout" }] } });
    expect(planRecipe({ recipe: sampleRecipe(), input: workflowInput(MISSING_TIMEOUT), config: ignoring }).status).toBe("not-applicable");
  });

  it("matches file-based recipes by glob", () => {
    const recipe = sampleRecipe({ rules: [], files: ["**/Dockerfile"] });
    const docker = { files: [{ path: "svc/Dockerfile", content: "FROM node:22\n" }], mode: "repository" as const, inventoryComplete: true };
    expect(planRecipe({ recipe, input: docker, config })).toMatchObject({ status: "adapt", matchedFiles: ["svc/Dockerfile"] });
    expect(planRecipe({ recipe, input: workflowInput(CLEAN), config }).status).toBe("not-applicable");
  });

  it("accepts an injected lint engine", () => {
    const plan = planRecipe({ recipe: sampleRecipe(), input: workflowInput(MISSING_TIMEOUT), config, lint: (input) => ({ diagnostics: [], files: input.files.length }) as never });
    expect(plan.status).toBe("not-applicable");
  });
});

describe("rule selection", () => {
  it("drops rules turned off by id or ruleset unless explicitly re-enabled", () => {
    const recipe = sampleRecipe({ rules: ["workflow/job-timeout", "hermeticity/pin-runner"] });
    expect(activeRecipeRules(recipe, defaultConfig({ rulesets: { workflow: "off" } }))).toEqual(["hermeticity/pin-runner"]);
    expect(activeRecipeRules(recipe, defaultConfig({ rulesets: { workflow: "off" }, rules: { "workflow/job-timeout": "warn" } }))).toEqual(recipe.rules);
  });

  it("lints only the recipe's rules", () => {
    const lintConfig = recipeLintConfig(["workflow/job-timeout"], defaultConfig({ rules: { "workflow/job-timeout": ["error", { maxMinutes: 60 }] } }));
    expect(lintConfig).toMatchObject({ extends: [], rulesets: {}, rules: { "workflow/job-timeout": ["warn", { maxMinutes: 60 }] } });
  });
});

describe("rendering", () => {
  const recipe = sampleRecipe();

  it("renders a pull request with fix and recipe markers", () => {
    const plan = planRecipe({ recipe, input: workflowInput(MISSING_TIMEOUT), config });
    if (!plan.change) throw new Error("expected a change");
    const body = recipePullRequestBody(recipe, plan.change, { ...render, commitSha: "abc", ignoredRules: [] });
    expect(parseMarker(body)?.kind).toBe("fix");
    expect(findMarker(body, "recipe")).toMatchObject({ fingerprint: "job-timeouts", attributes: { revision: "1" } });
    expect(body).toContain("| duration | 600 | 492 | 18% | 0.010 |");
    expect(body).toContain("https://github.com/acme/platform/pull/7");
    expect(body).toContain("`.github/workflows/ci.yml`");
    expect(recipeTitle(sampleRecipe({ title: "Pin runners." }))).toBe("ci: Pin runners (recipe job-timeouts)");
  });

  it("renders an adaptation issue for coding agents", () => {
    const plan = planRecipe({ recipe, input: workflowInput(EXCESSIVE_TIMEOUT), config });
    const issue = recipeIssue(recipe, plan, { ...render, config, owner: "acme", repo: "web", sha: "deadbeef" });
    expect(parseMarker(issue.body)).toMatchObject({ kind: "recipe", fingerprint: "job-timeouts", attributes: { revision: "1", signature: issue.signature } });
    expect(issue).toMatchObject({ fingerprint: "job-timeouts", labels: ["cicd-optimizer", "recipe:job-timeouts"], assignCopilot: config.recipes.assignCopilot, priority: 1 });
    expect(issue.body).toContain("https://github.com/acme/web/blob/deadbeef/.github/workflows/ci.yml#L5");
    expect(issue.body).toContain("```diff");
    expect(issue.body).toContain("--rule workflow/job-timeout=error");
    expect(issue.body).toContain("Explicit timeouts: Add timeout-minutes to every job.");
  });

  it("links the partial pull request and uses a longer fence for patches containing fences", () => {
    const fenced = sampleRecipe({ patch: "+ ```\n+ code\n+ ```\n" });
    const plan = planRecipe({ recipe: fenced, input: workflowInput(MIXED_TIMEOUTS), config });
    const issue = recipeIssue(fenced, plan, { ...render, config, owner: "acme", repo: "web", sha: "s", pullRequest: 9 });
    expect(issue.body).toContain("are in #9");
    expect(issue.body).toContain("````diff");
  });

  it("changes the signature when the revision or remaining findings change", () => {
    const plan = planRecipe({ recipe, input: workflowInput(EXCESSIVE_TIMEOUT), config });
    const options = { ...render, config, owner: "acme", repo: "web", sha: "s" };
    const a = recipeIssue(recipe, plan, options).signature;
    expect(recipeIssue(recipe, plan, { ...options, sha: "other" }).signature).toBe(a);
    expect(recipeIssue(sampleRecipe({ revision: 2 }), plan, options).signature).not.toBe(a);
    expect(recipeIssue(recipe, { ...plan, remaining: [] }, options).signature).not.toBe(a);
  });
});
