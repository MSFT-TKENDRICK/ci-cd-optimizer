import { parse } from "yaml";
import type { Diagnostic } from "../lint/types.js";
import type { HillClimbConfig } from "./config.js";
import type { ExperimentPullRequest, ExperimentState } from "./github.js";
import { renderRubric, scoreRubric, validateManifest, type ExperimentManifest, type RubricScore } from "./manifest.js";
import { planCiEnvironment, type CiEnvironmentModel } from "./plan.js";

export interface ProposalResult {
  manifest?: ExperimentManifest;
  rubric?: RubricScore;
  errors: string[];
}

const DAY = 86_400_000;

/**
 * Validates an agent-authored proposal in the trusted job. The agent never chooses timestamps or status, and a
 * proposal that misses the rubric bar or exceeds the concurrency budget is refused before any branch is created.
 */
export function validateProposal(
  text: string,
  options: { config: HillClimbConfig; running: readonly ExperimentState[]; knownNames: readonly string[]; now?: Date },
): ProposalResult {
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + options.config.selection.maxAgeDays * DAY).toISOString();
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    return { errors: [`manifest: ${(error as Error).message}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { errors: ["manifest: expected a YAML mapping"] };
  // Server-controlled fields: the agent cannot backdate, pre-promote, or pick a winner.
  const proposed: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  delete proposed.winner;
  const parsed = validateManifest({ ...proposed, createdAt, expiresAt, status: "running" }, { config: options.config });
  const errors = parsed.problems.map((problem) => `${problem.path || "manifest"}: ${problem.message}`);
  const manifest = parsed.manifest;
  if (!manifest) return { errors };
  const rubric = scoreRubric(manifest.rubric.scores, options.config.rubric);
  if (rubric.missing.length > 0) errors.push(`rubric: missing scores for ${rubric.missing.join(", ")}`);
  else if (!rubric.passed) errors.push(`rubric: weighted score ${rubric.score} is below the ${options.config.rubric.minScore} bar`);
  if (options.knownNames.includes(manifest.name)) errors.push(`name: an experiment named "${manifest.name}" already exists or was tried before`);
  const running = options.running.filter((state) => state.trunk?.state === "open").length;
  if (running >= options.config.selection.maxConcurrent) errors.push(`selection: ${running} experiments are already running (max ${options.config.selection.maxConcurrent})`);
  return { manifest, rubric, errors };
}

export interface GeneratorContextInput {
  config: HillClimbConfig;
  diagnostics?: readonly Diagnostic[];
  /** Optional telemetry digest (for example the critical-path report) that points at bottlenecks. */
  telemetry?: string;
  /** Optional explicit scheduling model. The context recomputes its plan; callers cannot supply an optimum claim. */
  ciModel?: CiEnvironmentModel;
  ciSearchBudget?: number;
  running: readonly ExperimentState[];
  history: readonly ExperimentPullRequest[];
  rules: ReadonlyArray<{ id: string; description: string }>;
}

function outcome(pull: ExperimentPullRequest): string {
  if (pull.merged) return "promoted and merged";
  if (pull.labels.includes("experiment:rejected")) return "rejected";
  if (pull.labels.includes("experiment:expired")) return "expired";
  if (pull.labels.includes("experiment:promote")) return pull.state === "open" ? "awaiting promotion review" : "promotion declined";
  return pull.state === "open" ? "running" : "closed";
}

/** Markdown briefing for the experiment-generator agent: rubric, current evidence, and what has been tried. */
export function generatorContext(input: GeneratorContextInput): string {
  if (input.ciSearchBudget !== undefined && !input.ciModel) throw new Error("A CI environment model is required for a planning search budget.");
  const ciPlan = input.ciModel
    ? planCiEnvironment(input.ciModel, input.ciSearchBudget === undefined ? {} : { searchBudget: input.ciSearchBudget })
    : undefined;
  const byRule = new Map<string, number>();
  for (const diagnostic of input.diagnostics ?? []) byRule.set(diagnostic.ruleId, (byRule.get(diagnostic.ruleId) ?? 0) + 1);
  const findings = [...byRule.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const metrics = input.config.metrics.map(
    (metric) =>
      `| \`${metric.id}\` | ${metric.source}${metric.workflow ? ` (\`${metric.workflow}\`${metric.job ? ` / ${metric.job}` : ""})` : ""} | ${metric.direction} | ${metric.weight} | ${metric.maxRegression === undefined ? "–" : `${Math.round(metric.maxRegression * 100)}%`} |`,
  );
  const trunks = input.history.filter((pull) => pull.arm === "trunk");
  return [
    "# Experiment generator context",
    "",
    "## Rubric",
    "",
    renderRubric(input.config.rubric),
    "",
    "## Metrics",
    "",
    "| Metric | Source | Direction | Weight | Max regression |",
    "| --- | --- | --- | --- | --- |",
    ...metrics,
    "",
    `Arms must beat the trunk control by at least ${(input.config.selection.minImprovement * 100).toFixed(1)}% (weighted) and must not modify: ${input.config.protectedPaths.map((path) => `\`${path}\``).join(", ")}.`,
    `At most ${input.config.selection.maxArms} arms per experiment and ${input.config.selection.maxConcurrent} concurrent experiments.`,
    "",
    "## Conditional CI policy planning",
    "",
    ...(ciPlan
      ? [
        "This plan was recomputed by the verified bounded CI environment optimizer. Use an optimal plan only as a candidate for an experiment, never as measured evidence or permission to promote. Validate the declared workflow correspondence and timing/resource assumptions independently. Budget exhaustion is not infeasibility.",
        "",
        "```json", JSON.stringify(ciPlan, null, 2), "```", "",
      ]
      : [
        "No CI environment model was supplied. Observed candidate scores and telemetry do not prove scheduling optimality. Use `experiments plan --model <ci-environment.json>` or supply `context --model` for an explicit bounded model; do not invent duration profiles or label heuristic proposals optimal.",
        "",
      ]),
    "## Current findings",
    "",
    ...(findings.length > 0 ? ["| Rule | Findings |", "| --- | --- |", ...findings.slice(0, 30).map(([rule, count]) => `| \`${rule}\` | ${count} |`)] : ["No findings were supplied."]),
    "",
    ...(input.telemetry ? ["## Telemetry", "", input.telemetry, ""] : []),
    "## Running experiments",
    "",
    ...(input.running.length > 0
      ? input.running.map((state) => `- \`${state.name}\` — ${state.trunk?.title ?? "(no trunk pull request)"} (${state.arms.length} arm PRs)`)
      : ["None."]),
    "",
    "## Past experiments (do not repeat without a new angle)",
    "",
    ...(trunks.length > 0 ? trunks.slice(0, 30).map((pull) => `- \`${pull.experiment}\` — ${pull.title.replace(/^experiment\([^)]*\):\s*/, "")} → **${outcome(pull)}**`) : ["None yet."]),
    "",
    "## Available rules",
    "",
    ...input.rules.map((rule) => `- \`${rule.id}\` — ${rule.description}`),
  ].join("\n");
}

export function knownExperimentNames(pulls: readonly ExperimentPullRequest[]): string[] {
  return [...new Set(pulls.map((pull) => pull.experiment))];
}

export type { ExperimentManifest };
