import { parse } from "yaml";
import { Validator, type ConfigProblem } from "../lint/config.js";

export const HILL_CLIMB_CONFIG_PATH = ".github/hill-climb.yml";

export interface RubricCriterion {
  id: string;
  weight: number;
  description: string;
}

export interface Rubric {
  /** Weighted mean (1-5 scale) a proposal must reach before an experiment is created. */
  minScore: number;
  criteria: RubricCriterion[];
}

export type MetricSource = "corpus" | "ci";
export type CorpusMetric = "precision" | "recall" | "f1" | "fixRate" | "durationMs";
export const CORPUS_METRICS: readonly CorpusMetric[] = ["precision", "recall", "f1", "fixRate", "durationMs"];

export interface MetricSpec {
  id: string;
  source: MetricSource;
  direction: "maximize" | "minimize";
  weight: number;
  /** `ci` metrics: workflow file (for example `ci.yml`) whose successful-run duration is measured. */
  workflow?: string;
  /** `ci` metrics: measure one job instead of the whole run. */
  job?: string;
  /** Hard gate: reject an arm that regresses this metric by more than this fraction of the control value. */
  maxRegression?: number;
}

export interface SelectionConfig {
  /** Cap on the LLM judge's influence on the ranking (0 disables the judge). */
  judgeWeight: number;
  /** Successful CI runs required per arm (and control) before CI metrics are compared. */
  minSamples: number;
  /** One-sided Mann-Whitney p-value an arm must reach on every CI metric it improves. */
  pValue: number;
  /** Minimum weighted relative improvement over control for an arm to win. */
  minImprovement: number;
  maxAgeDays: number;
  maxConcurrent: number;
  maxArms: number;
}

export interface PromotionConfig {
  /** Enable auto-merge on the promotion pull request (branch protection still applies). */
  autoMerge: boolean;
  reviewers: string[];
  labels: string[];
}

/** How the grader builds and benchmarks each arm of a `rules` experiment (commands come from the trusted base branch). */
export interface EvaluationConfig {
  /** Benchmark corpus directory, read from the experiment trunk (arms cannot change it). */
  corpus: string;
  /** Built engine module, relative to an arm checkout, exporting the ENGINE_API_VERSION surface. */
  engine: string;
  install: string;
  build: string;
  test: string;
  /** Lint timing repetitions per corpus case (the median is reported). */
  timingRuns: number;
}

export interface HillClimbConfig {
  rubric: Rubric;
  metrics: MetricSpec[];
  selection: SelectionConfig;
  /** Paths arms must not modify (benchmarks, grader, configuration). Globs use `*` and `**`. */
  protectedPaths: string[];
  promotion: PromotionConfig;
  evaluation: EvaluationConfig;
}

export const DEFAULT_RUBRIC: Rubric = {
  minScore: 3.5,
  criteria: [
    { id: "impact", weight: 0.3, description: "Expected reduction in build, test, or release wall-clock time for high-volume agent-authored changes." },
    { id: "evidence", weight: 0.2, description: "Grounded in this repository's telemetry or findings, or in authoritative platform documentation." },
    { id: "safety", weight: 0.2, description: "Preserves security, hermeticity, required checks, and deploy correctness; easy to revert." },
    { id: "generality", weight: 0.15, description: "Likely to transfer to other repositories as a rule or recipe rather than a one-off tweak." },
    { id: "measurability", weight: 0.15, description: "Success is measurable with the configured metrics within the experiment window." },
  ],
};

export const DEFAULT_HILL_CLIMB_CONFIG: HillClimbConfig = {
  rubric: DEFAULT_RUBRIC,
  metrics: [
    { id: "precision", source: "corpus", direction: "maximize", weight: 0.35, maxRegression: 0.02 },
    { id: "recall", source: "corpus", direction: "maximize", weight: 0.35, maxRegression: 0.05 },
    { id: "fixRate", source: "corpus", direction: "maximize", weight: 0.15 },
    { id: "durationMs", source: "corpus", direction: "minimize", weight: 0.15, maxRegression: 0.5 },
  ],
  selection: { judgeWeight: 0.2, minSamples: 5, pValue: 0.05, minImprovement: 0.02, maxAgeDays: 14, maxConcurrent: 3, maxArms: 4 },
  protectedPaths: [".github/hill-climb.yml", "experiments/*/experiment.yml", "corpus/**"],
  promotion: { autoMerge: false, reviewers: [], labels: [] },
  evaluation: { corpus: "corpus", engine: "dist/lint/api.js", install: "npm ci --ignore-scripts", build: "npm run build", test: "npm test", timingRuns: 3 },
};

export interface ParsedHillClimbConfig {
  config: HillClimbConfig;
  problems: ConfigProblem[];
}

