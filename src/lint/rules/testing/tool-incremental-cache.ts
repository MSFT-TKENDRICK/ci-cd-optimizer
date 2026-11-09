import type { StepModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import { defineRule, jobCommands, stepLine } from "../helpers.js";
import { cacheCovers } from "../caching/shared.js";
import { toolInvocation } from "./shared.js";

type Tool = "eslint" | "tsc" | "jest";

const NAMES = new Set<string>(["eslint", "tsc", "jest"]);
const SKIP = new Set(["--version", "-v", "--help", "-h", "--init", "--showConfig", "--print-config", "--watch", "-w", "--watchAll", "--listTests", "--no-cache", "--clearCache"]);

const COVERAGE: Record<Tool, RegExp> = {
  eslint: /eslint|node_modules\/\.cache/i,
  tsc: /tsbuildinfo|tsc|typescript|node_modules\/\.cache/i,
  jest: /jest/i,
};

function tsconfigIncremental(project: ProjectModel): boolean {
  return [...project.files.values()].some(
    (file) => /(^|\/)tsconfig[\w.-]*\.json$/i.test(file.path) && /"(?:incremental|composite)"\s*:\s*true/.test(file.content),
  );
}

function finding(tool: Tool, words: string[], project: ProjectModel): { message: string; suggestion: string } {
  switch (tool) {
    case "eslint":
      return words.some((word) => word === "--cache" || word.startsWith("--cache="))
        ? {
            message: "ESLint runs with `--cache`, but the cache file is not restored between runs, so every run is cold.",
            suggestion: "Point `--cache-location` at a directory (for example node_modules/.cache/eslint/) and restore it with actions/cache.",
          }
        : {
            message: "ESLint lints every file on every run because `--cache` is not used.",
            suggestion: "Add `--cache --cache-strategy content --cache-location node_modules/.cache/eslint/` and restore that directory with actions/cache.",
          };
    case "tsc":
      return words.some((word) => ["--incremental", "-b", "--build", "--composite"].includes(word)) || tsconfigIncremental(project)
        ? {
            message: "tsc builds incrementally, but its .tsbuildinfo output is not restored between runs, so every run is a full check.",
            suggestion: "Restore the .tsbuildinfo file(s) (see `tsBuildInfoFile`) with actions/cache keyed on the lockfile and tsconfig.",
          }
        : {
            message: "tsc re-checks the whole program on every run (no `--incremental` or build mode, and no cached .tsbuildinfo).",
            suggestion: "Enable `incremental` (with an explicit `tsBuildInfoFile`) or use `tsc -b`, and restore the .tsbuildinfo file with actions/cache.",
          };
    case "jest":
      return {
        message: "Jest re-transforms every file on every run because its cache directory is not restored.",
        suggestion: "Set `--cacheDirectory` (or `cacheDirectory` in the Jest config) to a workspace path and restore it with actions/cache.",
      };
  }
}

export default defineRule({
  meta: {
    id: "testing/tool-incremental-cache",
    ruleset: "testing",
    description: "ESLint, tsc and Jest should keep their incremental caches between CI runs.",
    rationale:
      "ESLint (`--cache`), TypeScript (`incremental`/`tsc -b`) and Jest (transform cache) can skip unchanged files, but hosted runners start empty. Persisting their cache files makes repeat runs, including agent iterations on a pull request, proportional to what changed.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://eslint.org/docs/latest/use/command-line-interface#caching",
      "https://www.typescriptlang.org/tsconfig/#incremental",
      "https://jestjs.io/docs/cli#--cachedirectory",
      "https://github.com/actions/cache",
    ],
    impact: "low",
    example: {
      bad: "- run: npm ci\n- run: npx eslint .",
      good:
        "- run: npm ci\n- uses: actions/cache@v4\n  with:\n    path: node_modules/.cache/eslint\n    key: eslint-${{ hashFiles('package-lock.json') }}-${{ github.sha }}\n    restore-keys: eslint-${{ hashFiles('package-lock.json') }}-\n- run: npx eslint . --cache --cache-location node_modules/.cache/eslint/",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        let all: StepModel[] | undefined;
        const seen = new Set<Tool>();
        for (const entry of jobCommands(project, workflow, job)) {
          const words = toolInvocation(entry.command, NAMES);
          const tool = words?.[0] as Tool | undefined;
          if (!words || !tool || seen.has(tool)) continue;
          if (words.slice(1).some((word) => SKIP.has(word) || word.startsWith("--watch"))) continue;
          seen.add(tool);
          all ??= project.expandedSteps(job);
          if (cacheCovers(all, COVERAGE[tool], COVERAGE[tool])) continue;
          report({
            path: workflow.path,
            line: entry.direct ? entry.line : stepLine(entry.owner),
            key: `${job.key}:${tool}`,
            ...finding(tool, words, project),
          });
        }
      }
    }
  },
});
