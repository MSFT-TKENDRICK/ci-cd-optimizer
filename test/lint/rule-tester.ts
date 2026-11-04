import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type LintConfig } from "../../src/lint/config.js";
import { lint } from "../../src/lint/engine.js";
import { applyFixes } from "../../src/lint/fix.js";
import type { AnalysisInput, AnyRule, ChangeContext, Diagnostic, SourceFile } from "../../src/lint/types.js";

export const DEFAULT_PATH = ".github/workflows/ci.yml";

export interface TestCase {
  name?: string;
  /** A string is a workflow at `.github/workflows/ci.yml`; a record maps paths to contents. */
  files: string | Record<string, string>;
  options?: Record<string, unknown>;
  mode?: AnalysisInput["mode"];
  inventoryComplete?: boolean;
  change?: ChangeContext;
}

export interface ExpectedError {
  line?: number;
  path?: string;
  messageIncludes?: string;
}

export interface InvalidCase extends TestCase {
  errors: ExpectedError[] | number;
  /** Expected file contents after applying all fixes (path -> content, or a string for the default path). */
  output?: string | Record<string, string>;
}

export function toFiles(files: TestCase["files"]): SourceFile[] {
  const record = typeof files === "string" ? { [DEFAULT_PATH]: files } : files;
  return Object.entries(record).map(([path, content]) => ({ path, content }));
}

export function runRule(rule: AnyRule, testCase: TestCase): Diagnostic[] {
  const config: LintConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    extends: [],
    ignorePaths: [],
    rules: { [rule.meta.id]: [rule.meta.defaultSeverity, testCase.options ?? {}] },
  };
  const mode = testCase.mode ?? "repository";
  const result = lint(
    {
      files: toFiles(testCase.files),
      mode,
      inventoryComplete: testCase.inventoryComplete ?? mode === "repository",
      ...(testCase.change ? { change: testCase.change } : {}),
    },
    { config, rules: [rule] },
  );
  const crash = result.skipped.find((skip) => skip.reason.startsWith("rule crashed"));
  if (crash) throw new Error(`${rule.meta.id} ${crash.reason}`);
  return result.diagnostics;
}

function describeCase(testCase: TestCase, index: number): string {
  if (testCase.name) return testCase.name;
  const text = typeof testCase.files === "string" ? testCase.files : Object.keys(testCase.files).join(", ");
  return `#${index}: ${text.replace(/\s+/g, " ").slice(0, 70)}`;
}

/** ESLint-style rule tester for vitest. */
export function ruleTester(rule: AnyRule, cases: { valid: TestCase[]; invalid: InvalidCase[] }): void {
  describe(rule.meta.id, () => {
    it("has complete metadata", () => {
      expect(rule.meta.id).toMatch(/^[a-z]+\/[a-z0-9-]+$/);
      expect(rule.meta.id.startsWith(`${rule.meta.ruleset}/`)).toBe(true);
      expect(rule.meta.description.length).toBeGreaterThan(10);
      expect(rule.meta.rationale.length).toBeGreaterThan(20);
      expect(rule.meta.references.length).toBeGreaterThan(0);
    });

    describe("valid", () => {
      cases.valid.forEach((testCase, index) => {
        it(describeCase(testCase, index), () => {
          expect(runRule(rule, testCase)).toEqual([]);
        });
      });
    });

    describe("invalid", () => {
      cases.invalid.forEach((testCase, index) => {
        it(describeCase(testCase, index), () => {
          const diagnostics = runRule(rule, testCase);
          if (typeof testCase.errors === "number") {
            expect(diagnostics).toHaveLength(testCase.errors);
          } else {
            expect(diagnostics.map((d) => `${d.path}:${d.line} ${d.message}`)).toHaveLength(testCase.errors.length);
            testCase.errors.forEach((expected, position) => {
              const actual = diagnostics[position];
              expect(actual).toBeDefined();
              if (expected.line !== undefined) expect(actual?.line).toBe(expected.line);
              if (expected.path !== undefined) expect(actual?.path).toBe(expected.path);
              if (expected.messageIncludes !== undefined) expect(actual?.message).toContain(expected.messageIncludes);
            });
          }
          if (testCase.output !== undefined) {
            const files = toFiles(testCase.files);
            const fixed = applyFixes(files, diagnostics).files;
            const expected = typeof testCase.output === "string" ? { [DEFAULT_PATH]: testCase.output } : testCase.output;
            for (const [path, content] of Object.entries(expected)) {
              expect(fixed.get(path) ?? files.find((file) => file.path === path)?.content).toBe(content);
            }
          }
        });
      });
    });
  });
}
