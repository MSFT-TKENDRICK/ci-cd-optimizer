import type { JobModel, WorkflowModel } from "../../parsers/workflow.js";
import { trigger } from "../../parsers/workflow.js";
import { defineRule, isDeployLike } from "../helpers.js";
import { CODE_TYPES, ancestors, matrixSize } from "./shared.js";

const DRAFT = /\bdraft\b/;

function expensiveReason(job: JobModel, maxSteps: number, maxTimeout: number): string | undefined {
  if (job.uses) return undefined;
  if (job.matrix && "__expression" in job.matrix) return "dynamic matrix";
  const size = matrixSize(job);
  if (size !== undefined && size >= 2) return `${size}-leg matrix`;
  if (job.steps.length > maxSteps) return `${job.steps.length} steps`;
  const timeout = job.timeoutMinutes;
  if (timeout?.kind === "literal" && typeof timeout.value === "number" && timeout.value > maxTimeout) {
    return `${timeout.value}-minute timeout`;
  }
  return undefined;
}

function skipsDrafts(workflow: WorkflowModel, job: JobModel): boolean {
  return [job, ...ancestors(workflow, job)].some((candidate) => candidate.if !== undefined && DRAFT.test(candidate.if));
}

export default defineRule({
  meta: {
    id: "triggers/draft-pr-gating",
    ruleset: "triggers",
    description: "Skip expensive pull request jobs while the pull request is still a draft.",
    rationale:
      "Coding agents typically open a draft pull request early and push many intermediate commits before asking for review. Every push re-runs the full pull request workflow, so matrices and long suites burn minutes on work nobody will look at yet. Gating the expensive jobs on `github.event.pull_request.draft == false` and listening for `ready_for_review` keeps fast feedback on drafts while running the heavy checks exactly once the change is ready.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: { maxSteps: 10, maxTimeout: 15 },
    validateOptions: (options) =>
      Object.entries(options)
        .filter(([, value]) => typeof value !== "number" || value <= 0)
        .map(([key]) => `${key} must be a positive number`),
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request",
      "https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request",
    ],
    impact: "medium",
    example: {
      bad: "on: pull_request\njobs:\n  test:\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]",
      good: "on:\n  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\njobs:\n  test:\n    if: github.event.pull_request.draft == false\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]",
    },
  },
  check({ project, options, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow" || isDeployLike(workflow)) continue;
      const pr = trigger(workflow, "pull_request");
      if (!pr) continue;
      if (pr.types?.includes("ready_for_review")) continue;
      if (pr.types && !pr.types.some((type) => CODE_TYPES.has(type))) continue;
      const expensive = workflow.jobs.flatMap((job) => {
        const reason = expensiveReason(job, options.maxSteps, options.maxTimeout);
        return reason && !skipsDrafts(workflow, job) ? [{ job, reason }] : [];
      });
      if (expensive.length === 0) continue;
      const list = expensive.map(({ job, reason }) => `"${job.id}" (${reason})`).join(", ");
      report({
        path: workflow.path,
        line: pr.line,
        key: "on.pull_request",
        message: `Expensive jobs run on every push to draft pull requests: ${list}.`,
        suggestion:
          "Add `if: github.event.pull_request.draft == false` to the expensive jobs (or to a job they all need) and include `ready_for_review` in `on.pull_request.types` alongside `opened`, `synchronize`, and `reopened` so they run once the pull request is marked ready.",
        related: expensive.map(({ job }) => ({ path: workflow.path, line: job.line })),
        confidence: "medium",
      });
    }
  },
});
