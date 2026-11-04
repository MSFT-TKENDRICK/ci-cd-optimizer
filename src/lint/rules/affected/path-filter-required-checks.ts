import { field } from "../../parsers/yaml.js";
import type { TriggerModel, WorkflowModel } from "../../parsers/workflow.js";
import { defineRule, isDeployLike } from "../helpers.js";

const PR_EVENTS = ["pull_request", "pull_request_target"];

/** Line of `on.<event>.<key>`, falling back to the trigger's own line. */
function filterLine(workflow: WorkflowModel, trigger: TriggerModel, key: string): number {
  const { source } = workflow;
  const onNode = field(source, source.doc.contents, "on")?.value;
  return field(source, field(source, onNode, trigger.event)?.value, key)?.line ?? trigger.line;
}

export default defineRule({
  meta: {
    id: "affected/path-filter-required-checks",
    ruleset: "affected",
    description: "Pull request workflows should not skip themselves with trigger-level `paths` filters if they provide required checks.",
    rationale:
      "When `paths`/`paths-ignore` skips a pull request workflow, its checks never report and stay Pending, so a pull request that requires them cannot merge. Agents then stall or someone adds a bypass. Running the workflow on every pull request and skipping work with job-level `if:` conditions keeps the speed benefit: skipped jobs report success, and an always-run gate job gives branch protection one stable check.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore",
      "https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks#handling-skipped-but-required-checks",
      "https://github.com/dorny/paths-filter",
    ],
    impact: "medium",
    example: {
      bad: "on:\n  pull_request:\n    paths: ['api/**']",
      good:
        "on: pull_request\njobs:\n  changes:\n    permissions: { pull-requests: read }\n    outputs: { api: ${{ steps.filter.outputs.api }} }\n    steps:\n      - id: filter\n        uses: dorny/paths-filter@v4\n        with: { filters: 'api: [api/**]' }\n  test:\n    needs: changes\n    if: needs.changes.outputs.api == 'true'\n  ci-ok:\n    needs: [changes, test]\n    if: always()\n    steps:\n      - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')\n        run: exit 1",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow" || isDeployLike(workflow)) continue;
      for (const trigger of workflow.triggers) {
        if (!PR_EVENTS.includes(trigger.event)) continue;
        for (const [key, values] of [
          ["paths", trigger.paths],
          ["paths-ignore", trigger.pathsIgnore],
        ] as const) {
          if (values === undefined) continue;
          report({
            path: workflow.path,
            line: filterLine(workflow, trigger, key),
            key: `on.${trigger.event}.${key}`,
            message: `\`${trigger.event}\` runs are filtered by \`${key}\`; if this workflow provides a required status check, pull requests that skip it leave the check Pending and cannot merge.`,
            suggestion:
              "Trigger on every pull request and move the filter into the workflow: a `changes` job (`dorny/paths-filter@v4` with `pull-requests: read`, or `git diff --name-only`) exposes outputs that gate the expensive jobs through job-level `if:`, and an always-run gate job (`if: always()`, `needs:` every job, failing when any result is `failure` or `cancelled`) is the single required check. Skipped jobs count as successful, so the gate passes when nothing relevant changed.",
            confidence: "medium",
          });
        }
      }
    }
  },
});
