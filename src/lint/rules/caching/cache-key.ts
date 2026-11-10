import type { StepModel } from "../../parsers/workflow.js";
import { commandsOf, defineRule } from "../helpers.js";
import { commandWords, listOf, usesAction } from "./shared.js";

const VOLATILE = /github\.(sha|run_id|run_number|run_attempt)\b/;
const NPM_CI_VERBS = new Set(["ci", "clean-install", "ic", "install-clean", "isntall-clean"]);

function runsNpmCi(step: StepModel): boolean {
  if (/cache-hit/.test(step.if ?? "")) return false;
  return commandsOf(step).some(({ command }) => {
    const [tool, verb] = commandWords(command);
    return tool === "npm" && verb !== undefined && NPM_CI_VERBS.has(verb);
  });
}

export default defineRule({
  meta: {
    id: "caching/cache-key",
    ruleset: "caching",
    description: "actions/cache keys must invalidate when inputs change and still hit between runs.",
    rationale:
      "A static primary key does not encode dependency changes. SHA/run-scoped keys can prevent reuse across different context values, although reruns can reuse a key and Actions cache scope/version, prefix lookup and eviction also affect hits. Whether removing a context is safe depends on the workload's actual dependencies. `formal cache-key` checks only an explicit primary-key string-partition model relative to declared dependencies; it does not prove hits or speedups. Restoring node_modules before an unconditional `npm ci` is usually wasteful because npm ci removes that directory.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/actions/cache#creating-a-cache-key",
      "https://github.com/actions/cache/blob/main/tips-and-workarounds.md#update-a-cache",
      "https://docs.npmjs.com/cli/v11/commands/npm-ci",
    ],
    impact: "medium",
    example: {
      bad: "- uses: actions/cache@v6\n  with:\n    path: node_modules\n    key: deps",
      good: "- uses: actions/cache@v6\n  with:\n    path: ~/.npm\n    key: npm-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}\n    restore-keys: npm-${{ runner.os }}-",
    },
  },
  check({ project, report }) {
    for (const workflow of [...project.workflows, ...project.actions]) {
      for (const job of workflow.jobs) {
        const all = project.expandedSteps(job);
        for (const step of job.steps) {
          const save = usesAction(step, "actions/cache/save");
          if (!save && !usesAction(step, "actions/cache", "actions/cache/restore")) continue;
          const key = step.with.get("key");
          if (key && key.kind === "literal" && key.value !== null && key.value !== undefined && String(key.value).trim() !== "") {
            const text = String(key.value);
            report({
              path: workflow.path,
              line: key.line,
              key: `${step.key}:static-key`,
              message: `Cache key \`${text}\` is static and does not encode dependency changes.`,
              suggestion: "Include a hash of the inputs, e.g. `key: deps-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}`, plus `restore-keys` for partial hits.",
              confidence: /\d/.test(text) ? "medium" : "high",
            });
          } else if (key && typeof key.value === "string" && VOLATILE.test(key.value) && !save && !step.with.has("restore-keys")) {
            const match = VOLATILE.exec(key.value)?.[0] ?? "github.sha";
            report({
              path: workflow.path,
              line: key.line,
              key: `${step.key}:volatile-key`,
              message: `Cache key includes \`${match}\` but has no explicit \`restore-keys\`; different context values can limit cache reuse.`,
              suggestion: "Add `restore-keys` with the key's stable prefix, or key on a hash of the inputs (`hashFiles(...)`) instead.",
            });
          }
          if (save) continue;
          const path = step.with.get("path");
          if (!path || path.kind !== "literal" || typeof path.value !== "string") continue;
          const cachesNodeModules = listOf(path.value).some((entry) => !entry.startsWith("!") && /(^|\/)node_modules\/?$/.test(entry));
          if (!cachesNodeModules) continue;
          const later = all.slice(all.indexOf(step) + 1);
          if (!later.some(runsNpmCi)) continue;
          report({
            path: workflow.path,
            line: path.line,
            key: `${step.key}:node-modules`,
            message: "Caching `node_modules` is wasted because `npm ci` deletes node_modules before installing.",
            suggestion: "Cache `~/.npm` instead (or use `actions/setup-node` with `cache: npm`) and keep `npm ci`.",
          });
        }
      }
    }
  },
});
