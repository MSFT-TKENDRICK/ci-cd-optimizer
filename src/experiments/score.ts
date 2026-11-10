import { BigNumber } from "bignumber.js";
import { mannWhitneyGreater, median } from "../alerts/stats.js";
import { evaluateCandidate, OBJECTIVE_SCALE, quantize, WEIGHT_SCALE, type KernelCandidate } from "../formal/selection.js";
import { matchesGlob } from "../utils.js";
import { ciProjection, validatedCiSeries, type CiEvidence } from "./ci-evidence.js";
import { validateHillClimbConfig, type HillClimbConfig, type MetricSpec } from "./config.js";
import type { CorpusMetrics } from "./corpus.js";
import { armBranch, trunkBranch, type ExperimentManifest } from "./manifest.js";

/** Everything the grader measured for one branch (an arm or the trunk control). */
export interface BranchMeasurement {
  arm: string;
  headSha?: string;
  pullRequest?: number;
  /** `rules` experiments: benchmark metrics of this branch's engine build. */
  corpus?: CorpusMetrics;
  /** Display-compatible projection only: CI eligibility additionally requires matching ciEvidence. */
  ci?: Record<string, number[]>;
  ciEvidence?: Record<string, CiEvidence>;
  /** undefined while checks are still running. */
  testsPassed?: boolean;
  changedPaths: string[];
  judge?: { score: number; rationale: string };
  error?: string;
}

export interface ExperimentMeasurements {
  experiment: string;
  collectedAt: string;
  /** Set by the CLI when the experiment scores corpus metrics, so the grader knows to build and benchmark arms. */
  needsCorpus?: boolean;
  control: BranchMeasurement;
  arms: BranchMeasurement[];
}

export interface MetricComparison {
  id: string;
  weight: number;
  direction: MetricSpec["direction"];
  control?: number;
  arm?: number;
  /** Relative improvement over control in [-1, 1]; positive is better regardless of direction. */
  delta: number;
  pValue?: number;
  /** Samples still needed for a CI metric (control, arm). */
  needs?: { control: number; arm: number };
  evidenceIssue?: string;
  error?: string;
}

export interface ArmScore {
  arm: string;
  metrics: MetricComparison[];
  /** Weighted mean of metric deltas; the judge cannot change it. */
  deterministic: number;
  /** Ranking score: deterministic, nudged by the judge within `selection.judgeWeight`. */
  rank: number;
  pending: string[];
  failures: string[];
  qualifies: boolean;
}

const EPSILON = 1e-9;
const clamp = (value: number) => Math.max(-1, Math.min(1, value));
const round = (value: number) => quantize(value) / OBJECTIVE_SCALE;
const finite = (value: number, maximum: number) => Number.isFinite(value) && value >= 0 && value <= maximum;

export function selectionParameters(config: HillClimbConfig): { minimum: number; influence: number } {
  return {
    minimum: finite(config.selection.minImprovement, 1) ? quantize(config.selection.minImprovement, OBJECTIVE_SCALE, BigNumber.ROUND_CEIL) : 0,
    influence: finite(config.selection.judgeWeight, 0.5) ? quantize(config.selection.judgeWeight) : 0,
  };
}

export function metricsFor(manifest: ExperimentManifest, config: HillClimbConfig): MetricSpec[] {
  if (manifest.metrics?.length) return config.metrics.filter((spec) => manifest.metrics?.includes(spec.id));
  const source = manifest.kind === "rules" ? "corpus" : "ci";
  return config.metrics.filter((spec) => spec.source === source);
}

function relativeDelta(spec: MetricSpec, control: number, arm: number): number {
  const change = spec.direction === "maximize" ? arm - control : control - arm;
  if (Math.abs(control) < EPSILON) return change === 0 ? 0 : clamp(Math.sign(change));
  return clamp(change / Math.abs(control));
}

function corpusValue(metrics: CorpusMetrics | undefined, id: string): number | undefined {
  switch (id) {
    case "precision": return metrics?.precision;
    case "recall": return metrics?.recall;
    case "f1": return metrics?.f1;
    case "fixRate": return metrics?.fixRate;
    case "durationMs": return metrics?.durationMs;
    default: return undefined;
  }
}

