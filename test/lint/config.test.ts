import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, didYouMean, migrateLegacyConfig, parseConfigText, resolveRules, validateConfig } from "../../src/lint/config.js";
import { allRules } from "../../src/lint/rules/index.js";
import { config } from "./helpers.js";

const paths = (problems: Array<{ path: string }>) => problems.map((problem) => problem.path);
const ids = (resolved: ReturnType<typeof resolveRules>) => resolved.map((entry) => entry.rule.meta.id);

describe("validateConfig", () => {
  it("returns a copy of the defaults for empty input", () => {
    for (const empty of [undefined, null]) {
      const parsed = validateConfig(empty, allRules);
      expect(parsed.problems).toEqual([]);
      expect(parsed.config).toEqual(DEFAULT_CONFIG);
      expect(parsed.config).not.toBe(DEFAULT_CONFIG);
    }
    expect(validateConfig({}, allRules).config).toEqual(DEFAULT_CONFIG);
  });

  it("rejects non-mappings", () => {
    expect(validateConfig(["rules"], allRules).problems).toEqual([{ path: "", message: "Configuration must be a mapping." }]);
  });

  it("reports unknown keys, rules, rulesets, and presets with suggestions", () => {
    const parsed = validateConfig(
      {
        rule: {},
        extends: ["recomended", "strict"],
        rulesets: { cachin: "off", caching: "error" },
        rules: { "workflow/job-timout": "warn" },
        limits: { maxFile: 3 },
        issues: { rules: { "nope/rule": true } },
      },
      allRules,
    );
    const messages = Object.fromEntries(parsed.problems.map((problem) => [problem.path, problem.message]));
    expect(messages.rule).toContain('Did you mean "rules"?');
    expect(messages["extends[0]"]).toContain('Did you mean "recommended"?');
    expect(messages["rulesets.cachin"]).toContain('Did you mean "caching"?');
    expect(messages["rules.workflow/job-timout"]).toContain('Did you mean "workflow/job-timeout"?');
    expect(messages["limits.maxFile"]).toContain('Did you mean "maxFiles"?');
    expect(messages["issues.rules.nope/rule"]).toContain("Unknown rule");
    expect(parsed.config.extends).toEqual(["strict"]);
    expect(parsed.config.rulesets).toEqual({ caching: "error" });
    expect(parsed.config.rules).toEqual({});
  });

  it("normalizes ESLint-style severities", () => {
    const parsed = validateConfig(
      {
        rules: {
          "workflow/job-timeout": 0,
          "workflow/concurrency": 1,
          "hermeticity/frozen-lockfile": 2,
          "caching/setup-cache": "warning",
          "caching/cache-key": false,
          "hermeticity/pin-runner": "loud",
        },
      },
      allRules,
    );
    expect(parsed.config.rules).toEqual({
      "workflow/job-timeout": "off",
      "workflow/concurrency": "warn",
      "hermeticity/frozen-lockfile": "error",
      "caching/setup-cache": "warn",
      "caching/cache-key": "off",
      "hermeticity/pin-runner": "off",
    });
    expect(paths(parsed.problems)).toEqual(["rules.hermeticity/pin-runner"]);
  });

  it("migrates deprecated rule ids with a warning", () => {
    const parsed = validateConfig({ rules: { "workflow-timeout": "error" } }, allRules);
    expect(parsed.config.rules).toEqual({ "workflow/job-timeout": "error" });
    expect(parsed.problems[0]?.message).toContain('use "workflow/job-timeout"');
  });

  it("validates rule options against defaults and validateOptions", () => {
    const parsed = validateConfig(
      { rules: { "workflow/job-timeout": ["error", { defaultMinutes: -1, bogus: 1 }], "workflow/concurrency": ["warn", { }] } },
      allRules,
    );
    expect(parsed.config.rules["workflow/job-timeout"]).toEqual(["error", { defaultMinutes: -1, bogus: 1 }]);
    const messages = parsed.problems.map((problem) => `${problem.path}: ${problem.message}`);
    expect(messages.some((m) => m.startsWith("rules.workflow/job-timeout[1].bogus: Unknown key"))).toBe(true);
    expect(messages).toContain("rules.workflow/job-timeout[1]: defaultMinutes must be a positive number");
  });

  it("validates scalar sections", () => {
    const parsed = validateConfig(
      {
        schemaVersion: 2,
        enabled: "yes",
        failOn: "warning",
        limits: { maxFiles: 0 },
        recipes: { maxRisk: "extreme", assignCopilot: false },
        alerts: { zThreshold: 0.5 },
        fixes: { ignore: [{ paths: ["a"] }, { rule: "workflow/job-timeout", paths: "docs/**" }] },
      },
      allRules,
    );
    expect(paths(parsed.problems)).toEqual(
      expect.arrayContaining(["schemaVersion", "enabled", "failOn", "limits.maxFiles", "recipes.maxRisk", "alerts.zThreshold", "fixes.ignore[0].rule"]),
    );
    expect(parsed.config.enabled).toBe(true);
    expect(parsed.config.failOn).toBe("error");
    expect(parsed.config.limits.maxFiles).toBe(DEFAULT_CONFIG.limits.maxFiles);
    expect(parsed.config.recipes).toMatchObject({ maxRisk: "medium", assignCopilot: false });
    expect(parsed.config.fixes.ignore).toEqual([{ rule: "workflow/job-timeout", paths: ["docs/**"] }]);
  });

  it("migrates the v0.1 schema", () => {
    const legacy = { disabledRules: ["workflow-timeout", "caching/cache-key"], failOnSeverity: "medium", ignoredPaths: ["legacy/**"], maxFiles: 10 };
    expect(migrateLegacyConfig({ rules: {} })).toBeUndefined();
    const parsed = validateConfig(legacy, allRules);
    expect(parsed.migrated).toBe(true);
    expect(parsed.problems).toEqual([]);
    expect(parsed.config.rules).toEqual({ "workflow/job-timeout": "off", "caching/cache-key": "off" });
    expect(parsed.config.failOn).toBe("warn");
    expect(parsed.config.ignorePaths).toEqual(["legacy/**"]);
    expect(parsed.config.limits).toEqual({ maxFiles: 10, maxFileBytes: DEFAULT_CONFIG.limits.maxFileBytes });
    expect(validateConfig({ failOnSeverity: "high" }, allRules).config.failOn).toBe("error");
  });
});