export function validateHillClimbConfig(input: unknown): ParsedHillClimbConfig {
  const v = new Validator();
  const defaults = DEFAULT_HILL_CLIMB_CONFIG;
  const root = v.record("", input);
  v.unknownKeys("", root, Object.keys(defaults));

  const rubricRaw = v.record("rubric", root.rubric);
  v.unknownKeys("rubric", rubricRaw, ["minScore", "criteria"]);
  let criteria = defaults.rubric.criteria;
  if (rubricRaw.criteria !== undefined) {
    if (!Array.isArray(rubricRaw.criteria) || rubricRaw.criteria.length === 0) v.problem("rubric.criteria", "Expected a non-empty list.");
    else {
      criteria = rubricRaw.criteria.map((entry, index) => {
        const path = `rubric.criteria[${index}]`;
        const item = v.record(path, entry);
        v.unknownKeys(path, item, ["id", "weight", "description"]);
        return { id: v.string(`${path}.id`, item.id, `criterion-${index}`), weight: v.number(`${path}.weight`, item.weight, 1), description: v.string(`${path}.description`, item.description, "") };
      });
    }
  }
  const rubric: Rubric = { minScore: v.number("rubric.minScore", rubricRaw.minScore, defaults.rubric.minScore, 1), criteria };
  if (rubric.minScore > 5) v.problem("rubric.minScore", "Expected a number between 1 and 5.");

  let metrics = defaults.metrics;
  if (root.metrics !== undefined) {
    if (!Array.isArray(root.metrics) || root.metrics.length === 0) v.problem("metrics", "Expected a non-empty list.");
    else {
      metrics = root.metrics.map((entry, index) => {
        const path = `metrics[${index}]`;
        const item = v.record(path, entry);
        v.unknownKeys(path, item, ["id", "source", "direction", "weight", "workflow", "job", "maxRegression"]);
        const metric: MetricSpec = {
          id: v.string(`${path}.id`, item.id, `metric-${index}`),
          source: v.oneOf(`${path}.source`, item.source, ["corpus", "ci"] as const, "corpus"),
          direction: v.oneOf(`${path}.direction`, item.direction, ["maximize", "minimize"] as const, "maximize"),
          weight: v.number(`${path}.weight`, item.weight, 1),
        };
        if (item.workflow !== undefined) metric.workflow = v.string(`${path}.workflow`, item.workflow, "");
        if (item.job !== undefined) metric.job = v.string(`${path}.job`, item.job, "");
        if (item.maxRegression !== undefined) metric.maxRegression = v.number(`${path}.maxRegression`, item.maxRegression, 0);
        if (metric.source === "corpus" && !(CORPUS_METRICS as readonly string[]).includes(metric.id)) {
          v.problem(`${path}.id`, `Corpus metrics are ${CORPUS_METRICS.join(", ")}.`);
        }
        if (metric.source === "ci" && !metric.workflow) v.problem(`${path}.workflow`, "CI metrics need the workflow file to measure.");
        return metric;
      });
    }
  }

  const selectionRaw = v.record("selection", root.selection);
  v.unknownKeys("selection", selectionRaw, Object.keys(defaults.selection));
  const s = defaults.selection;
  const selection: SelectionConfig = {
    judgeWeight: v.number("selection.judgeWeight", selectionRaw.judgeWeight, s.judgeWeight),
    minSamples: v.number("selection.minSamples", selectionRaw.minSamples, s.minSamples, 2),
    pValue: v.number("selection.pValue", selectionRaw.pValue, s.pValue),
    minImprovement: v.number("selection.minImprovement", selectionRaw.minImprovement, s.minImprovement),
    maxAgeDays: v.number("selection.maxAgeDays", selectionRaw.maxAgeDays, s.maxAgeDays, 1),
    maxConcurrent: v.number("selection.maxConcurrent", selectionRaw.maxConcurrent, s.maxConcurrent, 1),
    maxArms: v.number("selection.maxArms", selectionRaw.maxArms, s.maxArms, 1),
  };
  if (selection.judgeWeight > 0.5) v.problem("selection.judgeWeight", "Keep the judge weight at or below 0.5 so measurements dominate.");
  if (selection.pValue >= 1) v.problem("selection.pValue", "Expected a probability below 1.");

  const promotionRaw = v.record("promotion", root.promotion);
  v.unknownKeys("promotion", promotionRaw, Object.keys(defaults.promotion));
  const promotion: PromotionConfig = {
    autoMerge: v.boolean("promotion.autoMerge", promotionRaw.autoMerge, defaults.promotion.autoMerge),
    reviewers: v.strings("promotion.reviewers", promotionRaw.reviewers, defaults.promotion.reviewers),
    labels: v.strings("promotion.labels", promotionRaw.labels, defaults.promotion.labels),
  };

  const evaluationRaw = v.record("evaluation", root.evaluation);
  v.unknownKeys("evaluation", evaluationRaw, Object.keys(defaults.evaluation));
  const e = defaults.evaluation;
  const evaluation: EvaluationConfig = {
    corpus: v.string("evaluation.corpus", evaluationRaw.corpus, e.corpus),
    engine: v.string("evaluation.engine", evaluationRaw.engine, e.engine),
    install: v.string("evaluation.install", evaluationRaw.install, e.install),
    build: v.string("evaluation.build", evaluationRaw.build, e.build),
    test: v.string("evaluation.test", evaluationRaw.test, e.test),
    timingRuns: v.number("evaluation.timingRuns", evaluationRaw.timingRuns, e.timingRuns, 1),
  };

  return {
    config: { rubric, metrics, selection, protectedPaths: v.strings("protectedPaths", root.protectedPaths, defaults.protectedPaths), promotion, evaluation },
    problems: v.problems,
  };
}

export function parseHillClimbConfig(text: string | undefined): ParsedHillClimbConfig {
  if (text === undefined) return { config: structuredClone(DEFAULT_HILL_CLIMB_CONFIG), problems: [] };
  try {
    const raw: unknown = parse(text);
    return validateHillClimbConfig(raw ?? {});
  } catch (error) {
    return { config: structuredClone(DEFAULT_HILL_CLIMB_CONFIG), problems: [{ path: HILL_CLIMB_CONFIG_PATH, message: (error as Error).message }] };
  }
}
