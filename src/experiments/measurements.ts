import { exactKeys, integer, object, parseStrictJson, string, type Json } from "../formal/json.js";
import { decodeCiEvidence } from "./ci-evidence.js";
import type { BranchMeasurement, ExperimentMeasurements } from "./score.js";

function number(value: Json | undefined, label: string, maximum = 1_000_000_000_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) throw new Error(`${label} must be a finite number in [0, ${maximum}].`);
  return value;
}

function strings(value: Json | undefined, label: string, maximum = 10_000): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be an array of at most ${maximum} strings.`);
  return value.map((entry) => string(entry, label));
}

function boolean(value: Json | undefined, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function branch(value: Json | undefined): BranchMeasurement {
  const record = object(value, "measurement");
  exactKeys(record, ["arm", "headSha", "pullRequest", "corpus", "ci", "ciEvidence", "testsPassed", "changedPaths", "judge", "error"], "measurement");
  const result: BranchMeasurement = { arm: string(record.arm, "measurement.arm"), changedPaths: strings(record.changedPaths, "measurement.changedPaths") };
  if (record.headSha !== undefined) result.headSha = string(record.headSha, "measurement.headSha");
  if (record.pullRequest !== undefined) result.pullRequest = integer(record.pullRequest, "measurement.pullRequest", 1);
  if (record.testsPassed !== undefined) result.testsPassed = boolean(record.testsPassed, "measurement.testsPassed");
  if (record.error !== undefined) result.error = string(record.error, "measurement.error");
  if (record.judge !== undefined) {
    const judge = object(record.judge, "judge");
    exactKeys(judge, ["score", "rationale"], "judge");
    result.judge = { score: number(judge.score, "judge.score", 1), rationale: string(judge.rationale, "judge.rationale") };
  }
  if (record.corpus !== undefined) {
    const corpus = object(record.corpus, "corpus");
    exactKeys(corpus, ["precision", "recall", "f1", "fixRate", "durationMs"], "corpus");
    result.corpus = {
      precision: number(corpus.precision, "corpus.precision", 1), recall: number(corpus.recall, "corpus.recall", 1),
      f1: number(corpus.f1, "corpus.f1", 1), fixRate: number(corpus.fixRate, "corpus.fixRate", 1),
      durationMs: number(corpus.durationMs, "corpus.durationMs"),
    };
  }
  if (record.ci !== undefined) {
    const ci = object(record.ci, "ci");
    if (Object.keys(ci).length > 128) throw new Error("At most 128 CI metric series.");
    result.ci = Object.fromEntries(Object.entries(ci).map(([id, samples]) => {
      if (!Array.isArray(samples) || samples.length > 10_000) throw new Error(`ci.${id} must have at most 10000 samples.`);
      return [id, samples.map((sample) => number(sample, `ci.${id}`))];
    }));
  }
  if (record.ciEvidence !== undefined) result.ciEvidence = decodeCiEvidence(record.ciEvidence);
  return result;
}

/** Untrusted JSON is decoded, never cast to evidence or allowed to supply eligibility/optimality assertions. */
export function parseMeasurements(text: string): ExperimentMeasurements {
  const record = object(parseStrictJson(text, true), "measurements");
  exactKeys(record, ["experiment", "collectedAt", "needsCorpus", "control", "arms"], "measurements");
  if (!Array.isArray(record.arms) || record.arms.length > 256) throw new Error("measurements.arms must have at most 256 records.");
  const result: ExperimentMeasurements = {
    experiment: string(record.experiment, "experiment"), collectedAt: string(record.collectedAt, "collectedAt"),
    control: branch(record.control), arms: record.arms.map(branch),
  };
  if (!Number.isFinite(Date.parse(result.collectedAt))) throw new Error("Invalid collection timestamp.");
  if (record.needsCorpus !== undefined) result.needsCorpus = boolean(record.needsCorpus, "needsCorpus");
  return result;
}
