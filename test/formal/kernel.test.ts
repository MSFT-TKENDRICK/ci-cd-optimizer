import { describe, expect, it } from "vitest";
import { resolveSeverity } from "../../src/formal/policy.js";
import { evaluateCandidate, quantize, reduceCandidates, type KernelCandidate, type KernelDecision, type KernelScore } from "../../src/formal/selection.js";
import type { Severity } from "../../src/lint/types.js";

const candidate = (delta = 1000, overrides: Partial<KernelCandidate> = {}): KernelCandidate => ({
  metrics: [{ delta, weight: 1, measured: true, regressionLimit: -1 }],
  tests: 1, controlTests: 1, armError: false, controlError: false, protectedPath: false, invalid: false, judge: -1, ...overrides,
});
const floor = (n: bigint, d: bigint) => n >= 0n ? n / d : -((-n + d - 1n) / d);
const rounded = (n: bigint, d: bigint) => Number(floor(2n * n + d, 2n * d));

// Independent BigInt oracle for the generated BigNumber implementation; not itself a formal proof.
function oracle(c: KernelCandidate, minimum: number, influence: number): KernelScore {
  const weights = c.metrics.reduce((sum, metric) => sum + BigInt(metric.weight), 0n);
  const valid = !c.invalid && minimum >= 0 && minimum <= 10000 && influence >= 0 && influence <= 5000 &&
    c.judge >= -1 && c.judge <= 10000 && c.metrics.length > 0 && weights > 0n &&
    c.metrics.every((metric) => metric.weight >= 0 && Math.abs(metric.delta) <= 10000 && metric.regressionLimit >= -1 && metric.regressionLimit <= 10000);
  const deterministic = valid ? rounded(c.metrics.reduce((sum, metric) => sum + BigInt(metric.weight) * BigInt(metric.delta), 0n), weights) : 0;
  const rank = valid && c.judge !== -1 ? rounded(BigInt(10000 - influence) * BigInt(deterministic) + BigInt(influence) * BigInt(2 * c.judge - 10000), 10000n) : deterministic;
  const failed = !valid || c.tests === 0 || c.controlTests === 0 || c.armError || c.controlError || c.protectedPath ||
    c.metrics.some((metric) => metric.measured && metric.regressionLimit >= 0 && metric.delta < -metric.regressionLimit);
  const pending = c.tests === -1 || c.controlTests === -1 || c.metrics.some((metric) => !metric.measured);
  return { deterministic, rank, failed, pending, eligible: !failed && !pending && deterministic >= minimum };
}

function reductionOracle(candidates: KernelCandidate[], minimum: number, influence: number, running: boolean, expired: boolean): KernelDecision {
  if (!running) return { action: "skip" };
  const outcomes = candidates.map((entry, index) => ({ index, score: oracle(entry, minimum, influence) }));
  const unfinished = outcomes.some(({ score }) => score.pending && !score.failed);
  const winner = outcomes.filter(({ score }) => score.eligible).sort((a, b) => b.score.rank - a.score.rank || b.score.deterministic - a.score.deterministic || a.index - b.index)[0];
  if (winner && (!unfinished || expired)) return { action: "promote", index: winner.index };
  return { action: expired ? "expire" : unfinished ? "wait" : "reject" };
}

