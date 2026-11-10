import { parse as parseYamlText } from "yaml";
import { resolveSeverity } from "../formal/policy.js";
import { durationPolicyProblems, type DurationsConfig } from "../knowledge/duration-policy.js";
import type { ActiveSeverity, AnyRule, Impact, Preset, ResolvedRule, Severity } from "./types.js";

export const CONFIG_PATHS = [".github/ci-cd-optimizer.yml", ".github/ci-cd-optimizer.yaml"];
export const PRESETS: Preset[] = ["recommended", "strict", "agentic", "github", "insights", "all"];
const SEVERITIES: Severity[] = ["off", "info", "warn", "error"];
const IMPACTS: Impact[] = ["low", "medium", "high"];

/** v0.1 rule ids mapped to their v0.2 replacements. */
export const DEPRECATED_RULE_IDS: Record<string, string> = {
  "github-npm-registry": "registries/github-npm",
  "docker-build-cache": "caching/docker-layer-cache",
  "docker-dependency-layer": "containers/dependency-layer",
  "docker-multistage": "containers/multi-stage",
  "ghcr-output": "registries/ghcr",
  "workflow-concurrency": "workflow/concurrency",
  "workflow-timeout": "workflow/job-timeout",
  "dependency-cache": "caching/setup-cache",
  "immutable-dependency-install": "hermeticity/frozen-lockfile",
  "artifact-retention": "workflow/artifact-retention",
  "path-filtering": "affected/change-detection",
};

export type RuleSetting = Severity | [Severity, Record<string, unknown>];

export interface CopilotAssignment {
  baseBranch?: string;
  customInstructions?: string;
  customAgent?: string;
  model?: string;
}

export interface IssuesConfig {
  enabled: boolean;
  minSeverity: ActiveSeverity;
  minImpact: Impact;
  /** `rule` opens one issue per rule (a coherent unit of work); `finding` one per diagnostic. */
  groupBy: "rule" | "finding";
  labels: string[];
  assignees: string[];
  assignCopilot: boolean;
  copilot: CopilotAssignment;
  maxOpen: number;
  closeResolved: boolean;
  /** Rules that always (true) or never (false) open issues regardless of severity. */
  rules: Record<string, boolean>;
}

export interface FixGroup {
  rulesets?: string[];
  rules?: string[];
}

export interface FixesConfig {
  enabled: boolean;
  openPullRequestsLimit: number;
  /** Named groups; ungrouped fixable rules get one pull request per ruleset. */
  groups: Record<string, FixGroup>;
  ignore: Array<{ rule: string; paths?: string[] }>;
  labels: string[];
  reviewers: string[];
  branchPrefix: string;
  draft: boolean;
}

export interface AlertsConfig {
  enabled: boolean;
  minSamples: number;
  window: number;
  zThreshold: number;
  minIncreasePercent: number;
  minIncreaseSeconds: number;
  regressionWindow: number;
  pValue: number;
  recoveryRuns: number;
  /** After an alert issue is closed as "not planned", suppress new alerts for that series for this many days. */
  snoozeDays: number;
  branches: string[];
  labels: string[];
  assignees: string[];
  assignCopilot: boolean;
}

export type RecipeRisk = "low" | "medium" | "high";
export const RECIPE_RISKS: RecipeRisk[] = ["low", "medium", "high"];

/** Target-side preferences for recipes rolled out from promoted experiments (like a per-repo dependabot.yml). */
export interface RecipesConfig {
  enabled: boolean;
  /** Highest risk accepted: low (workflow-only), medium (containers, caches), high (packages, lockfiles, many files). */
  maxRisk: RecipeRisk;
  /** Recipe ids never applied here. */
  ignore: string[];
  labels: string[];
  /** Assign adaptation issues (recipes without a complete autofix) to the Copilot coding agent. */
  assignCopilot: boolean;
}

