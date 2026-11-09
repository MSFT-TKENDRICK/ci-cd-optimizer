import { defineRule, isDeployLike } from "../helpers.js";
import { PR_AUTOMATION, runsChecks } from "./shared.js";

/** Activity types that change pull request metadata but not its code. */
const METADATA_TYPES = new Set([
  "edited",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "review_requested",
  "review_request_removed",
  "milestoned",
  "demilestoned",
  "locked",
  "unlocked",
  "auto_merge_enabled",
  "auto_merge_disabled",
]);

/** Expressions that let a job react only to the specific metadata change it cares about. */
const EVENT_FILTER = /github\.event\.(?:action|label\b|changes\b|assignee\b|requested_reviewer\b|pull_request\.labels)|\.labels\b/;

export default defineRule({
  meta: {
    id: "triggers/noisy-pr-types",
    ruleset: "triggers",
    description: "Do not re-run build and test workflows on pull request metadata events such as labels or edits.",
    rationale:
      "Activity types like `edited`, `labeled`, and `assigned` fire when a title, label, or assignee changes, not when code changes. Build and test workflows that listen for them repeat identical work on the same commit, and triage bots or agents that relabel pull requests can trigger several full runs in a row. Listening only for code activity, or filtering the jobs on the specific action or label, keeps those events cheap.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context",
    ],
    impact: "medium",
    example: {
      bad: "on:\n  pull_request:\n    types: [opened, synchronize, edited, labeled]",
      good: "on:\n  pull_request:\n    types: [opened, synchronize, reopened]",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow" || isDeployLike(workflow)) continue;
      if (PR_AUTOMATION.test(workflow.path) || (workflow.name !== undefined && PR_AUTOMATION.test(workflow.name))) continue;
      if (!workflow.jobs.some((job) => job.uses !== undefined || runsChecks(job))) continue;
      const content = project.files.get(workflow.path)?.content ?? "";
      if (EVENT_FILTER.test(content)) continue;
      for (const event of ["pull_request", "pull_request_target"]) {
        const pr = workflow.triggers.find((candidate) => candidate.event === event);
        const noisy = pr?.types?.filter((type) => METADATA_TYPES.has(type)) ?? [];
        if (!pr || noisy.length === 0) continue;
        report({
          path: workflow.path,
          line: pr.line,
          key: `on.${event}.types`,
          message: `Build/test workflow re-runs on ${event} metadata events (${noisy.join(", ")}) that do not change code.`,
          suggestion:
            "Remove these types so the workflow runs on `opened`, `synchronize`, and `reopened`. If a label or edit really must trigger work, gate the jobs with `if:` on `github.event.action` or the label name so other metadata changes skip them.",
          confidence: "medium",
        });
      }
    }
  },
});
