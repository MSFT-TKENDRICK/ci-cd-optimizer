/** Small, dependency-free robust statistics used for CI duration anomaly detection. */

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Median absolute deviation (unscaled). */
export function mad(values: readonly number[], center = median(values)): number {
  return median(values.map((value) => Math.abs(value - center)));
}

/**
 * Iglewicz & Hoaglin modified z-score: 0.6745 * (x - median) / MAD. Values above 3.5 are conventionally outliers
 * (NIST/SEMATECH e-Handbook 1.3.5.17). `madFloor` prevents division by ~0 for very stable series.
 */
export function robustZ(value: number, center: number, deviation: number, madFloor = 0): number {
  const scale = Math.max(deviation, madFloor);
  if (scale === 0) return value === center ? 0 : Number.POSITIVE_INFINITY * Math.sign(value - center);
  return (0.6745 * (value - center)) / scale;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

function ranks(values: readonly number[]): { ranks: number[]; tieTerm: number } {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length).fill(0);
  let tieTerm = 0;
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]?.value === order[start]?.value) end += 1;
    const average = (start + end + 2) / 2;
    for (let position = start; position <= end; position += 1) result[order[position]?.index ?? 0] = average;
    const size = end - start + 1;
    tieTerm += size ** 3 - size;
    start = end + 1;
  }
  return { ranks: result, tieTerm };
}

/** Exact upper-tail probability P(U >= u) under H0 for sample sizes m, n (no ties). */
function exactUpperTail(m: number, n: number, u: number): number {
  // Rolling table: previous[j][k] = arrangements of (i-1) sample and j reference values with U = k.
  const maxU = m * n;
  let previous: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(maxU + 1).fill(0));
  for (let j = 0; j <= n; j += 1) (previous[j] as number[])[0] = 1;
  for (let i = 1; i <= m; i += 1) {
    const current: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(maxU + 1).fill(0));
    (current[0] as number[])[0] = 1;
    for (let j = 1; j <= n; j += 1) {
      const row = current[j] as number[];
      const left = current[j - 1] as number[];
      const up = previous[j] as number[];
      for (let k = 0; k <= i * j; k += 1) row[k] = (left[k] ?? 0) + (k - j >= 0 ? (up[k - j] ?? 0) : 0);
    }
    previous = current;
  }
  const distribution = previous[n] as number[];
  const total = distribution.reduce((sum, count) => sum + count, 0);
  let tail = 0;
  for (let k = Math.ceil(u); k <= maxU; k += 1) tail += distribution[k] ?? 0;
  return tail / total;
}

export interface MannWhitneyResult {
  u: number;
  /** One-sided p-value for H1: `sample` is stochastically greater than `reference`. */
  pValue: number;
  method: "exact" | "normal";
}

/** One-sided Mann-Whitney U test. Exact for small tie-free samples, else normal approximation with tie and continuity correction. */
export function mannWhitneyGreater(sample: readonly number[], reference: readonly number[]): MannWhitneyResult {
  const m = sample.length;
  const n = reference.length;
  if (m === 0 || n === 0) return { u: 0, pValue: 1, method: "normal" };
  const { ranks: combined, tieTerm } = ranks([...sample, ...reference]);
  const rankSum = combined.slice(0, m).reduce((sum, rank) => sum + rank, 0);
  const u = rankSum - (m * (m + 1)) / 2;
  if (tieTerm === 0 && m * n <= 2500) return { u, pValue: exactUpperTail(m, n, u), method: "exact" };
  const total = m + n;
  const variance = ((m * n) / 12) * (total + 1 - tieTerm / (total * (total - 1)));
  if (variance <= 0) return { u, pValue: 1, method: "normal" };
  const z = (u - (m * n) / 2 - 0.5) / Math.sqrt(variance);
  return { u, pValue: 1 - normalCdf(z), method: "normal" };
}