export interface LintConfig {
  schemaVersion: 1;
  enabled: boolean;
  extends: Preset[];
  rulesets: Record<string, Severity>;
  rules: Record<string, RuleSetting>;
  ignorePaths: string[];
  failOn: ActiveSeverity | "never";
  limits: { maxFiles: number; maxFileBytes: number };
  /** Repository-relative `.js`/`.mjs` modules exporting `local/*` rules; loaded only by the CLI with `--allow-local-rules`. */
  localRules: string[];
  issues: IssuesConfig;
  fixes: FixesConfig;
  alerts: AlertsConfig;
  durations: DurationsConfig;
  recipes: RecipesConfig;
}

export interface ConfigProblem {
  path: string;
  message: string;
}

export const DEFAULT_CONFIG: LintConfig = {
  schemaVersion: 1,
  enabled: true,
  extends: ["recommended"],
  rulesets: {},
  rules: {},
  // gh-aw compiles `.md` workflows into `.lock.yml`; findings there are fixed in the source, not the generated file.
  ignorePaths: ["vendor/**", "node_modules/**", "**/node_modules/**", "dist/**", "build/**", ".github/workflows/*.lock.yml"],
  failOn: "error",
  limits: { maxFiles: 2000, maxFileBytes: 512_000 },
  localRules: [],
  issues: {
    enabled: false,
    minSeverity: "error",
    minImpact: "low",
    groupBy: "rule",
    labels: [],
    assignees: [],
    assignCopilot: false,
    copilot: {},
    maxOpen: 10,
    closeResolved: true,
    rules: {},
  },
  fixes: {
    enabled: false,
    openPullRequestsLimit: 5,
    groups: {},
    ignore: [],
    labels: [],
    reviewers: [],
    branchPrefix: "cicd-optimizer/",
    draft: false,
  },
  alerts: {
    enabled: true,
    minSamples: 10,
    window: 30,
    zThreshold: 3.5,
    minIncreasePercent: 20,
    minIncreaseSeconds: 30,
    regressionWindow: 5,
    pValue: 0.01,
    recoveryRuns: 3,
    snoozeDays: 14,
    branches: [],
    labels: [],
    assignees: [],
    assignCopilot: false,
  },
  recipes: {
    enabled: true,
    maxRisk: "medium",
    ignore: [],
    labels: [],
    assignCopilot: true,
  },
  durations: { minSamples: 20, objectives: [] },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j] ?? 0;
      previous[j] = Math.min(
        above + 1,
        (previous[j - 1] ?? 0) + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length] ?? 0;
}

export function didYouMean(value: string, candidates: string[]): string {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(value, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(value.length / 3))
    ? ` Did you mean "${best}"?`
    : "";
}

export class Validator {
  readonly problems: ConfigProblem[] = [];

  problem(path: string, message: string): void {
    this.problems.push({ path, message });
  }

  unknownKeys(path: string, value: Record<string, unknown>, allowed: string[]): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.problem(`${path}${path ? "." : ""}${key}`, `Unknown key "${key}".${didYouMean(key, allowed)}`);
      }
    }
  }

  boolean(path: string, value: unknown, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    this.problem(path, "Expected a boolean.");
    return fallback;
  }

  number(path: string, value: unknown, fallback: number, min = 0): number {
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isFinite(value) && value >= min) return value;
    this.problem(path, `Expected a number >= ${min}.`);
    return fallback;
  }

  string(path: string, value: unknown, fallback: string): string {
    if (value === undefined) return fallback;
    if (typeof value === "string") return value;
    this.problem(path, "Expected a string.");
    return fallback;
  }

  strings(path: string, value: unknown, fallback: string[]): string[] {
    if (value === undefined) return fallback;
    if (typeof value === "string") return [value];
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
    this.problem(path, "Expected a list of strings.");
    return fallback;
  }

  oneOf<T extends string>(path: string, value: unknown, allowed: readonly T[], fallback: T): T {
    if (value === undefined) return fallback;
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
    this.problem(
      path,
      `Expected one of ${allowed.map((entry) => `"${entry}"`).join(", ")}.${typeof value === "string" ? didYouMean(value, [...allowed]) : ""}`,
    );
    return fallback;
  }

  record(path: string, value: unknown): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (isRecord(value)) return value;
    this.problem(path, "Expected a mapping.");
    return {};
  }
}

