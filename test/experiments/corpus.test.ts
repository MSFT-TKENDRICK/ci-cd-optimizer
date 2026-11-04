import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as api from "../../src/lint/api.js";
import { evaluateCorpus, loadCorpus, loadEngine, parseCase, type CorpusCase, type EngineModule } from "../../src/experiments/corpus.js";
import type { Diagnostic, LintResult } from "../../src/lint/types.js";

const diagnostic = (ruleId: string, path: string, line: number, fix = false): Diagnostic =>
  ({
    ruleId,
    ruleset: ruleId.split("/")[0],
    severity: "warn",
    message: ruleId,
    path,
    line,
    impact: "medium",
    confidence: "high",
    fingerprint: `${ruleId}:${path}:${line}`,
    docsUrl: "",
    kind: "finding",
    ...(fix ? { fix: { description: "fix", edits: [{ path, start: 0, end: 1, text: "X" }] } } : {}),
  }) as unknown as Diagnostic;

function fakeEngine(lintImpl: (files: { path: string; content: string }[]) => Diagnostic[]): EngineModule {
  return {
    ENGINE_API_VERSION: 1,
    lint: ({ input }) => ({ diagnostics: lintImpl(input.files), skipped: [], parseProblems: [], filesAnalyzed: input.files.length, rulesRun: 1, suppressed: 0, durationMs: 0 }) as LintResult,
    applyFixes: (files, diagnostics) => {
      const map = new Map(files.map((file) => [file.path, file.content]));
      for (const d of diagnostics) map.set(d.path, `X${(map.get(d.path) ?? "").slice(1)}`);
      return { files: map, applied: diagnostics, conflicts: [] };
    },
  };
}

const testCase = (overrides: Partial<CorpusCase> = {}): CorpusCase => ({
  id: "case",
  description: "",
  rules: ["a/one"],
  expected: [{ rule: "a/one", path: "f.yml", line: 1 }],
  files: [{ path: "f.yml", content: "abc" }],
  inventoryComplete: true,
  ...overrides,
});

describe("evaluateCorpus", () => {
  it("counts true positives, false positives, false negatives, and out-of-scope findings", () => {
    const engine = fakeEngine(() => [diagnostic("a/one", "f.yml", 1), diagnostic("a/one", "f.yml", 9), diagnostic("b/other", "f.yml", 2)]);
    const report = evaluateCorpus(engine, [testCase(), testCase({ id: "missed", expected: [{ rule: "a/one", path: "g.yml" }] })], { timingRuns: 1 });
    expect(report.totals).toMatchObject({ tp: 1, fp: 3, fn: 1, cases: 2, errors: 0 });
    expect(report.metrics.precision).toBe(0.25);
    expect(report.metrics.recall).toBe(0.5);
    expect(report.metrics.f1).toBeCloseTo(0.3333, 4);
    expect(report.cases[1]?.falseNegatives).toEqual([{ rule: "a/one", path: "g.yml" }]);
  });

  it("treats empty denominators as perfect and scores clean '*' cases", () => {
    const report = evaluateCorpus(fakeEngine(() => []), [testCase({ rules: ["*"], expected: [] })], { timingRuns: 1 });
    expect(report.metrics).toMatchObject({ precision: 1, recall: 1, f1: 1, fixRate: 1 });
    const noisy = evaluateCorpus(fakeEngine(() => [diagnostic("z/any", "f.yml", 1)]), [testCase({ rules: ["*"], expected: [] })], { timingRuns: 1 });
    expect(noisy.metrics.precision).toBe(0);
  });

  it("measures how many true positives an autofix resolves", () => {
    const engine = fakeEngine((files) => (files[0]?.content.startsWith("X") ? [] : [diagnostic("a/one", "f.yml", 1, true)]));
    expect(evaluateCorpus(engine, [testCase()], { timingRuns: 1 }).totals).toMatchObject({ fixable: 1, fixed: 1 });
    const wrongOutput = evaluateCorpus(engine, [testCase({ fixed: { "f.yml": "expected" } })], { timingRuns: 1 });
    expect(wrongOutput.totals).toMatchObject({ fixable: 1, fixed: 0 });
    expect(wrongOutput.metrics.fixRate).toBe(0);
  });

  it("scores a crashing engine as missing everything", () => {
    const engine = fakeEngine(() => {
      throw new Error("boom");
    });
    const report = evaluateCorpus(engine, [testCase()], { timingRuns: 1 });
    expect(report.totals).toMatchObject({ tp: 0, fn: 1, errors: 1 });
    expect(report.cases[0]?.error).toBe("boom");
  });

  it("reports the median lint duration", () => {
    let tick = 0;
    const times = [0, 10, 100, 130, 200, 205];
    const report = evaluateCorpus(fakeEngine(() => []), [testCase()], { timingRuns: 3, now: () => times[tick++] ?? 0 });
    expect(report.metrics.durationMs).toBe(10);
  });

  it("works against the real engine", () => {
    const real = testCase({
      rules: ["hermeticity/pin-runner"],
      expected: [{ rule: "hermeticity/pin-runner", path: ".github/workflows/ci.yml" }],
      files: [{ path: ".github/workflows/ci.yml", content: "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n" }],
    });
    const report = evaluateCorpus(api, [real], { timingRuns: 1 });
    expect(report.totals).toMatchObject({ tp: 1, fp: 0, fn: 0, fixable: 1, fixed: 1 });
  });
});

