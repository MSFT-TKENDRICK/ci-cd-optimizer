import { describe, expect, it } from "vitest";
import { applyFixes } from "../../src/lint/fix.js";
import { format, github, json, markdown, sarif, stylish } from "../../src/lint/formatters/index.js";
import type { Diagnostic, LintResult } from "../../src/lint/types.js";
import { makeRule } from "./helpers.js";

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    ruleId: "workflow/job-timeout",
    ruleset: "workflow",
    severity: "warn",
    message: "Job has no timeout.",
    path: ".github/workflows/ci.yml",
    line: 4,
    column: 3,
    impact: "medium",
    confidence: "high",
    fingerprint: "f".repeat(32),
    docsUrl: "https://example.com/rules.md#workflow-job-timeout",
    kind: "practice",
    ...overrides,
  };
}

function result(diagnostics: Diagnostic[], overrides: Partial<LintResult> = {}): LintResult {
  return { diagnostics, skipped: [], parseProblems: [], filesAnalyzed: 2, rulesRun: 5, suppressed: 0, durationMs: 7, ...overrides };
}

const fixable = diagnostic({
  suggestion: "Add timeout-minutes: 30.",
  fix: { description: "Add timeout", edits: [{ path: ".github/workflows/ci.yml", start: 0, end: 0, text: "x" }] },
});

