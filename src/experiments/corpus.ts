import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import type { LintConfig } from "../lint/config.js";
import type { AnalysisInput, ChangeContext, Diagnostic, LintResult, Preset, SourceFile } from "../lint/types.js";

/**
 * The benchmark corpus is the experiment's ground truth. Each case is a directory:
 *
 *   corpus/<case>/case.yml   description, expected findings, optional scope / change context / fixed contents
 *   corpus/<case>/files/**   the repository snapshot that is linted
 *
 * Arms cannot modify the corpus (it is a protected path); new cases for a hypothesis land on the experiment trunk
 * before arms branch, so every arm and the control are scored against the same trusted benchmark.
 */
export interface ExpectedFinding {
  rule: string;
  path: string;
  line?: number;
}

export interface CorpusCase {
  id: string;
  description: string;
  /** Rules whose findings are scored. Defaults to the rules named in `expected`; `["*"]` scores every rule. */
  rules: string[];
  expected: ExpectedFinding[];
  files: SourceFile[];
  inventoryComplete: boolean;
  change?: ChangeContext;
  /** Expected file contents after autofix; mismatches count against the fix rate. */
  fixed?: Record<string, string>;
}

/** The subset of `src/lint/api.ts` the evaluator relies on; arms are loaded through this contract. */
export interface EngineModule {
  ENGINE_API_VERSION: number;
  lint(request: { input: AnalysisInput; config?: LintConfig; presets?: Preset[] }): LintResult;
  applyFixes(files: SourceFile[], diagnostics: Diagnostic[]): { files: Map<string, string>; applied: Diagnostic[]; conflicts: Diagnostic[] };
}

export interface CaseResult {
  id: string;
  tp: number;
  fp: number;
  fn: number;
  fixable: number;
  fixed: number;
  falsePositives: Array<{ rule: string; path: string; line: number }>;
  falseNegatives: ExpectedFinding[];
  error?: string;
}

export interface CorpusMetrics {
  precision: number;
  recall: number;
  f1: number;
  fixRate: number;
  durationMs: number;
}

export interface CorpusReport {
  metrics: CorpusMetrics;
  totals: { tp: number; fp: number; fn: number; fixable: number; fixed: number; cases: number; errors: number };
  cases: CaseResult[];
}

const ratio = (numerator: number, denominator: number) => (denominator === 0 ? 1 : numerator / denominator);
const inScope = (scope: string[], rule: string) => scope.includes("*") || scope.includes(rule);
const toPosix = (path: string) => path.split(sep).join("/");

function match(diagnostics: Diagnostic[], expected: ExpectedFinding[]) {
  const remaining = [...expected];
  const matched: Diagnostic[] = [];
  const unmatched: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const index = remaining.findIndex(
      (finding) => finding.rule === diagnostic.ruleId && finding.path === diagnostic.path && (finding.line === undefined || finding.line === diagnostic.line),
    );
    if (index === -1) unmatched.push(diagnostic);
    else {
      matched.push(diagnostic);
      remaining.splice(index, 1);
    }
  }
  return { matched, unmatched, missed: remaining };
}

function evaluateCase(engine: EngineModule, testCase: CorpusCase): CaseResult {
  const input: AnalysisInput = {
    files: testCase.files,
    mode: "repository",
    inventoryComplete: testCase.inventoryComplete,
    ...(testCase.change ? { change: testCase.change } : {}),
  };
  try {
    const diagnostics = engine.lint({ input, presets: ["all"] }).diagnostics.filter((d) => inScope(testCase.rules, d.ruleId));
    const { matched, unmatched, missed } = match(diagnostics, testCase.expected);

    // Fix rate: share of true positives that an autofix resolves (re-lint no longer reports the rule for the path).
    const fixable = matched.filter((diagnostic) => diagnostic.fix);
    let fixed = 0;
    if (fixable.length > 0) {
      const result = engine.applyFixes(testCase.files, fixable);
      const after = testCase.files.map((file) => ({ path: file.path, content: result.files.get(file.path) ?? file.content }));
      const remaining = engine.lint({ input: { ...input, files: after }, presets: ["all"] }).diagnostics;
      const contentsMatch = Object.entries(testCase.fixed ?? {}).every(([path, content]) => result.files.get(path) === content);
      if (contentsMatch) {
        const pending = [...remaining];
        for (const diagnostic of fixable) {
          const index = pending.findIndex((other) => other.ruleId === diagnostic.ruleId && other.path === diagnostic.path);
          if (index === -1) fixed += 1;
          else pending.splice(index, 1);
        }
      }
    }
    return {
      id: testCase.id,
      tp: matched.length,
      fp: unmatched.length,
      fn: missed.length,
      fixable: fixable.length,
      fixed,
      falsePositives: unmatched.map((d) => ({ rule: d.ruleId, path: d.path, line: d.line })),
      falseNegatives: missed,
    };
  } catch (error) {
    // A crash counts every expected finding as missed so a broken arm cannot look precise.
    return { id: testCase.id, tp: 0, fp: 0, fn: testCase.expected.length, fixable: 0, fixed: 0, falsePositives: [], falseNegatives: testCase.expected, error: (error as Error).message };
  }
}