function normalizeSeverity(value: unknown): unknown {
  if (value === 0) return "off";
  if (value === 1) return "warn";
  if (value === 2) return "error";
  if (value === "warning") return "warn";
  if (value === false) return "off";
  return value;
}

/** Converts v0.1 configuration keys to the v0.2 schema. Returns undefined when nothing was migrated. */
export function migrateLegacyConfig(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const legacyKeys = ["disabledRules", "failOnSeverity", "ignoredPaths", "maxFiles", "maxFileBytes"];
  if (!legacyKeys.some((key) => key in raw)) return undefined;
  const migrated: Record<string, unknown> = { ...raw };
  if (Array.isArray(raw.disabledRules)) {
    const rules: Record<string, unknown> = isRecord(raw.rules) ? { ...raw.rules } : {};
    for (const id of raw.disabledRules) {
      if (typeof id === "string") rules[DEPRECATED_RULE_IDS[id] ?? id] = "off";
    }
    migrated.rules = rules;
  }
  if ("failOnSeverity" in raw) {
    const map: Record<string, string> = { high: "error", medium: "warn", low: "info", never: "never" };
    migrated.failOn = map[String(raw.failOnSeverity)] ?? raw.failOnSeverity;
  }
  if ("ignoredPaths" in raw) migrated.ignorePaths = raw.ignoredPaths;
  if ("maxFiles" in raw || "maxFileBytes" in raw) {
    migrated.limits = {
      ...(isRecord(raw.limits) ? raw.limits : {}),
      ...(raw.maxFiles !== undefined ? { maxFiles: raw.maxFiles } : {}),
      ...(raw.maxFileBytes !== undefined ? { maxFileBytes: raw.maxFileBytes } : {}),
    };
  }
  for (const key of legacyKeys) delete migrated[key];
  return migrated;
}

export interface ParsedConfig {
  config: LintConfig;
  problems: ConfigProblem[];
  migrated: boolean;
}

