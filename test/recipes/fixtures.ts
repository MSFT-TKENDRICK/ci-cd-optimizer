import { parseConfigText, type LintConfig } from "../../src/lint/config.js";
import { allRules } from "../../src/lint/rules/index.js";
import type { AnalysisInput } from "../../src/lint/types.js";
import type { Recipe } from "../../src/recipes/recipe.js";

export const sampleRecipe = (overrides: Partial<Recipe> = {}): Recipe => ({
  schemaVersion: 1,
  id: "job-timeouts",
  revision: 1,
  title: "Bound every job with timeout-minutes",
  summary: "Hung jobs hold runners for 6 hours; explicit timeouts free them and surface hangs quickly.",
  risk: "low",
  rules: ["workflow/job-timeout"],
  files: [],
  instructions: "Explicit timeouts: Add timeout-minutes to every job.",
  evidence: { improvement: 0.18, metrics: [{ metric: "duration", control: 600, arm: 492, delta: 0.18, pValue: 0.01 }] },
  source: { repository: "acme/platform", experiment: "job-timeouts", arm: "explicit", pullRequest: 7, promotedAt: "2026-11-02T00:00:00Z" },
  patch: "--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -3,2 +3,3 @@\n   test:\n+    timeout-minutes: 30\n     runs-on: ubuntu-24.04\n",
  patchFiles: [".github/workflows/ci.yml"],
  compatibility: { passed: 0, failed: 0 },
  ...overrides,
});

export function defaultConfig(overrides: Partial<LintConfig> = {}): LintConfig {
  const parsed = parseConfigText("", allRules);
  return { ...parsed.config, ...overrides };
}

export function workflowInput(content: string, path = ".github/workflows/ci.yml"): AnalysisInput {
  return { files: [{ path, content }], mode: "repository", inventoryComplete: true };
}

export const MISSING_TIMEOUT = "on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n";
export const EXCESSIVE_TIMEOUT = "on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 300\n    steps:\n      - run: echo hi\n";
export const MIXED_TIMEOUTS = "on: push\njobs:\n  a:\n    runs-on: x\n  b:\n    runs-on: y\n    timeout-minutes: 300\n";
export const CLEAN = "on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n    steps:\n      - run: echo hi\n";
