import { describe, expect, it } from "vitest";
import { parseMarker } from "../../src/issues/markers.js";
import { desiredIssues, qualifies } from "../../src/issues/render.js";
import { DEFAULT_CONFIG, type IssuesConfig } from "../../src/lint/config.js";
import { allRules } from "../../src/lint/rules/index.js";
import type { Diagnostic } from "../../src/lint/types.js";

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    ruleId: "workflow/job-timeout",
    ruleset: "workflow",
    severity: "error",
    message: "Job `build` has no timeout-minutes.",
    path: ".github/workflows/ci.yml",
    line: 7,
    column: 3,
    suggestion: "Add `timeout-minutes: 30`.",
    impact: "medium",
    confidence: "high",
    fingerprint: "fp-1",
    docsUrl: "https://example.test/rules#workflow-job-timeout",
    kind: "practice",
    ...overrides,
  };
}

const config: IssuesConfig = { ...DEFAULT_CONFIG.issues, enabled: true, minSeverity: "warn", labels: ["ci"] };
const context = { owner: "acme", repo: "widgets", sha: "abc123", rules: allRules };

describe("qualifies", () => {
  it("applies severity and impact thresholds with per-rule overrides", () => {
    expect(qualifies(diagnostic({ severity: "warn" }), config)).toBe(true);
    expect(qualifies(diagnostic({ severity: "info" }), config)).toBe(false);
    expect(qualifies(diagnostic({ impact: "low" }), { ...config, minImpact: "medium" })).toBe(false);
    expect(qualifies(diagnostic({ severity: "info" }), { ...config, rules: { "workflow/job-timeout": true } })).toBe(true);
    expect(qualifies(diagnostic(), { ...config, rules: { "workflow/job-timeout": false } })).toBe(false);
  });
});

describe("desiredIssues", () => {
  it("groups findings per rule into one actionable issue with permalinks and agent instructions", () => {
    const issues = desiredIssues(
      [
        diagnostic(),
        diagnostic({ fingerprint: "fp-2", line: 20, severity: "warn", impact: "high", message: "Job `test` has no timeout-minutes." }),
        diagnostic({ ruleId: "workflow/concurrency", fingerprint: "fp-3", severity: "info" }),
      ],
      config,
      context,
    );
    expect(issues).toHaveLength(1);
    const [issue] = issues;
    expect(issue?.fingerprint).toBe("rule:workflow/job-timeout");
    expect(issue?.title).toMatch(/^CI\/CD: .+ \(2 findings\)$/);
    expect(issue?.labels).toEqual(["cicd-optimizer", "ruleset:workflow", "severity:error", "impact:high", "ci"]);
    expect(issue?.body).toContain("- [ ] [`.github/workflows/ci.yml:20`](https://github.com/acme/widgets/blob/abc123/.github/workflows/ci.yml#L20)");
    expect(issue?.body).toContain("### Instructions for coding agents");
    expect(parseMarker(issue?.body)).toMatchObject({ kind: "finding", fingerprint: "rule:workflow/job-timeout", attributes: { rule: "workflow/job-timeout" } });
  });

  it("keeps the signature stable when only line numbers move", () => {
    const [first] = desiredIssues([diagnostic()], config, context);
    const [moved] = desiredIssues([diagnostic({ line: 99 })], config, context);
    const [changed] = desiredIssues([diagnostic({ message: "different" })], config, context);
    expect(moved?.signature).toBe(first?.signature);
    expect(changed?.signature).not.toBe(first?.signature);
  });

  it("can open one issue per finding and prioritizes by severity then impact", () => {
    const issues = desiredIssues(
      [diagnostic({ severity: "warn", impact: "high" }), diagnostic({ fingerprint: "fp-2", severity: "error", impact: "low" })],
      { ...config, groupBy: "finding" },
      context,
    );
    expect(issues.map((issue) => issue.fingerprint)).toEqual(["finding:fp-1", "finding:fp-2"]);
    expect((issues[1]?.priority ?? 0) > (issues[0]?.priority ?? 0)).toBe(true);
  });
});