/** Validates a raw configuration object. Unknown rule ids, rulesets, and options are reported, never silently ignored. */
export function validateConfig(input: unknown, rules: AnyRule[]): ParsedConfig {
  const v = new Validator();
  if (input === undefined || input === null) return { config: structuredClone(DEFAULT_CONFIG), problems: [], migrated: false };
  if (!isRecord(input)) {
    v.problem("", "Configuration must be a mapping.");
    return { config: structuredClone(DEFAULT_CONFIG), problems: v.problems, migrated: false };
  }
  const legacy = migrateLegacyConfig(input);
  const raw = legacy ?? input;
  v.unknownKeys("", raw, [
    "schemaVersion",
    "enabled",
    "extends",
    "rulesets",
    "rules",
    "ignorePaths",
    "failOn",
    "limits",
    "localRules",
    "issues",
    "fixes",
    "alerts",
    "recipes",
    "durations",
  ]);
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    v.problem("schemaVersion", `Unsupported schemaVersion ${String(raw.schemaVersion)}; expected 1.`);
  }

  const ruleIds = rules.map((rule) => rule.meta.id);
  const rulesetNames = [...new Set(rules.map((rule) => rule.meta.ruleset))];
  const config = structuredClone(DEFAULT_CONFIG);
  if (raw.localRules !== undefined) {
    if (Array.isArray(raw.localRules) && raw.localRules.every((entry) => typeof entry === "string")) {
      config.localRules = [...(raw.localRules as string[])];
    } else {
      v.problem("localRules", "Expected a list of repository-relative .js or .mjs paths.");
    }
  }
  // Callers that do not load local rules (the GitHub App) skip `local/*` settings instead of rejecting the configuration.
  const skipLocal = config.localRules.length > 0 && !rules.some((rule) => rule.meta.ruleset === "local");
  const isSkippedLocal = (id: string) => skipLocal && id.startsWith("local/");
  config.enabled = v.boolean("enabled", raw.enabled, true);
  config.extends = v
    .strings("extends", raw.extends, DEFAULT_CONFIG.extends)
    .filter((preset, index) => {
      if ((PRESETS as string[]).includes(preset)) return true;
      v.problem(`extends[${index}]`, `Unknown preset "${preset}".${didYouMean(preset, PRESETS)}`);
      return false;
    }) as Preset[];

  for (const [name, value] of Object.entries(v.record("rulesets", raw.rulesets))) {
    if (skipLocal && name === "local") continue;
    if (!rulesetNames.includes(name)) {
      v.problem(`rulesets.${name}`, `Unknown ruleset "${name}".${didYouMean(name, rulesetNames)}`);
      continue;
    }
    config.rulesets[name] = v.oneOf(`rulesets.${name}`, normalizeSeverity(value), SEVERITIES, "off");
  }

  for (const [rawId, value] of Object.entries(v.record("rules", raw.rules))) {
    const id = DEPRECATED_RULE_IDS[rawId] ?? rawId;
    if (isSkippedLocal(id)) continue;
    if (id !== rawId) v.problem(`rules.${rawId}`, `Rule "${rawId}" is deprecated; use "${id}".`);
    const rule = rules.find((candidate) => candidate.meta.id === id);
    if (!rule) {
      v.problem(`rules.${rawId}`, `Unknown rule "${rawId}".${didYouMean(rawId, ruleIds)}`);
      continue;
    }
    if (Array.isArray(value)) {
      const severity = v.oneOf(`rules.${rawId}[0]`, normalizeSeverity(value[0]), SEVERITIES, "off");
      const options = v.record(`rules.${rawId}[1]`, value[1]);
      const allowed = Object.keys(rule.meta.defaultOptions as Record<string, unknown>);
      v.unknownKeys(`rules.${rawId}[1]`, options, allowed);
      for (const message of rule.meta.validateOptions?.(options) ?? []) {
        v.problem(`rules.${rawId}[1]`, message);
      }
      config.rules[id] = [severity, options];
    } else {
      config.rules[id] = v.oneOf(`rules.${rawId}`, normalizeSeverity(value), SEVERITIES, "off");
    }
  }

  config.ignorePaths = v.strings("ignorePaths", raw.ignorePaths, DEFAULT_CONFIG.ignorePaths);
  config.failOn = v.oneOf("failOn", raw.failOn, ["info", "warn", "error", "never"] as const, "error");

  const limits = v.record("limits", raw.limits);
  v.unknownKeys("limits", limits, ["maxFiles", "maxFileBytes"]);
  config.limits = {
    maxFiles: v.number("limits.maxFiles", limits.maxFiles, DEFAULT_CONFIG.limits.maxFiles, 1),
    maxFileBytes: v.number("limits.maxFileBytes", limits.maxFileBytes, DEFAULT_CONFIG.limits.maxFileBytes, 1),
  };

  const issues = v.record("issues", raw.issues);
  const issueDefaults = DEFAULT_CONFIG.issues;
  v.unknownKeys("issues", issues, Object.keys(issueDefaults));
  const copilot = v.record("issues.copilot", issues.copilot);
  v.unknownKeys("issues.copilot", copilot, ["baseBranch", "customInstructions", "customAgent", "model"]);
  const issueRules: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(v.record("issues.rules", issues.rules))) {
    if (isSkippedLocal(id)) continue;
    if (!ruleIds.includes(id)) v.problem(`issues.rules.${id}`, `Unknown rule "${id}".${didYouMean(id, ruleIds)}`);
    else issueRules[id] = v.boolean(`issues.rules.${id}`, value, true);
  }
  config.issues = {
    enabled: v.boolean("issues.enabled", issues.enabled, issueDefaults.enabled),
    minSeverity: v.oneOf("issues.minSeverity", issues.minSeverity, ["info", "warn", "error"] as const, issueDefaults.minSeverity),
    minImpact: v.oneOf("issues.minImpact", issues.minImpact, IMPACTS, issueDefaults.minImpact),
    groupBy: v.oneOf("issues.groupBy", issues.groupBy, ["rule", "finding"] as const, issueDefaults.groupBy),
    labels: v.strings("issues.labels", issues.labels, []),
    assignees: v.strings("issues.assignees", issues.assignees, []),
    assignCopilot: v.boolean("issues.assignCopilot", issues.assignCopilot, false),
    copilot: Object.fromEntries(
      Object.entries(copilot).map(([key, value]) => [key, v.string(`issues.copilot.${key}`, value, "")]),
    ) as CopilotAssignment,
    maxOpen: v.number("issues.maxOpen", issues.maxOpen, issueDefaults.maxOpen, 0),
    closeResolved: v.boolean("issues.closeResolved", issues.closeResolved, true),
    rules: issueRules,
  };

  const fixes = v.record("fixes", raw.fixes);
  const fixDefaults = DEFAULT_CONFIG.fixes;
  v.unknownKeys("fixes", fixes, Object.keys(fixDefaults));
  const groups: Record<string, FixGroup> = {};
  for (const [name, value] of Object.entries(v.record("fixes.groups", fixes.groups))) {
    const group = v.record(`fixes.groups.${name}`, value);
    v.unknownKeys(`fixes.groups.${name}`, group, ["rulesets", "rules"]);
    groups[name] = {
      ...(group.rulesets !== undefined ? { rulesets: v.strings(`fixes.groups.${name}.rulesets`, group.rulesets, []) } : {}),
      ...(group.rules !== undefined ? { rules: v.strings(`fixes.groups.${name}.rules`, group.rules, []) } : {}),
    };
  }
  const ignore = Array.isArray(fixes.ignore)
    ? fixes.ignore.flatMap((entry, index) => {
        const item = v.record(`fixes.ignore[${index}]`, entry);
        if (typeof item.rule !== "string") {
          v.problem(`fixes.ignore[${index}].rule`, "Expected a rule id.");
          return [];
        }
        return [{ rule: item.rule, ...(item.paths !== undefined ? { paths: v.strings(`fixes.ignore[${index}].paths`, item.paths, []) } : {}) }];
      })
    : [];
  config.fixes = {
    enabled: v.boolean("fixes.enabled", fixes.enabled, fixDefaults.enabled),
    openPullRequestsLimit: v.number("fixes.openPullRequestsLimit", fixes.openPullRequestsLimit, fixDefaults.openPullRequestsLimit, 0),
    groups,
    ignore,
    labels: v.strings("fixes.labels", fixes.labels, []),
    reviewers: v.strings("fixes.reviewers", fixes.reviewers, []),
    branchPrefix: v.string("fixes.branchPrefix", fixes.branchPrefix, fixDefaults.branchPrefix),
    draft: v.boolean("fixes.draft", fixes.draft, false),
  };

  const alerts = v.record("alerts", raw.alerts);
  const alertDefaults = DEFAULT_CONFIG.alerts;
  v.unknownKeys("alerts", alerts, Object.keys(alertDefaults));
  config.alerts = {
    enabled: v.boolean("alerts.enabled", alerts.enabled, alertDefaults.enabled),
    minSamples: v.number("alerts.minSamples", alerts.minSamples, alertDefaults.minSamples, 3),
    window: v.number("alerts.window", alerts.window, alertDefaults.window, 5),
    zThreshold: v.number("alerts.zThreshold", alerts.zThreshold, alertDefaults.zThreshold, 1),
    minIncreasePercent: v.number("alerts.minIncreasePercent", alerts.minIncreasePercent, alertDefaults.minIncreasePercent, 0),
    minIncreaseSeconds: v.number("alerts.minIncreaseSeconds", alerts.minIncreaseSeconds, alertDefaults.minIncreaseSeconds, 0),
    regressionWindow: v.number("alerts.regressionWindow", alerts.regressionWindow, alertDefaults.regressionWindow, 3),
    pValue: v.number("alerts.pValue", alerts.pValue, alertDefaults.pValue, 0),
    recoveryRuns: v.number("alerts.recoveryRuns", alerts.recoveryRuns, alertDefaults.recoveryRuns, 1),
    snoozeDays: v.number("alerts.snoozeDays", alerts.snoozeDays, alertDefaults.snoozeDays, 0),
    branches: v.strings("alerts.branches", alerts.branches, []),
    labels: v.strings("alerts.labels", alerts.labels, []),
    assignees: v.strings("alerts.assignees", alerts.assignees, []),
    assignCopilot: v.boolean("alerts.assignCopilot", alerts.assignCopilot, false),
  };

  const recipes = v.record("recipes", raw.recipes);
  const recipeDefaults = DEFAULT_CONFIG.recipes;
  v.unknownKeys("recipes", recipes, Object.keys(recipeDefaults));
  config.recipes = {
    enabled: v.boolean("recipes.enabled", recipes.enabled, recipeDefaults.enabled),
    maxRisk: v.oneOf("recipes.maxRisk", recipes.maxRisk, RECIPE_RISKS, recipeDefaults.maxRisk),
    ignore: v.strings("recipes.ignore", recipes.ignore, []),
    labels: v.strings("recipes.labels", recipes.labels, []),
    assignCopilot: v.boolean("recipes.assignCopilot", recipes.assignCopilot, recipeDefaults.assignCopilot),
  };

  const durations = v.record("durations", raw.durations);
  v.unknownKeys("durations", durations, ["minSamples", "objectives"]);
  if (durations.objectives !== undefined && !Array.isArray(durations.objectives)) v.problem("durations.objectives", "Expected a list of duration objectives.");
  config.durations = {
    minSamples: v.number("durations.minSamples", durations.minSamples, DEFAULT_CONFIG.durations.minSamples, 2),
    objectives: (Array.isArray(durations.objectives) ? durations.objectives : []).map((entry, index) => {
      const path = `durations.objectives[${index}]`;
      const objective = v.record(path, entry);
      v.unknownKeys(path, objective, ["workflow", "job", "maxDurationMs"]);
      return {
        workflow: v.string(`${path}.workflow`, objective.workflow, ""),
        ...(objective.job !== undefined ? { job: v.string(`${path}.job`, objective.job, "") } : {}),
        maxDurationMs: v.number(`${path}.maxDurationMs`, objective.maxDurationMs, 0, 1),
      };
    }),
  };
  v.problems.push(...durationPolicyProblems(config.durations));

  return { config, problems: v.problems, migrated: legacy !== undefined };
}

