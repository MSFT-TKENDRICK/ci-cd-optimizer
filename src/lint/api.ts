import { DEFAULT_CONFIG, parseConfigText, resolveRules, validateConfig, type LintConfig } from "./config.js";
import { exceedsThreshold, lint as runLint } from "./engine.js";
import { applyFixes } from "./fix.js";
import { allRules } from "./rules/index.js";
import type { AnalysisInput, LintResult, Preset } from "./types.js";

/**
 * Stable entry point. The experiment evaluator on `main` dynamically imports this module from an experiment
 * arm's build, so its shape must only change together with ENGINE_API_VERSION.
 */
export const ENGINE_API_VERSION = 1;

export interface LintRequest {
  input: AnalysisInput;
  config?: LintConfig;
  presets?: Preset[];
  baseFingerprints?: ReadonlySet<string>;
}

export function lint(request: LintRequest): LintResult {
  return runLint(request.input, {
    config: request.config ?? structuredClone(DEFAULT_CONFIG),
    rules: allRules,
    ...(request.presets ? { presets: request.presets } : {}),
    ...(request.baseFingerprints ? { baseFingerprints: request.baseFingerprints } : {}),
  });
}

export { allRules, applyFixes, DEFAULT_CONFIG, exceedsThreshold, parseConfigText, resolveRules, validateConfig };
export type { LintConfig };
export type * from "./types.js";