describe("compiled Dafny integer objective and reducer", () => {
  it("matches an independent exact-integer oracle across rounding, large weights and numeric limits", () => {
    let seed = 39117;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let i = 0; i < 1200; i += 1) {
      const input = candidate(0, {
        metrics: Array.from({ length: 1 + next() % 6 }, () => ({
          delta: (next() % 20001) - 10000, weight: next() % 2 ? 1 + next() % 1000000 : 1_000_000_000_000,
          measured: true, regressionLimit: -1,
        })),
        judge: next() % 3 ? next() % 10001 : -1,
      });
      const minimum = next() % 10001;
      const influence = next() % 5001;
      expect(evaluateCandidate(input, minimum, influence)).toEqual(oracle(input, minimum, influence));
    }
    for (const delta of [-1, 1]) {
      const input = candidate(0, { metrics: [{ delta, weight: 1, measured: true, regressionLimit: -1 }, { delta: 0, weight: 1, measured: true, regressionLimit: -1 }] });
      expect(evaluateCandidate(input, 0, 0).deterministic).toBe(delta === 1 ? 1 : 0);
    }
  });

  it("exhausts short candidate universes, pending/failed gates, state and expiry", () => {
    const pool = [
      candidate(0), candidate(300), candidate(900), candidate(900, { judge: 0 }), candidate(900, { judge: 10000 }),
      candidate(10000, { tests: -1 }), candidate(10000, { tests: 0 }), candidate(10000, { protectedPath: true }),
    ];
    const sequences: KernelCandidate[][] = [[]];
    for (const a of pool) {
      sequences.push([a]);
      for (const b of pool) {
        sequences.push([a, b]);
        for (const c of pool) sequences.push([a, b, c]);
      }
    }
    for (const entries of sequences) for (const running of [true, false]) for (const expired of [true, false]) {
      expect(reduceCandidates(entries, 200, 2000, running, expired)).toEqual(reductionOracle(entries, 200, 2000, running, expired));
    }
  });

  it("preserves every hard gate for every valid judge value tested", () => {
    const bad = [
      candidate(10000, { tests: 0 }), candidate(10000, { controlTests: 0 }), candidate(10000, { tests: -1 }),
      candidate(10000, { controlTests: -1 }), candidate(10000, { armError: true }), candidate(10000, { controlError: true }),
      candidate(10000, { protectedPath: true }), candidate(10000, { invalid: true }), candidate(0),
      candidate(0, { metrics: [] }),
      candidate(0, { metrics: [{ delta: 10000, weight: 0, measured: true, regressionLimit: -1 }] }),
      candidate(0, { metrics: [{ delta: 10000, weight: 1, measured: false, regressionLimit: -1 }] }),
      candidate(0, { metrics: [{ delta: -201, weight: 1, measured: true, regressionLimit: 200 }] }),
    ];
    for (const input of bad) for (const judge of [-1, 0, 1, 4999, 5000, 5001, 9999, 10000]) {
      expect(evaluateCandidate({ ...input, judge }, 200, 5000).eligible).toBe(false);
    }
    expect(reduceCandidates([candidate(1000), candidate(1000)], 200, 0, true, false)).toEqual({ action: "promote", index: 0 });
    expect(reduceCandidates([], 0, 0, true, false)).toEqual({ action: "reject" });
    expect(reduceCandidates([], 0, 0, true, true)).toEqual({ action: "expire" });
  });

  it("fails closed at the JavaScript/integer boundary", () => {
    for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 0.1]) expect(() => evaluateCandidate(candidate(value), 0, 0)).toThrow();
    expect(() => reduceCandidates(Array.from({ length: 65 }, () => candidate()), 0, 0, true, false)).toThrow(/64/);
    expect(() => evaluateCandidate(candidate(0, { metrics: Array.from({ length: 129 }, () => ({ delta: 0, weight: 1, measured: true, regressionLimit: -1 })) }), 0, 0)).toThrow(/128/);
    expect(() => evaluateCandidate(JSON.parse(JSON.stringify(candidate()).replace('"protectedPath":false', '"protectedPath":"false"')), 0, 0)).toThrow(/booleans/);
    for (const judge of [-2, 10001]) expect(evaluateCandidate(candidate(10000, { judge }), 0, 0).eligible).toBe(false);
    expect(evaluateCandidate(candidate(10000), 0, 5001).eligible).toBe(false);
    expect(quantize(-0.00001)).toBe(0);
    expect(quantize(0.00005)).toBe(1);
    expect(quantize(-0.00005)).toBe(0);
  });
});

describe("compiled policy precedence", () => {
  it("exhausts assignment sequences through four layers", () => {
    const assignments: Array<Severity | undefined> = [undefined, "off", "info", "warn", "error"];
    const check = (entries: Array<Severity | undefined>) => expect(resolveSeverity(entries)).toBe(entries.filter((entry) => entry !== undefined).at(-1) ?? "off");
    check([]);
    for (const a of assignments) for (const b of assignments) for (const c of assignments) for (const d of assignments) {
      check([a]); check([a, b]); check([a, b, c]); check([a, b, c, d]);
    }
  });
});