describe("corpus loading", () => {
  const dirs: string[] = [];
  afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

  it("parses case metadata, scope, and change context", () => {
    const parsed = parseCase(
      "c1",
      "description: d\nrules: [x/extra]\nexpected:\n  - { rule: x/one, path: a.yml, line: 3 }\ninventoryComplete: false\nchange: { event: pull_request, changedPaths: [a.yml], baseSha: abc }\n",
      [],
    );
    expect(parsed).toMatchObject({
      id: "c1",
      rules: ["x/extra", "x/one"],
      expected: [{ rule: "x/one", path: "a.yml", line: 3 }],
      inventoryComplete: false,
      change: { event: "pull_request", changedPaths: ["a.yml"], baseSha: "abc" },
    });
    expect(parseCase("c2", "description: clean\n", []).rules).toEqual(["*"]);
    expect(() => parseCase("bad", "expected: [{ rule: x }]", [])).toThrow(/rule and path/);
  });

  it("loads cases and their files from disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "corpus-"));
    dirs.push(root);
    await mkdir(join(root, "one", "files", ".github", "workflows"), { recursive: true });
    await writeFile(join(root, "one", "case.yml"), "expected:\n  - { rule: a/b, path: .github/workflows/ci.yml }\n");
    await writeFile(join(root, "one", "files", ".github", "workflows", "ci.yml"), "on: push\n");
    await mkdir(join(root, "two"));
    await writeFile(join(root, "two", "case.yml"), "description: empty\n");
    const cases = await loadCorpus(root);
    expect(cases.map((c) => [c.id, c.files.map((f) => f.path)])).toEqual([
      ["one", [".github/workflows/ci.yml"]],
      ["two", []],
    ]);
  });

  it("loads an engine build and checks its API version", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "engine-")));
    dirs.push(root);
    const good = join(root, "good.mjs");
    await writeFile(good, "export const ENGINE_API_VERSION = 1; export function lint() {} export function applyFixes() {}\n");
    await expect(loadEngine(good, 1)).resolves.toMatchObject({ ENGINE_API_VERSION: 1 });
    await expect(loadEngine(good, 2)).rejects.toThrow(/API v1/);
    const partial = join(root, "partial.mjs");
    await writeFile(partial, "export const ENGINE_API_VERSION = 1;\n");
    await expect(loadEngine(partial, 1)).rejects.toThrow(/missing/);
  });
});
