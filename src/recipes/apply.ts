import { lint as lintWith } from "../lint/api.js";
import type { FixesConfig, LintConfig, RuleSetting } from "../lint/config.js";
import { allRules } from "../lint/rules/index.js";
import type { AnalysisInput, Diagnostic, LintResult } from "../lint/types.js";
import { computeFixChanges, isIgnored, type FixChange } from "../fixes/plan.js";
import { fixMarker } from "../fixes/render.js";
import { COMMAND_HELP } from "../fixes/commands.js";
import { marker, signatureOf } from "../issues/markers.js";
import type { DesiredIssue } from "../issues/plan.js";
import { matchesGlob } from "../utils.js";
import type { Compatibility } from "./compat.js";
import { riskAtMost, sourceUrl, type Recipe } from "./recipe.js";

/**
 * - ignored: the target disabled recipes, ignores this one, or turned off all of its rules;
 * - too-risky: the recipe's risk exceeds the target's `recipes.maxRisk`;
 * - not-applicable: none of the recipe's findings or files exist in the target;
 * - autofix: rule autofixes resolve every finding (pull request);
 * - partial: autofixes resolve some findings (pull request + adaptation issue for the rest);
 * - adapt: no deterministic fix; a coding agent adapts the reference change (issue).
 */
export type RecipeStatus = "ignored" | "too-risky" | "not-applicable" | "autofix" | "partial" | "adapt";

export interface RecipePlan {
  status: RecipeStatus;
  reason: string;
  /** Rules of the recipe that are active in the target. */
  rules: string[];
  change?: FixChange;
  /** Findings that remain after autofixes (adaptation work). */
  remaining: Diagnostic[];
  /** Target files matching the recipe's `files` globs. */
  matchedFiles: string[];
}

export const recipeGroup = (recipe: Pick<Recipe, "id">) => `recipe-${recipe.id}`;

function isOff(setting: RuleSetting | undefined): boolean {
  return setting === "off" || (Array.isArray(setting) && setting[0] === "off");
}

/** Rules the target explicitly turned off (by id or ruleset) are never re-introduced by a recipe. */
export function activeRecipeRules(recipe: Recipe, config: LintConfig): string[] {
  return recipe.rules.filter((id) => {
    if (isOff(config.rules[id])) return false;
    const ruleset = allRules.find((rule) => rule.meta.id === id)?.meta.ruleset ?? id.split("/")[0];
    return !(ruleset !== undefined && config.rulesets[ruleset] === "off" && config.rules[id] === undefined);
  });
}

/** Lints with only the recipe's rules, keeping the target's rule options (severity is normalized to warn). */
export function recipeLintConfig(rules: readonly string[], config: LintConfig): LintConfig {
  const settings: Record<string, RuleSetting> = {};
  for (const id of rules) {
    const current = config.rules[id];
    settings[id] = Array.isArray(current) ? ["warn", current[1]] : "warn";
  }
  return { ...config, enabled: true, extends: [], rulesets: {}, rules: settings };
}

export interface PlanRecipeOptions {
  recipe: Recipe;
  input: AnalysisInput;
  config: LintConfig;
  lint?: (input: AnalysisInput, config: LintConfig) => LintResult;
}