export function evaluateCorpus(engine: EngineModule, cases: CorpusCase[], options: { timingRuns?: number; now?: () => number } = {}): CorpusReport {
  const now = options.now ?? (() => performance.now());
  const results = cases.map((testCase) => evaluateCase(engine, testCase));
  const timings: number[] = [];
  for (let run = 0; run < Math.max(1, options.timingRuns ?? 3); run += 1) {
    const start = now();
    for (const testCase of cases) {
      try {
        engine.lint({
          input: { files: testCase.files, mode: "repository", inventoryComplete: testCase.inventoryComplete, ...(testCase.change ? { change: testCase.change } : {}) },
          presets: ["all"],
        });
      } catch {
        // Errors are already recorded by evaluateCase.
      }
    }
    timings.push(now() - start);
  }
  timings.sort((a, b) => a - b);
  const sum = (key: "tp" | "fp" | "fn" | "fixable" | "fixed") => results.reduce((total, result) => total + result[key], 0);
  const totals = { tp: sum("tp"), fp: sum("fp"), fn: sum("fn"), fixable: sum("fixable"), fixed: sum("fixed"), cases: results.length, errors: results.filter((r) => r.error).length };
  const precision = ratio(totals.tp, totals.tp + totals.fp);
  const recall = ratio(totals.tp, totals.tp + totals.fn);
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return {
    metrics: {
      precision: round(precision),
      recall: round(recall),
      f1: round(precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)),
      fixRate: round(ratio(totals.fixed, totals.fixable)),
      durationMs: Math.round((timings[Math.floor(timings.length / 2)] ?? 0) * 100) / 100,
    },
    totals,
    cases: results,
  };
}

async function walk(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(root, path) : [toPosix(relative(root, path))];
    }),
  );
  return files.flat().sort();
}

export function parseCase(id: string, text: string, files: SourceFile[]): CorpusCase {
  const raw = (parse(text) ?? {}) as Record<string, unknown>;
  const expected = Array.isArray(raw.expected)
    ? raw.expected.map((entry) => {
        const item = entry as Record<string, unknown>;
        if (typeof item.rule !== "string" || typeof item.path !== "string") throw new Error(`${id}: expected entries need rule and path`);
        return { rule: item.rule, path: item.path, ...(typeof item.line === "number" ? { line: item.line } : {}) };
      })
    : [];
  const declared = Array.isArray(raw.rules) ? raw.rules.filter((rule): rule is string => typeof rule === "string") : [];
  const rules = [...new Set([...declared, ...expected.map((finding) => finding.rule)])];
  const change = raw.change as Record<string, unknown> | undefined;
  return {
    id,
    description: typeof raw.description === "string" ? raw.description : id,
    rules: rules.length > 0 ? rules : ["*"],
    expected,
    files,
    inventoryComplete: raw.inventoryComplete !== false,
    ...(change
      ? {
          change: {
            event: (change.event as ChangeContext["event"]) ?? "pull_request",
            changedPaths: Array.isArray(change.changedPaths) ? (change.changedPaths as string[]) : [],
            ...(typeof change.baseSha === "string" ? { baseSha: change.baseSha } : {}),
            ...(typeof change.headSha === "string" ? { headSha: change.headSha } : {}),
          },
        }
      : {}),
    ...(raw.fixed && typeof raw.fixed === "object" ? { fixed: raw.fixed as Record<string, string> } : {}),
  };
}

export async function loadCorpus(directory: string): Promise<CorpusCase[]> {
  const ids = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return Promise.all(
    ids.map(async (id) => {
      const caseDir = join(directory, id);
      const filesDir = join(caseDir, "files");
      const exists = await stat(filesDir).then((info) => info.isDirectory(), () => false);
      const paths = exists ? await walk(filesDir) : [];
      const files = await Promise.all(paths.map(async (path) => ({ path, content: await readFile(join(filesDir, path), "utf8") })));
      return parseCase(id, await readFile(join(caseDir, "case.yml"), "utf8"), files);
    }),
  );
}

/** Loads an engine build (for example an arm's `dist/lint/api.js`) and checks it speaks the same contract. */
export async function loadEngine(modulePath: string, expectedVersion: number): Promise<EngineModule> {
  const { pathToFileURL } = await import("node:url");
  const engine = (await import(pathToFileURL(modulePath).href)) as Partial<EngineModule>;
  if (engine.ENGINE_API_VERSION !== expectedVersion) {
    throw new Error(`Engine at ${modulePath} speaks API v${String(engine.ENGINE_API_VERSION)}; the evaluator expects v${expectedVersion}.`);
  }
  if (typeof engine.lint !== "function" || typeof engine.applyFixes !== "function") throw new Error(`Engine at ${modulePath} is missing lint/applyFixes.`);
  return engine as EngineModule;
}
