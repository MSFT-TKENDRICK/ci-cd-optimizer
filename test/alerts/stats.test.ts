import { describe, expect, it } from "vitest";
import { mad, mannWhitneyGreater, median, normalCdf, robustZ } from "../../src/alerts/stats.js";

function binomial(n: number, k: number): number {
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i;
  return result;
}

describe("robust statistics", () => {
  it("computes median and MAD", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
  });

  it("computes the Iglewicz-Hoaglin modified z-score with a MAD floor", () => {
    expect(robustZ(110, 100, 2)).toBeCloseTo(3.3725, 4);
    expect(robustZ(110, 100, 0, 5)).toBeCloseTo(1.349, 3);
    expect(robustZ(100, 100, 0)).toBe(0);
    expect(robustZ(101, 100, 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("approximates the standard normal CDF", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.645)).toBeCloseTo(0.05, 3);
  });
});

describe("mannWhitneyGreater", () => {
  it("returns the exact tail probability for complete separation", () => {
    const reference = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const sample = [30, 31, 32, 33, 34];
    const result = mannWhitneyGreater(sample, reference);
    expect(result.method).toBe("exact");
    expect(result.u).toBe(50);
    expect(result.pValue).toBeCloseTo(1 / binomial(15, 5), 12);
  });

  it("matches a hand-computed exact distribution", () => {
    // m=2, n=2: U distribution over C(4,2)=6 arrangements is {0:1, 1:1, 2:2, 3:1, 4:1}; U=3 → P(U>=3)=2/6.
    const result = mannWhitneyGreater([3, 5], [1, 4]);
    expect(result.u).toBe(3);
    expect(result.pValue).toBeCloseTo(2 / 6, 12);
  });

  it("is not significant when the sample is slower only by chance", () => {
    const result = mannWhitneyGreater([12, 15, 17], [10, 11, 13, 14, 16, 18]);
    expect(result.pValue).toBeGreaterThan(0.1);
  });

  it("falls back to the normal approximation with ties", () => {
    const result = mannWhitneyGreater([20, 20, 21, 22, 22], [10, 10, 11, 12, 12, 13, 14, 15, 15, 16]);
    expect(result.method).toBe("normal");
    expect(result.pValue).toBeLessThan(0.01);
  });

  it("handles empty and identical samples", () => {
    expect(mannWhitneyGreater([], [1, 2]).pValue).toBe(1);
    expect(mannWhitneyGreater([5, 5], [5, 5, 5]).pValue).toBe(1);
  });
});
