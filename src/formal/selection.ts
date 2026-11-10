import { BigNumber } from "bignumber.js";
import { Dafny, Selection } from "./generated/kernel.js";

export const OBJECTIVE_SCALE = 10_000;
export const WEIGHT_SCALE = 1_000_000;

export interface KernelMetric {
  delta: number;
  weight: number;
  measured: boolean;
  regressionLimit: number;
}

export interface KernelCandidate {
  metrics: KernelMetric[];
  tests: -1 | 0 | 1;
  controlTests: -1 | 0 | 1;
  armError: boolean;
  controlError: boolean;
  protectedPath: boolean;
  invalid: boolean;
  /** -1 means no judge; other values use OBJECTIVE_SCALE. */
  judge: number;
}

export interface KernelScore {
  deterministic: number;
  rank: number;
  failed: boolean;
  pending: boolean;
  eligible: boolean;
}

export type KernelDecision =
  | { action: "skip" | "wait" | "reject" | "expire" }
  | { action: "promote"; index: number };

function integer(value: number): BigNumber {
  if (!Number.isSafeInteger(value)) throw new Error("Formal kernel inputs must be safe integers.");
  return new BigNumber(value);
}

/** Decimal input quantization is explicit; the generated objective then uses unbounded integer arithmetic. */
export function quantize(value: number, scale = OBJECTIVE_SCALE, rounding: BigNumber.RoundingMode = BigNumber.ROUND_HALF_CEIL): number {
  if (!Number.isFinite(value)) throw new Error("Cannot quantize a non-finite value.");
  if (!Number.isSafeInteger(scale) || scale <= 0) throw new Error("Quantization scale must be a positive safe integer.");
  const result = new BigNumber(value).times(scale).integerValue(rounding).toNumber();
  if (!Number.isSafeInteger(result)) throw new Error("Quantized value exceeds the adapter's safe-integer bound.");
  return result === 0 ? 0 : result;
}

function encode(candidate: KernelCandidate) {
  if (candidate.metrics.length > 128) throw new Error("At most 128 metrics per candidate.");
  if ([candidate.armError, candidate.controlError, candidate.protectedPath, candidate.invalid, ...candidate.metrics.map((metric) => metric.measured)]
    .some((value) => typeof value !== "boolean")) throw new Error("Formal kernel flags must be booleans.");
  return Selection.Candidate.create_Candidate(
    Dafny.Seq.of(...candidate.metrics.map((metric) => Selection.Metric.create_Metric(
      integer(metric.delta), integer(metric.weight), metric.measured, integer(metric.regressionLimit),
    ))),
    integer(candidate.tests), integer(candidate.controlTests), candidate.armError, candidate.controlError,
    candidate.protectedPath, candidate.invalid, integer(candidate.judge),
  );
}

export function evaluateCandidate(candidate: KernelCandidate, minimum: number, influence: number): KernelScore {
  const score = Selection.__default.Evaluate(encode(candidate), integer(minimum), integer(influence));
  return {
    deterministic: score.dtor_deterministic.toNumber(),
    rank: score.dtor_rank.toNumber(),
    failed: score.dtor_failed,
    pending: score.dtor_pending,
    eligible: score.dtor_eligible,
  };
}

/** Callers supply the complete manifest universe in ascending unique ASCII-name order. */
export function reduceCandidates(candidates: KernelCandidate[], minimum: number, influence: number, running: boolean, expired: boolean): KernelDecision {
  if (candidates.length > 64) throw new Error("At most 64 candidates in the declared finite universe.");
  if (typeof running !== "boolean" || typeof expired !== "boolean") throw new Error("Reducer state flags must be booleans.");
  const result = Selection.__default.Reduce(
    Dafny.Seq.of(...candidates.map(encode)), integer(minimum), integer(influence), running, expired,
  );
  if (result.is_Promote) {
    const index: number = result.dtor_index.toNumber();
    if (!Number.isSafeInteger(index) || index < 0 || index >= candidates.length) throw new Error("Generated winner is outside the candidate universe.");
    return { action: "promote", index };
  }
  if (result.is_Skip) return { action: "skip" };
  if (result.is_Wait) return { action: "wait" };
  if (result.is_Reject) return { action: "reject" };
  if (result.is_Expire) return { action: "expire" };
  throw new Error("Unexpected generated reducer result.");
}