function compare(spec: MetricSpec, control: BranchMeasurement, arm: BranchMeasurement, config: HillClimbConfig, manifest: ExperimentManifest): MetricComparison {
  const base: MetricComparison = { id: spec.id, weight: finite(spec.weight, 1_000_000) ? spec.weight : 0, direction: spec.direction, delta: 0 };
  if (spec.source === "corpus") {
    const c = corpusValue(control.corpus, spec.id);
    const a = corpusValue(arm.corpus, spec.id);
    if (c === undefined || a === undefined) return base;
    const maximum = spec.id === "durationMs" ? 1_000_000_000_000 : 1;
    if (!finite(c, maximum) || !finite(a, maximum)) return { ...base, error: `${spec.id} contains an invalid measurement` };
    return { ...base, control: c, arm: a, delta: round(relativeDelta(spec, c, a)) };
  }
  if (![ciProjection(control, spec.id), ciProjection(arm, spec.id)].every((samples) => Array.isArray(samples) && samples.length <= 10_000 && Array.from(samples).every((sample) => finite(sample, 1_000_000_000_000)))) {
    return { ...base, error: `${spec.id} contains invalid CI samples` };
  }
  const cEvidence = validatedCiSeries(spec, control, { branch: trunkBranch(manifest.name), since: manifest.createdAt });
  const aEvidence = validatedCiSeries(spec, arm, { branch: armBranch(manifest.name, arm.arm), since: manifest.createdAt });
  const cSamples = cEvidence.values;
  const aSamples = aEvidence.values;
  const minSamples = config.selection.minSamples;
  if (!Number.isInteger(minSamples) || minSamples < 2 || minSamples > 10_000 || !finite(config.selection.pValue, 1)) {
    return { ...base, error: "invalid sampling policy" };
  }
  const controlRuns = new Set(cEvidence.runIds);
  if ((cEvidence.cohort && aEvidence.cohort && cEvidence.cohort !== aEvidence.cohort) || aEvidence.runIds.some((id) => controlRuns.has(id))) {
    return { ...base, needs: { control: minSamples, arm: minSamples }, evidenceIssue: `${spec.id} mixes repositories/workflow identities or reuses the control's runs` };
  }
  if (cSamples.length < minSamples || aSamples.length < minSamples) {
    const issue = cEvidence.issue ?? aEvidence.issue;
    return { ...base, needs: { control: Math.max(0, minSamples - cSamples.length), arm: Math.max(0, minSamples - aSamples.length) }, ...(issue ? { evidenceIssue: issue } : {}) };
  }
  const c = median(cSamples);
  const a = median(aSamples);
  const delta = relativeDelta(spec, c, a);
  // This heuristic selects the tail after observing the direction; it is not a causal or noise-free guarantee.
  const better = delta > 0;
  const [high, low] = (spec.direction === "minimize") === better ? [cSamples, aSamples] : [aSamples, cSamples];
  const pValue = mannWhitneyGreater(high, low).pValue;
  if (!finite(pValue, 1)) return { ...base, error: `${spec.id} produced an invalid p-value` };
  const significant = delta !== 0 && pValue < config.selection.pValue;
  return { ...base, control: c, arm: a, pValue: round(pValue), delta: significant ? round(delta) : 0 };
}

