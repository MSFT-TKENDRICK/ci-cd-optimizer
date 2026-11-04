import { parse } from "yaml";
import { compatibility, type Compatibility, type Outcome } from "./compat.js";

/** A wave size: an absolute number of repositories, or a percentage of applicable repositories such as "25%". */
export type WaveSize = number | `${number}%`;

export interface RolloutConfig {
  /** Cumulative wave sizes; the rollout only widens after the previous wave proved compatible. */
  waves: WaveSize[];
  /** Resolved outcomes needed before the compatibility rate gates the rollout (fewer: any failure halts). */
  minSamples: number;
  /** Minimum Wilson lower bound of the CI pass rate required to start the next wave. */
  minCompatibility: number;
}

export const DEFAULT_ROLLOUT: RolloutConfig = { waves: [1, 3, "25%", "100%"], minSamples: 5, minCompatibility: 0.7 };

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

export interface RolloutTargets {
  repositories: string[];
  canaries: string[];
  config: RolloutConfig;
  problems: string[];
}

/**
 * Parses a rollout targets file:
 *
 * ```yaml
 * repositories: [octo/api, octo/web]
 * canaries: [octo/api]          # optional; applied first
 * rollout:                      # optional; defaults shown
 *   waves: [1, 3, "25%", "100%"]
 *   minSamples: 5
 *   minCompatibility: 0.7
 * ```
 */
export function parseRolloutTargets(text: string): RolloutTargets {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    return { repositories: [], canaries: [], config: DEFAULT_ROLLOUT, problems: [`Invalid YAML: ${(error as Error).message}`] };
  }
  const root = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const names = (key: string): string[] => {
    const value = root[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      problems.push(`${key} must be a list of owner/name repositories.`);
      return [];
    }
    const valid = value.filter((item): item is string => typeof item === "string" && REPO_NAME.test(item));
    if (valid.length !== value.length) problems.push(`${key} must only contain owner/name repositories.`);
    return [...new Set(valid)];
  };
  const repositories = names("repositories");
  const canaries = names("canaries");
  if (repositories.length === 0 && problems.length === 0) problems.push("repositories must list at least one owner/name repository.");
  for (const canary of canaries) if (!repositories.includes(canary)) problems.push(`canary ${canary} is not in repositories.`);
  const rollout = (typeof root.rollout === "object" && root.rollout !== null ? root.rollout : {}) as Record<string, unknown>;
  const config: RolloutConfig = { ...DEFAULT_ROLLOUT, waves: [...DEFAULT_ROLLOUT.waves] };
  if (rollout.waves !== undefined) {
    const waves = Array.isArray(rollout.waves) ? rollout.waves.map(parseWaveSize) : [undefined];
    if (waves.length === 0 || waves.some((wave) => wave === undefined)) problems.push('rollout.waves must be a non-empty list of positive integers or percentages such as "25%".');
    else config.waves = waves as WaveSize[];
  }
  if (rollout.minSamples !== undefined) {
    if (typeof rollout.minSamples === "number" && Number.isInteger(rollout.minSamples) && rollout.minSamples >= 1) config.minSamples = rollout.minSamples;
    else problems.push("rollout.minSamples must be a positive integer.");
  }
  if (rollout.minCompatibility !== undefined) {
    if (typeof rollout.minCompatibility === "number" && rollout.minCompatibility >= 0 && rollout.minCompatibility <= 1) config.minCompatibility = rollout.minCompatibility;
    else problems.push("rollout.minCompatibility must be a number between 0 and 1.");
  }
  return { repositories, canaries, config, problems };
}

/** 32-bit FNV-1a; gives every recipe its own stable but different repository order. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Canaries first (in the given order), then a deterministic pseudo-random order seeded by the recipe id. */
export function rolloutOrder(id: string, repositories: readonly string[], canaries: readonly string[] = []): string[] {
  const unique = [...new Set(repositories)];
  const first = canaries.filter((repo, index) => unique.includes(repo) && canaries.indexOf(repo) === index);
  const rest = unique
    .filter((repo) => !first.includes(repo))
    .sort((a, b) => fnv1a(`${id}:${a}`) - fnv1a(`${id}:${b}`) || a.localeCompare(b));
  return [...first, ...rest];
}