describe("parseConfigText", () => {
  it("parses YAML", () => {
    const parsed = parseConfigText("extends: [strict]\nrules:\n  workflow/job-timeout: [warn, { defaultMinutes: 15 }]\n", allRules);
    expect(parsed.problems).toEqual([]);
    expect(parsed.config.extends).toEqual(["strict"]);
  });

  it("reports invalid YAML at the config path", () => {
    const parsed = parseConfigText("rules: [unclosed", allRules, ".github/ci-cd-optimizer.yaml");
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]?.path).toBe(".github/ci-cd-optimizer.yaml");
    expect(parsed.problems[0]?.message).toMatch(/^Invalid YAML/);
    expect(parsed.config).toEqual(DEFAULT_CONFIG);
  });
});

describe("resolveRules", () => {
  const byId = (id: string) => allRules.find((rule) => rule.meta.id === id);

  it("enables preset members at their default severity", () => {
    const resolved = resolveRules(config(), allRules);
    expect(ids(resolved)).toContain("workflow/job-timeout");
    expect(ids(resolved)).not.toContain("checkout/sparse-checkout");
    expect(ids(resolved)).not.toContain("registries/ghcr");
    for (const entry of resolved) expect(entry.severity).toBe(entry.rule.meta.defaultSeverity);
  });

  it("layers presets, then rulesets, then rules", () => {
    const resolved = resolveRules(
      config({ extends: ["recommended", "strict"], rulesets: { checkout: "error" }, rules: { "checkout/partial-clone": "off", "workflow/job-timeout": "info" } }),
      allRules,
    );
    const severity = Object.fromEntries(resolved.map((entry) => [entry.rule.meta.id, entry.severity]));
    expect(severity["checkout/sparse-checkout"]).toBe("error");
    expect(severity["checkout/affected-base-ref"]).toBe("error");
    expect(severity["checkout/partial-clone"]).toBeUndefined();
    expect(severity["workflow/job-timeout"]).toBe("info");
  });

  it("enables everything with the all preset and nothing without presets", () => {
    expect(resolveRules(config(), allRules, ["all"])).toHaveLength(allRules.length);
    expect(resolveRules(config({ extends: [] }), allRules)).toEqual([]);
  });

  it("shallow-merges rule options over the defaults", () => {
    const resolved = resolveRules(config({ rules: { "workflow/job-timeout": ["error", { defaultMinutes: 15 }] } }), allRules);
    const entry = resolved.find((item) => item.rule === byId("workflow/job-timeout"));
    expect(entry?.severity).toBe("error");
    expect(entry?.options).toEqual({ defaultMinutes: 15, maxMinutes: 120 });
  });

  it("returns rules in registry order", () => {
    const resolved = ids(resolveRules(config(), allRules, ["all"]));
    expect(resolved).toEqual(allRules.map((rule) => rule.meta.id));
  });
});

describe("didYouMean", () => {
  it("suggests close matches only", () => {
    expect(didYouMean("cachng", ["caching", "checkout"])).toBe(' Did you mean "caching"?');
    expect(didYouMean("zzz", ["caching", "checkout"])).toBe("");
    expect(didYouMean("x", [])).toBe("");
  });
});
