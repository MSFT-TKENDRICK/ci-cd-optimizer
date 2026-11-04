import { hasTrigger, type JobModel, type WorkflowModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import { affectedTooling, defineRule, expandedJobSteps, isDeployLike, isKnownMonorepo, jobCommands } from "../helpers.js";

const CHANGE_ACTIONS = new Set([
  "dorny/paths-filter",
  "tj-actions/changed-files",
  "step-security/changed-files",
  "nrwl/nx-set-shas",
  "technote-space/get-diff-action",
  "jitterbit/get-changed-files",
  "ana06/get-changed-files",
  "trilom/file-changes-action",
  "marceloprado/has-changed-path",
  "yumemi-inc/changed-files",
]);

const DIFF_COMMAND =
  /\bgit\s+diff\b.*\s--name-(?:only|status)\b|\bgit\s+diff\b.*\s--(?:quiet|exit-code)\b.*\s--\s|\bgh\s+pr\s+diff\b|\bgh\s+api\b.*\/pulls\/\S+\/files\b/;

const NEEDS_OUTPUT = /needs\.([\w-]+)\.outputs\.([\w-]+)/g;
const CHANGE_NAME = /chang|affect|filter|path|diff|modif|touch|dirty|skip|should|run[-_]/i;

interface ScopedJob {
  workflow: WorkflowModel;
  job: JobModel;
}

/** Top-level jobs plus the jobs of local reusable workflows; undefined when a job calls a workflow we cannot see. */
function collectJobs(project: ProjectModel, workflow: WorkflowModel, seen: Set<string>): ScopedJob[] | undefined {
  if (seen.has(workflow.path)) return [];
  seen.add(workflow.path);
  const result: ScopedJob[] = [];
  for (const job of workflow.jobs) {
    if (job.uses === undefined) {
      result.push({ workflow, job });
      continue;
    }
    const target = /^\.\/([^@]+)$/.exec(job.uses.value.trim())?.[1];
    const called = target !== undefined ? project.workflows.find((candidate) => candidate.path === target) : undefined;
    const nested = called ? collectJobs(project, called, seen) : undefined;
    if (!nested) return undefined;
    result.push({ workflow, job }, ...nested);
  }
  return result;
}

function consumesChangeOutput(job: JobModel): boolean {
  const text = `${job.if ?? ""} ${job.matrix ? JSON.stringify(job.matrix) : ""}`;
  return [...text.matchAll(NEEDS_OUTPUT)].some((match) => CHANGE_NAME.test(match[1] ?? "") || CHANGE_NAME.test(match[2] ?? ""));
}

function detectsChanges(project: ProjectModel, { workflow, job }: ScopedJob): boolean {
  if (consumesChangeOutput(job)) return true;
  const usesChangeAction = expandedJobSteps(project, workflow, job).some(({ step }) => {
    const action = step.uses?.action;
    return action?.kind === "remote" && action.name !== undefined && CHANGE_ACTIONS.has(action.name);
  });
  if (usesChangeAction) return true;
  return jobCommands(project, workflow, job).some(
    ({ command }) => affectedTooling(command) !== undefined || DIFF_COMMAND.test(command.replace(/["']/g, "")),
  );
}

function runnerHint(project: ProjectModel): string {
  const tools = project.facts.monorepoTools.value;
  if (tools.includes("nx")) return " Inside each job, `nx affected` (with `nrwl/nx-set-shas@v5`) narrows the work further.";
  if (tools.includes("turbo")) return " Inside each job, `turbo run <task> --affected` narrows the work further.";
  return "";
}

export default defineRule({
  meta: {
    id: "affected/change-detection",
    ruleset: "affected",
    description: "Multi-job pull request workflows in a monorepo should skip jobs whose area did not change.",
    rationale:
      "In a monorepo most pull requests touch one area, yet every job still provisions a runner, restores caches, and installs dependencies. A small change-detection job that feeds job-level `if:` conditions skips the unrelated jobs entirely. Agent-driven repositories open many narrow pull requests, so the savings compound, and an always-run gate job keeps branch protection simple because skipped jobs report success.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["agentic", "strict"],
    requires: ["repository"],
    defaultOptions: {},
    references: [
      "https://github.com/dorny/paths-filter",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idif",
      "https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks#handling-skipped-but-required-checks",
    ],
    impact: "medium",
    example: {
      bad: "on: pull_request\njobs:\n  web: ...\n  api: ...",
      good:
        "on: pull_request\njobs:\n  changes:\n    permissions: { pull-requests: read }\n    outputs: { web: ${{ steps.filter.outputs.web }}, api: ${{ steps.filter.outputs.api }} }\n    steps:\n      - id: filter\n        uses: dorny/paths-filter@v4\n        with:\n          filters: |\n            web: [apps/web/**, packages/ui/**]\n            api: [apps/api/**]\n  web:\n    needs: changes\n    if: needs.changes.outputs.web == 'true'\n  api:\n    needs: changes\n    if: needs.changes.outputs.api == 'true'\n  ci-ok:\n    needs: [web, api]\n    if: always()\n    steps:\n      - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')\n        run: exit 1",
    },
  },
  check({ project, report }) {
    if (!isKnownMonorepo(project)) return;
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow" || !hasTrigger(workflow, "pull_request", "pull_request_target")) continue;
      if (workflow.jobs.length < 2 || isDeployLike(workflow)) continue;
      const pathFiltered = workflow.triggers.some(
        (trigger) =>
          (trigger.event === "pull_request" || trigger.event === "pull_request_target") &&
          (trigger.paths !== undefined || trigger.pathsIgnore !== undefined),
      );
      if (pathFiltered) continue;
      const jobs = collectJobs(project, workflow, new Set());
      if (!jobs || jobs.some((entry) => detectsChanges(project, entry))) continue;
      report({
        path: workflow.path,
        line: workflow.triggersLine,
        key: "change-detection",
        message: `This pull request workflow runs all ${workflow.jobs.length} jobs on every change; none of them checks which part of the monorepo changed.`,
        suggestion: `Add a \`changes\` job using \`dorny/paths-filter@v4\` (it reads the pull request diff through the API, so grant \`pull-requests: read\`; no checkout needed) that exposes one output per area, make the other jobs \`needs: changes\` with \`if: needs.changes.outputs.<area> == 'true'\`, and add an always-run gate job (\`if: always()\`, \`needs:\` every job, failing when any result is \`failure\` or \`cancelled\`) as the single required check.${runnerHint(project)}`,
        confidence: "medium",
      });
    }
  },
});