export function planRecipe(options: PlanRecipeOptions): RecipePlan {
  const { recipe, input, config } = options;
  const empty = { rules: [], remaining: [], matchedFiles: [] };
  if (!config.enabled || !config.recipes.enabled) return { ...empty, status: "ignored", reason: "Recipes are disabled in this repository." };
  if (config.recipes.ignore.includes(recipe.id)) return { ...empty, status: "ignored", reason: `\`recipes.ignore\` lists "${recipe.id}".` };
  if (!riskAtMost(recipe.risk, config.recipes.maxRisk)) {
    return { ...empty, status: "too-risky", reason: `Recipe risk is ${recipe.risk}; \`recipes.maxRisk\` is ${config.recipes.maxRisk}.` };
  }
  const matchedFiles = input.files.map((file) => file.path).filter((path) => recipe.files.some((glob) => matchesGlob(path, glob)));
  if (recipe.rules.length === 0) {
    return matchedFiles.length > 0
      ? { rules: [], remaining: [], matchedFiles, status: "adapt", reason: `${matchedFiles.length} file(s) match the recipe; the change must be adapted.` }
      : { ...empty, status: "not-applicable", reason: "No files match the recipe." };
  }
  const rules = activeRecipeRules(recipe, config);
  if (rules.length === 0) return { ...empty, status: "ignored", reason: "All of the recipe's rules are turned off in this repository." };

  const lintConfig = recipeLintConfig(rules, config);
  const run = options.lint ?? ((target: AnalysisInput, effective: LintConfig) => lintWith({ input: target, config: effective }));
  const relevant = (result: LintResult): LintResult => ({
    ...result,
    diagnostics: result.diagnostics.filter((d) => rules.includes(d.ruleId) && !isIgnored(d, config.fixes)),
  });
  const lint = (target: AnalysisInput) => relevant(run(target, lintConfig));
  const findings = lint(input).diagnostics;
  if (findings.length === 0) return { rules, remaining: [], matchedFiles, status: "not-applicable", reason: "No findings for the recipe's rules." };

  const group = recipeGroup(recipe);
  const fixes: FixesConfig = { ...config.fixes, groups: { [group]: { rules } } };
  const change = computeFixChanges({ input, lint, config: fixes }).find((candidate) => candidate.group === group);
  if (!change) return { rules, remaining: findings, matchedFiles, status: "adapt", reason: `${findings.length} finding(s) need an adapted change (no autofix applies).` };
  const updated = new Map(change.files.map((file) => [file.path, file.content]));
  const remaining = lint({ ...input, files: input.files.map((file) => ({ path: file.path, content: updated.get(file.path) ?? file.content })) }).diagnostics;
  return remaining.length === 0
    ? { rules, change, remaining, matchedFiles, status: "autofix", reason: `Autofixes resolve all ${findings.length} finding(s).` }
    : { rules, change, remaining, matchedFiles, status: "partial", reason: `Autofixes resolve ${findings.length - remaining.length} of ${findings.length} finding(s).` };
}

export interface RecipeRenderContext {
  compatibility: Compatibility;
  server?: string;
}

const pct = (value: number) => `${value >= 0 ? "" : "−"}${Math.abs(Math.round(value * 1000) / 10)}%`;

function evidenceLines(recipe: Recipe, context: RecipeRenderContext): string[] {
  const lines = [
    `**Risk:** ${recipe.risk} · **Expected improvement:** ${pct(recipe.evidence.improvement)} · **Compatibility:** ${context.compatibility.display}`,
    "",
  ];
  if (recipe.evidence.metrics.length > 0) {
    lines.push("| Metric | Control | Winner | Change | p-value |", "| --- | --- | --- | --- | --- |");
    for (const metric of recipe.evidence.metrics) {
      const value = (n: number | undefined) => (n === undefined ? "–" : String(Math.round(n * 100) / 100));
      lines.push(`| ${metric.metric} | ${value(metric.control)} | ${value(metric.arm)} | ${pct(metric.delta)} | ${metric.pValue === undefined ? "–" : metric.pValue.toPrecision(2)} |`);
    }
    lines.push("");
  }
  lines.push(
    `Measured in [\`${recipe.source.repository}\`](${sourceUrl(recipe, context.server)}) by experiment \`${recipe.source.experiment}\` (winning arm \`${recipe.source.arm}\`).`,
  );
  return lines;
}

export function recipeTitle(recipe: Recipe): string {
  return `ci: ${recipe.title.replace(/\.$/, "")} (recipe ${recipe.id})`;
}

export function recipePullRequestBody(recipe: Recipe, change: FixChange, context: RecipeRenderContext & { commitSha: string; ignoredRules: readonly string[] }): string {
  const lines = [
    fixMarker(change, context),
    `${marker("recipe", recipe.id, { revision: String(recipe.revision) })}`,
    `## ♻️ CI/CD recipe: ${recipe.title}`,
    "",
    recipe.summary,
    "",
    ...evidenceLines(recipe, context),
    "",
    "### Changes",
    "",
  ];
  for (const file of change.files) {
    lines.push(`- \`${file.path}\``);
    for (const diagnostic of change.applied.filter((d) => d.path === file.path)) lines.push(`  - L${diagnostic.line} \`${diagnostic.ruleId}\`: ${diagnostic.fix?.description ?? diagnostic.message}`);
  }
  lines.push(
    "",
    "### Review notes",
    "",
    "- The edits are the deterministic autofixes of the rules this recipe resolves, computed against this repository (not a copied diff).",
    "- Merge when CI passes; the outcome feeds the recipe's compatibility score that gates rollout to more repositories.",
    `- Add \`${recipe.id}\` to \`recipes.ignore\` in \`.github/ci-cd-optimizer.yml\` to stop receiving this recipe.`,
    "",
    COMMAND_HELP,
  );
  return lines.join("\n");
}

