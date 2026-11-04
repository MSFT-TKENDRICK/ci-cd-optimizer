import { mannWhitneyGreater, median } from "../alerts/stats.js";
import { matchesGlob } from "../utils.js";
import type { HillClimbConfig, MetricSpec } from "./config.js";
import type { CorpusMetrics } from "./corpus.js";
import type { ExperimentManifest } from "./manifest.js";

/** Everything the grader measured for one branch (an arm or the trunk control). */
export interface BranchMeasurement {
  arm: string;
  headSha?: string;
  pullRequest?: number;
  /** `rules` experiments: benchmark metrics of this branch's engine build. */
  corpus?: CorpusMetrics;
  /** `pipeline` experiments: metric id -> samples (seconds) from successful runs on this branch. */
  ci?: Record<string, number[]>;
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
const round = (value: number) => Math.round(value * 10_000) / 10_000;

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

function compare(spec: MetricSpec, control: BranchMeasurement, arm: BranchMeasurement, config: HillClimbConfig): MetricComparison {
  const base: MetricComparison = { id: spec.id, weight: spec.weight, direction: spec.direction, delta: 0 };
  if (spec.source === "corpus") {
    const c = control.corpus?.[spec.id as keyof CorpusMetrics];
    const a = arm.corpus?.[spec.id as keyof CorpusMetrics];
    if (c === undefined || a === undefined) return base;
    return { ...base, control: c, arm: a, delta: round(relativeDelta(spec, c, a)) };
  }
  const cSamples = control.ci?.[spec.id] ?? [];
  const aSamples = arm.ci?.[spec.id] ?? [];
  const minSamples = config.selection.minSamples;
  if (cSamples.length < minSamples || aSamples.length < minSamples) {
    return { ...base, needs: { control: Math.max(0, minSamples - cSamples.length), arm: Math.max(0, minSamples - aSamples.length) } };
  }
  const c = median(cSamples);
  const a = median(aSamples);
  const delta = relativeDelta(spec, c, a);
  // One-sided test in the direction of the observed change; noise is scored as no change.
  const better = delta > 0;
  const [high, low] = (spec.direction === "minimize") === better ? [cSamples, aSamples] : [aSamples, cSamples];
  const pValue = mannWhitneyGreater(high, low).pValue;
  const significant = delta !== 0 && pValue < config.selection.pValue;
  return { ...base, control: c, arm: a, pValue: round(pValue), delta: significant ? round(delta) : 0 };
}

export function scoreArm(
  manifest: ExperimentManifest,
  control: BranchMeasurement,
  arm: BranchMeasurement,
  config: HillClimbConfig,
): ArmScore {
  const specs = metricsFor(manifest, config);
  const metrics = specs.map((spec) => compare(spec, control, arm, config));
  const pending: string[] = [];
  const failures: string[] = [];

  if (arm.error) failures.push(`evaluation failed: ${arm.error}`);
  if (control.error) failures.push(`control evaluation failed: ${control.error}`);
  if (arm.testsPassed === false) failures.push("checks failed");
  if (arm.testsPassed === undefined && !arm.error) pending.push("checks are still running");
  const touched = arm.changedPaths.filter((path) => config.protectedPaths.some((glob) => matchesGlob(path, glob)));
  if (touched.length > 0) failures.push(`modified protected paths: ${touched.join(", ")}`);
  for (const metric of metrics) {
    const spec = specs.find((candidate) => candidate.id === metric.id);
    if (metric.needs && (metric.needs.arm > 0 || metric.needs.control > 0)) pending.push(`${metric.id} needs more CI samples`);
    else if (metric.control === undefined || metric.arm === undefined) {
      if (!arm.error && !control.error) pending.push(`${metric.id} has not been measured`);
    } else if (spec?.maxRegression !== undefined && metric.delta < -spec.maxRegression) {
      failures.push(`${metric.id} regressed ${Math.round(-metric.delta * 100)}% (limit ${Math.round(spec.maxRegression * 100)}%)`);
    }
  }

  const totalWeight = metrics.reduce((sum, metric) => sum + metric.weight, 0) || 1;
  const deterministic = round(metrics.reduce((sum, metric) => sum + metric.weight * metric.delta, 0) / totalWeight);
  const cap = Math.max(0, Math.min(0.5, config.selection.judgeWeight));
  const judge = arm.judge ? Math.max(0, Math.min(1, arm.judge.score)) : undefined;
  const rank = round(judge === undefined ? deterministic : (1 - cap) * deterministic + cap * (2 * judge - 1));
  return {
    arm: arm.arm,
    metrics,
    deterministic,
    rank,
    pending,
    failures,
    qualifies: failures.length === 0 && pending.length === 0 && deterministic >= config.selection.minImprovement,
  };
}