export function evaluateArm(
  manifest: ExperimentManifest,
  control: BranchMeasurement,
  arm: BranchMeasurement,
  config: HillClimbConfig,
): { score: ArmScore; candidate: KernelCandidate } {
  const specs = metricsFor(manifest, config);
  const metrics = specs.map((spec) => compare(spec, control, arm, config, manifest));
  const pending: string[] = [];
  const failures: string[] = [];
  const configProblems = validateHillClimbConfig(config).problems;
  const invalidMetrics = specs.length === 0 || !specs.some((spec) => spec.weight > 0);
  const invalidMetricSelection = manifest.metrics !== undefined && (new Set(manifest.metrics).size !== manifest.metrics.length || manifest.metrics.some((id) => !config.metrics.some((spec) => spec.id === id)));
  const invalidJudge = arm.judge !== undefined && !finite(arm.judge.score, 1);
  const invalidChecks = [arm.testsPassed, control.testsPassed].some((value) => value !== undefined && typeof value !== "boolean");
  if (configProblems.length > 0) failures.push(`invalid scoring configuration: ${configProblems.map((problem) => `${problem.path}: ${problem.message}`).join("; ")}`);
  if (invalidMetrics) failures.push("no positively weighted metrics in the selected universe");
  if (invalidMetricSelection) {
    failures.push("manifest selects duplicate or unknown metrics");
  }

  if (arm.error !== undefined) failures.push(`evaluation failed: ${arm.error}`);
  if (control.error !== undefined) failures.push(`control evaluation failed: ${control.error}`);
  if (arm.testsPassed === false) failures.push("checks failed");
  if (control.testsPassed === false) failures.push("control checks failed");
  if (arm.testsPassed === undefined && arm.error === undefined) pending.push("checks are still running");
  if (control.testsPassed === undefined && control.error === undefined) pending.push("control checks are still running");
  if (invalidJudge) failures.push("judge score must be finite and between 0 and 1");
  if (invalidChecks) failures.push("check results must be booleans or absent");
  const touched = arm.changedPaths.filter((path) => config.protectedPaths.some((glob) => matchesGlob(path, glob)));
  if (touched.length > 0) failures.push(`modified protected paths: ${touched.join(", ")}`);
  for (const metric of metrics) {
    const spec = specs.find((candidate) => candidate.id === metric.id);
    if (metric.error) failures.push(metric.error);
    else if (metric.needs && (metric.needs.arm > 0 || metric.needs.control > 0)) pending.push(metric.evidenceIssue ?? `${metric.id} needs more CI samples`);
    else if (metric.control === undefined || metric.arm === undefined) {
      if (arm.error === undefined && control.error === undefined) pending.push(`${metric.id} has not been measured`);
    } else if (spec?.maxRegression !== undefined && metric.delta < -spec.maxRegression) {
      failures.push(`${metric.id} regressed ${Math.round(-metric.delta * 100)}% (limit ${Math.round(spec.maxRegression * 100)}%)`);
    }
  }

  const status = (value: boolean | undefined): -1 | 0 | 1 => value === true ? 1 : value === false ? 0 : -1;
  const candidate: KernelCandidate = {
    metrics: metrics.map((metric, index) => {
      const limit = specs[index]?.maxRegression;
      return {
        delta: quantize(metric.delta),
        weight: quantize(metric.weight, WEIGHT_SCALE),
        measured: metric.control !== undefined && metric.arm !== undefined && !metric.error && !metric.needs,
        regressionLimit: limit === undefined ? -1 : finite(limit, 1) ? quantize(limit, OBJECTIVE_SCALE, BigNumber.ROUND_FLOOR) : -1,
      };
    }),
    tests: status(arm.testsPassed),
    controlTests: status(control.testsPassed),
    armError: arm.error !== undefined,
    controlError: control.error !== undefined,
    protectedPath: touched.length > 0,
    invalid: configProblems.length > 0 || invalidMetrics || invalidMetricSelection || invalidJudge || invalidChecks || metrics.some((metric) => metric.error !== undefined),
    judge: arm.judge && finite(arm.judge.score, 1) ? quantize(arm.judge.score) : -1,
  };
  const { minimum, influence } = selectionParameters(config);
  const result = evaluateCandidate(candidate, minimum, influence);
  if (result.failed && failures.length === 0) failures.push("formal eligibility gates failed");
  return {
    candidate,
    score: { arm: arm.arm, metrics, deterministic: result.deterministic / OBJECTIVE_SCALE, rank: result.rank / OBJECTIVE_SCALE, pending, failures, qualifies: result.eligible },
  };
}

export function scoreArm(manifest: ExperimentManifest, control: BranchMeasurement, arm: BranchMeasurement, config: HillClimbConfig): ArmScore {
  return evaluateArm(manifest, control, arm, config).score;
}