export function recipeIssue(
  recipe: Recipe,
  plan: RecipePlan,
  options: RecipeRenderContext & { config: LintConfig; owner: string; repo: string; sha: string; pullRequest?: number },
): DesiredIssue {
  const signature = signatureOf([String(recipe.revision), plan.status, ...plan.remaining.map((d) => d.fingerprint).sort(), ...plan.matchedFiles]);
  const server = options.server ?? "https://github.com";
  const link = (path: string, line?: number) => `${server}/${options.owner}/${options.repo}/blob/${options.sha}/${path}${line ? `#L${line}` : ""}`;
  const lines = [
    marker("recipe", recipe.id, { revision: String(recipe.revision), signature }),
    `## ♻️ Adapt CI/CD recipe: ${recipe.title}`,
    "",
    recipe.summary,
    "",
    ...evidenceLines(recipe, options),
    "",
  ];
  if (plan.status === "partial" && options.pullRequest !== undefined) {
    lines.push(`Deterministic parts of this recipe are in #${options.pullRequest}; this issue covers what could not be fixed automatically.`, "");
  }
  if (plan.remaining.length > 0) {
    lines.push("### Findings to resolve", "");
    for (const diagnostic of plan.remaining.slice(0, 50)) {
      lines.push(`- [ ] [\`${diagnostic.path}:${diagnostic.line}\`](${link(diagnostic.path, diagnostic.line)}) \`${diagnostic.ruleId}\`: ${diagnostic.message}`);
      if (diagnostic.suggestion) lines.push(`  - **Suggested fix:** ${diagnostic.suggestion}`);
    }
    if (plan.remaining.length > 50) lines.push(`- _…and ${plan.remaining.length - 50} more._`);
    lines.push("");
  } else if (plan.matchedFiles.length > 0) {
    lines.push("### Files in scope", "", ...plan.matchedFiles.slice(0, 50).map((path) => `- [\`${path}\`](${link(path)})`), "");
  }
  lines.push("### Approach that won the experiment", "", recipe.instructions, "");
  if (recipe.description) lines.push(recipe.description, "");
  if (recipe.patch) {
    const fence = recipe.patch.includes("```") ? "````" : "```";
    lines.push(
      "<details><summary>Reference change from the source repository</summary>",
      "",
      "Adapt this to this repository's layout, tool versions and package manager; do not copy it verbatim.",
      "",
      `${fence}diff`,
      recipe.patch.replace(/\n$/, ""),
      fence,
      "",
      "</details>",
      "",
    );
  }
  lines.push(
    "### Instructions for coding agents",
    "",
    "1. Apply the approach above with the smallest behavior-preserving change for this repository.",
    ...(plan.rules.length > 0
      ? [`2. Verify: \`npx ci-cd-optimizer lint ${plan.rules.map((rule) => `--rule ${rule}=error`).join(" ")}\` reports no findings for ${plan.rules.map((rule) => `\`${rule}\``).join(", ")}, and existing CI passes.`]
      : ["2. Verify that existing CI passes and that the job durations do not regress."]),
    "3. Never add top-level `on.pull_request.paths` filters to workflows that provide required checks, never enable `cancel-in-progress` on deploy/release workflows, and do not weaken permissions or action pinning.",
    "4. Report the CI duration before and after in the pull request description.",
    "",
    `<sub>Opened by CI/CD Optimizer (recipe \`${recipe.id}\`, revision ${recipe.revision}). Close as **not planned** to decline this recipe, or add it to \`recipes.ignore\`.</sub>`,
  );
  return {
    fingerprint: recipe.id,
    signature,
    title: `CI/CD recipe: ${recipe.title.replace(/\.$/, "")}`,
    body: lines.join("\n"),
    labels: [...new Set(["cicd-optimizer", `recipe:${recipe.id}`, ...options.config.recipes.labels])],
    assignees: [],
    assignCopilot: options.config.recipes.assignCopilot,
    priority: { low: 1, medium: 2, high: 3 }[recipe.risk],
  };
}
