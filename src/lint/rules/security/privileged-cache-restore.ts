import type { StepModel } from "../../parsers/workflow.js";
import { CACHE_RESTORE_ACTIONS, isFalse } from "../caching/shared.js";
import { defineRule, stepLine } from "../helpers.js";
import { isPrivileged, privilegedTriggers } from "./shared.js";

const CACHE_ACTIONS = new Set([...CACHE_RESTORE_ACTIONS, "actions/cache/save"]);

function cacheUse(step: StepModel): string | undefined {
  const action = step.uses?.action;
  if (action?.kind !== "remote" || action.name === undefined) return undefined;
  if (CACHE_ACTIONS.has(action.name)) return action.name;
  if (/^actions\/setup-[a-z0-9-]+$/.test(action.name)) {
    const cache = step.with.get("cache");
    if (cache === undefined) return undefined;
    const value = cache.value;
    if (value === undefined || value === null || value === "" || isFalse(value)) return undefined;
    return `${action.name} (cache: ${String(value)})`;
  }
  return undefined;
}

export default defineRule({
  meta: {
    id: "security/privileged-cache-restore",
    ruleset: "security",
    description:
      "Workflows triggered by `pull_request_target`, `workflow_run`, or `issue_comment` should not restore or save dependency caches.",
    rationale:
      "The Actions cache is shared across workflows on the same branch scope. A cache entry written by untrusted code (for example a pull request build on the default branch's scope, or a privileged job that ran contributor code) can be restored into a privileged job, which then executes the poisoned binaries with secrets and a write token. Privileged workflows should build from clean inputs.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache",
      "https://docs.github.com/en/actions/reference/security/secure-use",
      "https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/",
    ],
    impact: "medium",
    example: {
      bad: "on: pull_request_target\njobs:\n  label:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@v5\n        with:\n          cache: npm",
      good: "on: pull_request_target\njobs:\n  label:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@v5",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (!isPrivileged(workflow)) continue;
      const triggers = privilegedTriggers(workflow).join(", ");
      for (const job of workflow.jobs) {
        for (const step of job.steps) {
          const use = cacheUse(step);
          if (use === undefined) continue;
          report({
            path: workflow.path,
            line: stepLine(step),
            key: `${step.key}.uses`,
            message: `${use} uses the Actions cache in a workflow triggered by ${triggers}, where a poisoned cache entry would run with elevated privileges.`,
            suggestion:
              "Drop caching from privileged workflows (remove the cache step or the `cache:` input). Keep caching in unprivileged `pull_request`/`push` workflows.",
          });
        }
      }
    }
  },
});