export function parseConfigText(text: string, rules: AnyRule[], path = CONFIG_PATHS[0] ?? "config"): ParsedConfig {
  let raw: unknown;
  try {
    raw = parseYamlText(text, { maxAliasCount: 100 });
  } catch (error) {
    return {
      config: structuredClone(DEFAULT_CONFIG),
      problems: [{ path, message: `Invalid YAML: ${error instanceof Error ? error.message : String(error)}` }],
      migrated: false,
    };
  }
  return validateConfig(raw, rules);
}

/**
 * Resolution order (later wins): every rule off -> presets in `extends` order -> `rulesets` -> `rules`.
 * Preset membership comes only from each rule's `meta.presets`; `all` enables every rule.
 * Rule options shallow-replace the rule's defaults.
 */
export function resolveRules(config: LintConfig, rules: AnyRule[], presetOverride?: Preset[]): ResolvedRule[] {
  const presets = presetOverride ?? config.extends;
  return rules.flatMap((rule) => {
    const setting = config.rules[rule.meta.id];
    const level = resolveSeverity([
      ...presets.map((preset) => preset === "all" || rule.meta.presets.includes(preset) ? rule.meta.defaultSeverity : undefined),
      config.rulesets[rule.meta.ruleset],
      Array.isArray(setting) ? setting[0] : setting,
    ]);
    if (level === "off") return [];
    return [
      {
        rule,
        severity: level,
        options: { ...(rule.meta.defaultOptions as Record<string, unknown>), ...(Array.isArray(setting) ? setting[1] : {}) },
      },
    ];
  });
}