export function parseWaveSize(value: unknown): WaveSize | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === "string" && /^\d+(\.\d+)?%$/.test(value)) {
    const percent = Number(value.slice(0, -1));
    if (percent > 0 && percent <= 100) return value as `${number}%`;
  }
  return undefined;
}

/** Cumulative, non-decreasing repository counts per wave; the last wave always covers everything. */
export function waveSizes(waves: readonly WaveSize[], total: number): number[] {
  const sizes: number[] = [];
  let previous = 0;
  for (const wave of waves) {
    const size = typeof wave === "number" ? wave : Math.ceil((Number(wave.slice(0, -1)) / 100) * total);
    previous = Math.min(total, Math.max(previous, size));
    sizes.push(previous);
  }
  if (sizes.length === 0 || (sizes[sizes.length - 1] as number) < total) sizes.push(total);
  return sizes;
}

/** `untouched`: no pull request or issue yet; `not-applicable`: the recipe does not apply or the target opted out. */
export type TargetState = "untouched" | "not-applicable" | Outcome;

export interface TargetStatus {
  repo: string;
  state: TargetState;
  /** Pull request or issue number in the target, when one exists. */
  number?: number;
  url?: string;
}

export interface RolloutPlan {
  action: "advance" | "wait" | "halt" | "complete";
  reason: string;
  /** 0-based wave being filled (advance) or last wave reached. */
  wave: number;
  /** How many more applicable repositories to open changes in (advance only). */
  slots: number;
  /** Untouched repositories in rollout order; apply them in this order, skipping ones that turn out not applicable. */
  candidates: string[];
  order: string[];
  counts: Record<TargetState, number>;
  compatibility: Compatibility;
}

export function planRollout(options: { id: string; targets: readonly TargetStatus[]; config?: RolloutConfig; canaries?: readonly string[] }): RolloutPlan {
  const config = options.config ?? DEFAULT_ROLLOUT;
  const counts: Record<TargetState, number> = { untouched: 0, "not-applicable": 0, passed: 0, failed: 0, pending: 0, unknown: 0 };
  const state = new Map<string, TargetState>();
  for (const target of options.targets) {
    state.set(target.repo, target.state);
    counts[target.state] += 1;
  }
  const order = rolloutOrder(
    options.id,
    options.targets.filter((target) => target.state !== "not-applicable").map((target) => target.repo),
    options.canaries,
  );
  const candidates = order.filter((repo) => state.get(repo) === "untouched");
  const attempted = order.length - candidates.length;
  const compat = compatibility({ passed: counts.passed, failed: counts.failed }, config.minSamples);
  const sizes = waveSizes(config.waves, order.length);
  const reached = Math.max(0, sizes.findIndex((size) => size >= attempted));
  const base = { order, counts, compatibility: compat, candidates, slots: 0, wave: reached };

  if (order.length === 0) return { ...base, action: "complete", reason: "No applicable repositories." };
  if (candidates.length === 0) return { ...base, action: "complete", reason: `Applied to all ${order.length} applicable repositories.` };
  if (counts.pending > 0) return { ...base, action: "wait", reason: `${counts.pending} change(s) still running CI or awaiting review.` };
  const resolved = counts.passed + counts.failed;
  if (attempted > 0 && resolved === 0) {
    return { ...base, action: "halt", reason: "Changes were opened but produced no CI evidence (no check runs); add CI to the targets or review manually." };
  }
  if (resolved < config.minSamples) {
    if (counts.failed > 0) return { ...base, action: "halt", reason: `${counts.failed} of ${resolved} change(s) failed before the minimum of ${config.minSamples} samples.` };
  } else if (compat.lowerBound < config.minCompatibility) {
    return {
      ...base,
      action: "halt",
      reason: `Compatibility lower bound ${Math.round(compat.lowerBound * 100)}% is below the required ${Math.round(config.minCompatibility * 100)}%.`,
    };
  }
  const wave = sizes.findIndex((size) => size > attempted);
  const slots = (sizes[wave] as number) - attempted;
  return { ...base, action: "advance", wave, slots, reason: `Opening wave ${wave + 1} of ${sizes.length}: ${slots} more repositor${slots === 1 ? "y" : "ies"}.` };
}
