import { hasTrigger, trigger } from "../../parsers/workflow.js";
import { defineRule, isDeployLike } from "../helpers.js";

/** Pull-request automation (labelers, triaging, greetings) is never a required merge check. */
const PR_AUTOMATION = /label(?:l)?er|labels|triage|stale|greet|welcome|assign|auto-?merge|release-drafter|semantic-pr|pr-title/i;
/** Activity types that run when a PR's code changes; required checks must run on these. */
const CODE_TYPES = new Set(["opened", "synchronize", "reopened"]);

export default defineRule({
  meta: {
    id: "workflow/merge-group",
    ruleset: "workflow",
    description: "CI workflows that run on `pull_request` should also run on `merge_group`.",
    rationale:
      "Agent-heavy repositories open and merge many pull requests at once, so a merge queue is the only practical way to keep the default branch green without serial rebases. A merge queue waits for the required checks to report on the `merge_group` event; a required-check workflow that only listens to `pull_request` never runs there, so queued pull requests stall until they time out.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue#triggering-merge-group-checks-with-github-actions",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group",
    ],
    impact: "medium",
    example: {
      bad: "on:\n  pull_request:",
      good: "on:\n  pull_request:\n  merge_group:",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      const pullRequest = trigger(workflow, "pull_request");
      if (!pullRequest || hasTrigger(workflow, "merge_group") || isDeployLike(workflow)) continue;
      if (pullRequest.types && !pullRequest.types.some((type) => CODE_TYPES.has(type))) continue;
      if (PR_AUTOMATION.test(`${workflow.path} ${workflow.name ?? ""}`)) continue;
      const runsChecks = workflow.jobs.some(
        (job) =>
          job.uses !== undefined ||
          job.steps.some((step) => step.run !== undefined || step.uses?.action.kind === "local" || step.uses?.action.name === "actions/checkout"),
      );
      if (!runsChecks) continue;
      report({
        path: workflow.path,
        line: pullRequest.line,
        key: "on.merge_group",
        message:
          "Workflow runs on pull_request but not merge_group; if it provides a required check, pull requests in a merge queue wait for a check that never runs.",
        suggestion:
          "Add `merge_group:` next to `pull_request:` under `on:` so the same checks run on the queue's temporary branch. Steps that diff against the base should use `github.event.merge_group.base_sha` for merge_group events.",
        confidence: "medium",
      });
    }
  },
});
