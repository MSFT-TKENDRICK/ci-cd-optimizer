import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import { defineRule, expandedJobSteps, stepLine } from "../helpers.js";
import { isTrue, listOf, usesAction } from "./shared.js";

/** Triggers whose runs never execute in the default branch's cache scope. */
const PR_SCOPED_TRIGGERS = new Set(["pull_request", "merge_group"]);

const SAVE_ACTIONS = ["actions/cache", "actions/cache/save"];

/** True when every trigger of the workflow saves caches into a pull-request (or merge-queue) ref scope. */
function pullRequestOnly(workflow: WorkflowModel): boolean {
  return (
    workflow.kind === "workflow" &&
    workflow.triggers.some((trigger) => trigger.event === "pull_request") &&
    workflow.triggers.every((trigger) => PR_SCOPED_TRIGGERS.has(trigger.event))
  );
}

function text(step: StepModel, input: string): string | undefined {
  const value = step.with.get(input)?.value;
  return typeof value === "string" ? value : undefined;
}

const normalize = (entry: string): string => entry.replace(/^\.\//, "").replace(/\/+$/, "");

/** Literal, non-negated `path:` entries; undefined when the path is missing or computed by an expression. */
function pathEntries(step: StepModel): Set<string> | undefined {
  const path = step.with.get("path");
  if (path?.kind !== "literal" || typeof path.value !== "string") return undefined;
  return new Set(listOf(path.value).filter((entry) => !entry.startsWith("!")).map(normalize));
}

/** Another workflow saves (or may save) the same cache, so the default branch can already have a copy. */
function savedElsewhere(project: ProjectModel, step: StepModel): boolean {
  const paths = pathEntries(step);
  const key = text(step, "key");
  return project.workflows.some(
    (workflow) =>
      workflow.kind === "workflow" &&
      !pullRequestOnly(workflow) &&
      workflow.jobs.some((job: JobModel) =>
        expandedJobSteps(project, workflow, job).some(({ step: candidate }) => {
          if (!usesAction(candidate, ...SAVE_ACTIONS)) return false;
          const candidatePaths = pathEntries(candidate);
          if (!paths || !candidatePaths || paths.size === 0 || candidatePaths.size === 0) return true;
          return text(candidate, "key") === key || [...paths].some((entry) => candidatePaths.has(entry));
        }),
      ),
  );
}

/** A remote reusable workflow called from a non-PR workflow may save any cache; the rule cannot see it. */
function opaqueCallers(project: ProjectModel): boolean {
  return project.workflows.some(
    (workflow) =>
      workflow.kind === "workflow" &&
      !pullRequestOnly(workflow) &&
      workflow.jobs.some((job) => job.uses !== undefined && !job.uses.value.trim().startsWith("./")),
  );
}

function block(name: string, value: string, indent: string): string[] {
  const lines = value.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.length <= 1 ? [`${indent}${name}: ${value.trim()}`] : [`${indent}${name}: |`, ...lines.map((line) => `${indent}  ${line.trim()}`)];
}

export default defineRule({
  meta: {
    id: "caching/pr-branch-cache-save",
    ruleset: "caching",
    description: "A workflow that only runs on `pull_request` saves caches no other pull request or branch can restore.",
    rationale:
      "GitHub scopes a cache saved by a `pull_request` run to the pull request's merge ref (`refs/pull/<n>/merge`): it cannot be restored by the base branch or by other pull requests. Only runs in the default branch's scope (for example `push` to `main`) create caches every pull request can restore. When the only workflow that saves a cache runs on `pull_request`, the default branch never has a copy, so the first run of every new pull request misses, and each pull request's private copy still counts toward the repository's cache storage limit (10 GB by default), where it can evict the caches that are actually shared.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["insights", "strict"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy",
      "https://github.com/actions/cache/blob/main/tips-and-workarounds.md#use-cache-across-feature-branches",
      "https://github.com/actions/cache/blob/main/tips-and-workarounds.md#force-deletion-of-caches-overriding-default-cache-eviction-policy",
    ],
    impact: "medium",
    fixable: false,
    example: {
      bad: "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/cache@v6\n        with:\n          path: ~/.npm\n          key: npm-${{ hashFiles('package-lock.json') }}",
      good: "on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/cache@v6\n        with:\n          path: ~/.npm\n          key: npm-${{ hashFiles('package-lock.json') }}",
    },
  },
  check({ project, report }) {
    if (opaqueCallers(project)) return;
    for (const workflow of project.workflows) {
      if (!pullRequestOnly(workflow)) continue;
      const file = project.files.get(workflow.path);
      // `cache-mode` overrides the trigger's default cache access; leave those workflows to their author.
      if (!file || /^\s*cache-mode\s*:/m.test(file.content)) continue;
      const events = workflow.triggers.map((trigger) => `\`${trigger.event}\``).join(" and ");
      for (const job of workflow.jobs) {
        for (const step of job.steps) {
          if (!usesAction(step, ...SAVE_ACTIONS) || step.uses?.kind !== "literal") continue;
          if (usesAction(step, "actions/cache") && isTrue(step.with.get("lookup-only")?.value)) continue;
          const key = text(step, "key");
          const path = text(step, "path");
          if (key === undefined || path === undefined || savedElsewhere(project, step)) continue;
          const action = step.uses.action.name ?? "actions/cache";
          const restoreKeys = text(step, "restore-keys");
          const suggestion = [
            "Save this cache from the default branch, where every pull request can restore it. Either run this workflow on pushes to the default branch as well:",
            "",
            "on:",
            "  pull_request:",
            "  push:",
            "    branches: [main]",
            "",
            "or keep this workflow pull-request-only, make its step restore-only:",
            "",
            "- uses: actions/cache/restore@v6",
            "  with:",
            ...block("path", path, "    "),
            ...block("key", key, "    "),
            ...(restoreKeys !== undefined ? block("restore-keys", restoreKeys, "    ") : []),
            "",
            "and save it from a workflow that runs on `push` to the default branch:",
            "",
            "- uses: actions/cache/save@v6",
            "  with:",
            ...block("path", path, "    "),
            ...block("key", key, "    "),
          ].join("\n");
          report({
            path: workflow.path,
            line: stepLine(step),
            key: `${step.key}:${action}`,
            message: `\`${action}\` saves cache \`${key}\` in a workflow that only runs on ${events}, and no workflow that runs on the default branch saves this cache. A cache saved by a pull request run is scoped to its merge ref (\`refs/pull/<n>/merge\`) and cannot be restored by the base branch or other pull requests, so the first run of every new pull request misses while each pull request's copy counts toward the repository's cache storage limit.`,
            suggestion,
          });
        }
      }
    }
  },
});
