import { DEFAULT_CONFIG, type LintConfig } from "../../src/lint/config.js";
import type { AnalysisInput, AnyRule, Preset, ReportDescriptor, RuleMeta } from "../../src/lint/types.js";

export const WORKFLOW = ".github/workflows/ci.yml";

/** A synthetic rule; `check` receives the report function and the input. */
export function makeRule(
  id: string,
  check: (report: (descriptor: ReportDescriptor) => void, input: AnalysisInput) => void = () => undefined,
  meta: Partial<RuleMeta<Record<string, unknown>>> = {},
): AnyRule {
  return {
    meta: {
      id,
      ruleset: id.split("/")[0] ?? id,
      description: `${id} description`,
      rationale: `${id} rationale`,
      kind: "practice",
      defaultSeverity: "warn",
      presets: ["recommended"] as Preset[],
      requires: [],
      defaultOptions: {},
      references: ["https://example.com/ref"],
      impact: "medium",
      ...meta,
    },
    check: ({ report, input }) => check(report, input),
  };
}

export function config(overrides: Partial<LintConfig> = {}): LintConfig {
  return { ...structuredClone(DEFAULT_CONFIG), ignorePaths: [], ...overrides };
}

export function input(files: Record<string, string>, extra: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    mode: "repository",
    inventoryComplete: true,
    ...extra,
  };
}