describe("formatters", () => {
  it("stylish groups by file and summarizes", () => {
    const text = stylish(
      result([fixable, diagnostic({ severity: "error", ruleId: "hermeticity/frozen-lockfile", line: 9, message: "npm install" }), diagnostic({ path: "Dockerfile", severity: "info", line: 1 })], {
        skipped: [{ ruleId: "x/y", reason: "r" }],
        suppressed: 2,
        parseProblems: [{ path: "bad.yml", line: 3, message: "oops" }],
      }),
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe(".github/workflows/ci.yml");
    expect(lines[1]).toMatch(/^ {2}4:3 +warning +Job has no timeout\. {2}workflow\/job-timeout \(fixable\)$/);
    expect(lines[2]).toContain("-> Add timeout-minutes: 30.");
    expect(text).toContain("bad.yml:3 parse error: oops");
    expect(lines.at(-1)).toBe(
      "3 problem(s) (1 error, 1 warning, 1 info), 1 fixable with --fix; 5 rules over 2 files in 7ms; 1 rule(s) skipped; 2 suppressed",
    );
    expect(stylish(result([]))).toBe("0 problem(s) (0 error, 0 warning, 0 info); 5 rules over 2 files in 7ms");
  });

  it("json round-trips the result", () => {
    const value = result([fixable]);
    expect(JSON.parse(json(value))).toEqual(value);
  });

  it("github emits escaped workflow commands", () => {
    const text = github(
      result([
        diagnostic({ severity: "error", path: "a,b:c.yml", message: "50%\nnext", ruleId: "x/y" }),
        diagnostic({ severity: "info", suggestion: "do it" }),
        diagnostic(),
      ]),
    );
    expect(text.split("\n")).toEqual([
      "::error file=a%2Cb%3Ac.yml,line=4,col=3,title=x/y::50%25%0Anext",
      "::notice file=.github/workflows/ci.yml,line=4,col=3,title=workflow/job-timeout::Job has no timeout. do it",
      "::warning file=.github/workflows/ci.yml,line=4,col=3,title=workflow/job-timeout::Job has no timeout.",
    ]);
  });

  it("markdown renders a table, escapes pipes, limits rows, and lists skipped rules", () => {
    expect(markdown(result([]))).toContain("No CI/CD optimization findings.");
    const many = Array.from({ length: 3 }, (_, i) => diagnostic({ line: i + 1, message: `a | b ${i}` }));
    const text = markdown(result(many, { skipped: [{ ruleId: "x/y", reason: "needs repo" }] }), { title: "Report", limit: 2 });
    expect(text.startsWith("## Report")).toBe(true);
    expect(text).toContain("| warn | [`workflow/job-timeout`](https://example.com/rules.md#workflow-job-timeout) | `.github/workflows/ci.yml:1` | a \\| b 0 |");
    expect(text).not.toContain("a \\| b 2");
    expect(text).toContain("_1 more finding(s) omitted._");
    expect(text).toContain("- `x/y`: needs repo");
    expect(markdown(result([fixable]))).toContain("<br>**Fix:** Add timeout-minutes: 30.");
  });

  it("sarif emits a code-scanning compatible log for the rules that fired", () => {
    const rules = [
      makeRule("workflow/job-timeout", undefined, { impact: "high" }),
      makeRule("caching/setup-cache", undefined, { defaultSeverity: "info", impact: "low" }),
      makeRule("hermeticity/frozen-lockfile", undefined, { defaultSeverity: "error" }),
    ];
    const log = JSON.parse(
      sarif(result([fixable, diagnostic({ ruleId: "hermeticity/frozen-lockfile", ruleset: "hermeticity", severity: "error", line: 9 })]), rules, "1.2.3"),
    );
    expect(log.version).toBe("2.1.0");
    const run = log.runs[0];
    expect(run.tool.driver).toMatchObject({ name: "ci-cd-optimizer", semanticVersion: "1.2.3" });
    expect(run.tool.driver.rules.map((rule: { id: string }) => rule.id)).toEqual(["workflow/job-timeout", "hermeticity/frozen-lockfile"]);
    expect(run.tool.driver.rules[0]).toMatchObject({
      name: "workflowJobTimeout",
      helpUri: "https://example.com/rules.md#workflow-job-timeout",
      defaultConfiguration: { level: "warning" },
      properties: { "security-severity": "7.0", "problem.severity": "warning" },
    });
    expect(run.tool.driver.rules[1].defaultConfiguration.level).toBe("error");
    expect(run.results[0]).toMatchObject({
      ruleId: "workflow/job-timeout",
      ruleIndex: 0,
      level: "warning",
      message: { text: "Job has no timeout. Add timeout-minutes: 30." },
      partialFingerprints: { "ciCdOptimizer/v1": "f".repeat(32) },
      locations: [{ physicalLocation: { artifactLocation: { uri: ".github/workflows/ci.yml", uriBaseId: "%SRCROOT%" }, region: { startLine: 4, startColumn: 3 } } }],
    });
    expect(run.results[1]).toMatchObject({ ruleIndex: 1, level: "error" });
    expect(JSON.parse(sarif(result([]), rules)).runs[0].results).toEqual([]);
  });

  it("format dispatches by name and defaults to stylish", () => {
    const value = result([fixable]);
    expect(format("json", value, [])).toBe(json(value));
    expect(format("github", value, [])).toBe(github(value));
    expect(format("markdown", value, [])).toBe(markdown(value));
    expect(format("stylish", value, [])).toBe(stylish(value));
    expect(JSON.parse(format("sarif", value, [makeRule("workflow/job-timeout")])).version).toBe("2.1.0");
  });
});

describe("applyFixes", () => {
  const files = [
    { path: "a.yml", content: "one\ntwo\nthree\n" },
    { path: "b.yml", content: "bee\n" },
  ];
  const edit = (path: string, start: number, end: number, text: string) => diagnostic({ path, fix: { description: text, edits: [{ path, start, end, text }] } });

  it("applies non-overlapping edits from the end of the file backwards", () => {
    const output = applyFixes(files, [edit("a.yml", 0, 3, "ONE"), edit("a.yml", 8, 13, "THREE"), edit("b.yml", 4, 4, "sea\n")]);
    expect(output.files.get("a.yml")).toBe("ONE\ntwo\nTHREE\n");
    expect(output.files.get("b.yml")).toBe("bee\nsea\n");
    expect(output.applied).toHaveLength(3);
    expect(output.conflicts).toEqual([]);
  });

  it("defers overlapping fixes, duplicate insertions, and unknown files as conflicts", () => {
    const overlapping = edit("a.yml", 2, 6, "X");
    const insertA = edit("a.yml", 4, 4, "first\n");
    const insertB = edit("a.yml", 4, 4, "second\n");
    const missing = edit("c.yml", 0, 0, "x");
    const output = applyFixes(files, [edit("a.yml", 0, 3, "ONE"), overlapping, insertA, insertB, missing, diagnostic()]);
    expect(output.applied.map((d) => d.fix?.description)).toEqual(["ONE", "first\n"]);
    expect(output.conflicts).toEqual([overlapping, insertB, missing]);
    expect(output.files.get("a.yml")).toBe("ONE\nfirst\ntwo\nthree\n");
    expect(output.files.has("b.yml")).toBe(false);
  });

  it("treats a multi-edit fix atomically", () => {
    const multi = diagnostic({
      fix: {
        description: "multi",
        edits: [
          { path: "b.yml", start: 0, end: 0, text: "# head\n" },
          { path: "a.yml", start: 0, end: 3, text: "uno" },
        ],
      },
    });
    const output = applyFixes(files, [edit("a.yml", 1, 2, "N"), multi]);
    expect(output.conflicts).toEqual([multi]);
    expect(output.files.has("b.yml")).toBe(false);
  });
});
