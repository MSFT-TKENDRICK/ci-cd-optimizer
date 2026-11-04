import { describe, expect, it } from "vitest";
import { atLeast, collectSuppressions, docsUrl, exceedsThreshold, fingerprint, lint } from "../../src/lint/engine.js";
import type { Diagnostic } from "../../src/lint/types.js";
import { config, input, makeRule, WORKFLOW } from "./helpers.js";

const WORKFLOW_TEXT = `on: push
jobs:
  build:
    # cicd-optimizer-disable-next-line demo/a -- known slow runner

    # an unrelated comment
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

const at = (line: number, key?: string) => (report: (d: { path: string; line: number; message: string; key?: string }) => void) =>
  report({ path: WORKFLOW, line, message: `finding at ${line}`, ...(key ? { key } : {}) });

describe("lint engine", () => {
  describe("suppression directives", () => {
    it("suppresses the next code line, skipping blank and comment lines, for the listed rule only", () => {
      const a = makeRule("demo/a", at(7));
      const b = makeRule("demo/b", at(7));
      const result = lint(input({ [WORKFLOW]: WORKFLOW_TEXT }), { config: config(), rules: [a, b] });
      expect(result.diagnostics.map((d) => d.ruleId)).toEqual(["demo/b"]);
      expect(result.suppressed).toBe(1);
    });

    it("accepts ruleset names and bare directives", () => {
      const text = WORKFLOW_TEXT.replace("demo/a -- known slow runner", "demo");
      const rules = [makeRule("demo/a", at(7)), makeRule("demo/b", at(7)), makeRule("other/c", at(7))];
      expect(lint(input({ [WORKFLOW]: text }), { config: config(), rules }).diagnostics.map((d) => d.ruleId)).toEqual(["other/c"]);
      const bare = WORKFLOW_TEXT.replace(" demo/a -- known slow runner", "");
      expect(lint(input({ [WORKFLOW]: bare }), { config: config(), rules }).diagnostics).toEqual([]);
    });

    it("does not suppress other lines", () => {
      const result = lint(input({ [WORKFLOW]: WORKFLOW_TEXT }), { config: config(), rules: [makeRule("demo/a", at(9))] });
      expect(result.diagnostics).toHaveLength(1);
      expect(result.suppressed).toBe(0);
    });

    it("supports file-level directives scoped to rule ids", () => {
      const text = `# cicd-optimizer-disable-file demo/a\n${WORKFLOW_TEXT}`;
      const rules = [makeRule("demo/a", at(3)), makeRule("demo/a2", at(3)), makeRule("demo/b", at(9))];
      const result = lint(input({ [WORKFLOW]: text }), { config: config(), rules });
      expect(result.diagnostics.map((d) => d.ruleId)).toEqual(["demo/a2", "demo/b"]);
      expect(result.suppressed).toBe(1);
    });

    it("ignores directives inside YAML block scalars", () => {
      const text = `on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: |
          # cicd-optimizer-disable-file
          echo hi
`;
      expect(collectSuppressions({ path: WORKFLOW, content: text }).file).toBeUndefined();
      const result = lint(input({ [WORKFLOW]: text }), { config: config(), rules: [makeRule("demo/a", at(1))] });
      expect(result.diagnostics).toHaveLength(1);
    });

    it("treats directives as YAML comments only in YAML files but still honors them in Dockerfiles", () => {
      const dockerfile = "# cicd-optimizer-disable-next-line demo/a\nFROM node:22\n";
      const rule = makeRule("demo/a", (report) => report({ path: "Dockerfile", line: 2, message: "unpinned" }));
      expect(lint(input({ Dockerfile: dockerfile }), { config: config(), rules: [rule] }).diagnostics).toEqual([]);
    });
  });

  describe("fingerprints", () => {
    it("uses the key instead of the line so findings survive edits", () => {
      const before = lint(input({ [WORKFLOW]: "on: push\n" }), { config: config(), rules: [makeRule("demo/a", at(1, "jobs.build"))] });
      const after = lint(input({ [WORKFLOW]: "on: push\n" }), { config: config(), rules: [makeRule("demo/a", at(5, "jobs.build"))] });
      expect(before.diagnostics[0]?.fingerprint).toBe(after.diagnostics[0]?.fingerprint);
      expect(before.diagnostics[0]?.fingerprint).toBe(fingerprint("demo/a", WORKFLOW, "jobs.build"));
      expect(before.diagnostics[0]?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    });

    it("numbers repeated discriminators and dedupes identical reports", () => {
      const rule = makeRule("demo/a", (report) => {
        report({ path: WORKFLOW, line: 2, message: "same", key: "k" });
        report({ path: WORKFLOW, line: 2, message: "same", key: "k" });
        report({ path: WORKFLOW, line: 3, message: "same", key: "k" });
      });
      const result = lint(input({ [WORKFLOW]: "on: push\n" }), { config: config(), rules: [rule] });
      expect(result.diagnostics.map((d) => d.fingerprint)).toEqual([fingerprint("demo/a", WORKFLOW, "k"), fingerprint("demo/a", WORKFLOW, "k#1")]);
    });

    it("falls back to the message as the discriminator", () => {
      const result = lint(input({ [WORKFLOW]: "on: push\n" }), { config: config(), rules: [makeRule("demo/a", at(4))] });
      expect(result.diagnostics[0]?.fingerprint).toBe(fingerprint("demo/a", WORKFLOW, "finding at 4"));
    });
  });

  describe("rule execution", () => {
    it("skips rules whose capabilities are not met", () => {
      const rules = [
        makeRule("demo/repo", at(1), { requires: ["repository"] }),
        makeRule("demo/inventory", at(1), { requires: ["complete-inventory"] }),
        makeRule("demo/change", at(1), { requires: ["change-set"] }),
      ];
      const files = lint(input({ [WORKFLOW]: "on: push\n" }, { mode: "files", inventoryComplete: false }), { config: config(), rules });
      expect(files.skipped.map((s) => s.ruleId)).toEqual(["demo/repo", "demo/inventory", "demo/change"]);
      expect(files.skipped[0]?.reason).toContain("whole repository");
      expect(files.rulesRun).toBe(0);

      const partial = lint(input({ [WORKFLOW]: "on: push\n" }, { inventoryComplete: false }), { config: config(), rules });
      expect(partial.skipped.map((s) => s.ruleId)).toEqual(["demo/inventory", "demo/change"]);

      const full = lint(input({ [WORKFLOW]: "on: push\n" }, { change: { event: "pull_request", changedPaths: [WORKFLOW] } }), { config: config(), rules });
      expect(full.skipped).toEqual([]);
      expect(full.rulesRun).toBe(3);
    });

    it("isolates crashing rules", () => {
      const rules = [
        makeRule("demo/crash", () => {
          throw new Error("boom");
        }),
        makeRule("demo/ok", at(1)),
      ];
      const result = lint(input({ [WORKFLOW]: "on: push\n" }), { config: config(), rules });
      expect(result.skipped).toEqual([{ ruleId: "demo/crash", reason: "rule crashed: boom" }]);
      expect(result.diagnostics.map((d) => d.ruleId)).toEqual(["demo/ok"]);
    });

    it("applies configured severity, metadata, and defaults to the descriptor", () => {
      const rule = makeRule("demo/a", (report) => report({ path: WORKFLOW, line: 0, message: "m", suggestion: "s", impact: "high" }), { kind: "insight" });
      const result = lint(input({ [WORKFLOW]: "on: push\n" }), { config: config({ rules: { "demo/a": "error" } }), rules: [rule] });
      expect(result.diagnostics[0]).toMatchObject<Partial<Diagnostic>>({
        severity: "error",
        ruleset: "demo",
        kind: "insight",
        line: 1,
        column: 1,
        impact: "high",
        confidence: "high",
        suggestion: "s",
        docsUrl: docsUrl("demo/a"),
      });
    });

    it("runs nothing when disabled", () => {
      const result = lint(input({ [WORKFLOW]: "on: push\n" }), { config: config({ enabled: false }), rules: [makeRule("demo/a", at(1))] });
      expect(result.diagnostics).toEqual([]);
      expect(result.rulesRun).toBe(0);
    });

    it("lets presets override extends", () => {
      const strict = makeRule("demo/strict", at(1), { presets: ["strict"] });
      expect(lint(input({ [WORKFLOW]: "on: push\n" }), { config: config(), rules: [strict] }).rulesRun).toBe(0);
      expect(lint(input({ [WORKFLOW]: "on: push\n" }), { config: config(), rules: [strict], presets: ["strict"] }).rulesRun).toBe(1);
    });

    it("drops ignored paths before rules see them and counts only relevant files", () => {
      const seen: string[] = [];
      const rule = makeRule("demo/a", (_report, analysis) => seen.push(...analysis.files.map((f) => f.path)));
      const result = lint(
        input({ [WORKFLOW]: "on: push\n", "vendor/lib/package.json": "{}", "README.md": "# hi", Dockerfile: "FROM x", "package.json": "{}" }),
        { config: config({ ignorePaths: ["vendor"] }), rules: [rule] },
      );
      expect(seen).not.toContain("vendor/lib/package.json");
      expect(seen).toContain("README.md");
      expect(result.filesAnalyzed).toBe(3);
    });

    it("sorts by path, line, column, and rule", () => {
      const rule = (id: string, path: string, line: number, column: number) => makeRule(id, (report) => report({ path, line, column, message: id }));
      const result = lint(input({}), {
        config: config(),
        rules: [rule("demo/z", "b.yml", 1, 1), rule("demo/y", "a.yml", 2, 1), rule("demo/x", "a.yml", 2, 1), rule("demo/w", "a.yml", 1, 5)],
      });
      expect(result.diagnostics.map((d) => `${d.path}:${d.line}:${d.column}:${d.ruleId}`)).toEqual([
        "a.yml:1:5:demo/w",
        "a.yml:2:1:demo/x",
        "a.yml:2:1:demo/y",
        "b.yml:1:1:demo/z",
      ]);
    });

    it("reports YAML parse problems", () => {
      const result = lint(input({ [WORKFLOW]: "jobs: [unclosed\n" }), { config: config(), rules: [] });
      expect(result.parseProblems[0]?.path).toBe(WORKFLOW);
    });
  });

  describe("change scoping", () => {
    const rules = [
      makeRule("demo/a", (report) => {
        report({ path: WORKFLOW, line: 1, message: "changed" });
        report({ path: "Dockerfile", line: 1, message: "untouched" });
      }),
    ];
    const files = { [WORKFLOW]: "on: push\n", Dockerfile: "FROM node:22\n" };
    const change = { event: "pull_request" as const, changedPaths: [WORKFLOW] };

    it("leaves scope unset without a change context", () => {
      expect(lint(input(files), { config: config(), rules }).diagnostics.every((d) => d.scope === undefined)).toBe(true);
    });

    it("marks findings in changed files", () => {
      const result = lint(input(files, { change }), { config: config(), rules });
      expect(result.diagnostics.map((d) => [d.path, d.scope])).toEqual([
        [WORKFLOW, "changed-file"],
        ["Dockerfile", "existing"],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    });

    it("marks findings missing from the base revision as introduced", () => {
      const base = new Set([fingerprint("demo/a", "Dockerfile", "untouched")]);
      const result = lint(input(files, { change }), { config: config(), rules, baseFingerprints: base });
      const scopes = Object.fromEntries(result.diagnostics.map((d) => [d.path, d.scope]));
      expect(scopes).toEqual({ [WORKFLOW]: "introduced", Dockerfile: "existing" });
    });
  });

  it("thresholds compare severities", () => {
    const d = (severity: Diagnostic["severity"]) => ({ severity }) as Diagnostic;
    expect(exceedsThreshold([d("warn")], "error")).toBe(false);
    expect(exceedsThreshold([d("warn")], "warn")).toBe(true);
    expect(exceedsThreshold([d("info")], "info")).toBe(true);
    expect(exceedsThreshold([d("error")], "never")).toBe(false);
    expect(exceedsThreshold([], "info")).toBe(false);
    expect(atLeast("error", "warn")).toBe(true);
    expect(atLeast("info", "warn")).toBe(false);
  });

  it("builds docs anchors from rule ids", () => {
    expect(docsUrl("workflow/job-timeout")).toMatch(/docs\/rules\.md#workflow-job-timeout$/);
  });
});
