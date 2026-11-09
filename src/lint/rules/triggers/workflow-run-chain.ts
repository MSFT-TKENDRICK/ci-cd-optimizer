import { hasTrigger, trigger, type WorkflowModel } from "../../parsers/workflow.js";
import { field, toJS } from "../../parsers/yaml.js";
import { defineRule } from "../helpers.js";

/** Events whose upstream runs may carry untrusted fork code; chaining is then a deliberate privilege boundary. */
const UNTRUSTED_EVENTS = ["pull_request", "pull_request_target", "issue_comment", "pull_request_review", "pull_request_review_comment"];

function upstreamNames(workflow: WorkflowModel): string[] {
  const on = field(workflow.source, workflow.source.doc.contents, "on");
  const node = field(workflow.source, on?.value, "workflow_run")?.value;
  const value = toJS(workflow.source, field(workflow.source, node, "workflows")?.value);
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.map(String) : [];
}

export default defineRule({
  meta: {
    id: "triggers/workflow-run-chain",
    ruleset: "triggers",
    description: "Avoid chaining workflows with `workflow_run` when the downstream work could be a dependent job.",
    rationale:
      "A `workflow_run` trigger only fires after the upstream workflow finishes, so the downstream work waits for a second queue slot, a fresh runner, and another checkout before it starts. When pull request volume is high those extra hops add minutes to every change and make the run graph harder to follow. Calling the downstream work as a reusable workflow job with `needs:` keeps it in the same run, shares artifacts directly, and starts it the moment its dependencies succeed.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run",
      "https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows",
    ],
    impact: "medium",
    example: {
      bad: "# deploy.yml\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]",
      good: "# ci.yml\njobs:\n  test: ...\n  deploy:\n    needs: test\n    uses: ./.github/workflows/deploy.yml",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      const chained = trigger(workflow, "workflow_run");
      if (!chained) continue;
      if (chained.types && !chained.types.includes("completed")) continue;
      const names = upstreamNames(workflow);
      if (names.length === 0) continue;
      const upstream = names.map((name) =>
        project.workflows.find((candidate) => candidate.kind === "workflow" && (candidate.name ?? candidate.path) === name),
      );
      if (upstream.some((candidate) => candidate === undefined)) continue;
      if (upstream.some((candidate) => candidate !== undefined && hasTrigger(candidate, ...UNTRUSTED_EVENTS))) continue;
      const label = names.map((name) => `"${name}"`).join(", ");
      report({
        path: workflow.path,
        line: chained.line,
        key: "on.workflow_run",
        message: `Workflow waits for ${label} via workflow_run, adding a second queue wait, runner start, and checkout to every run.`,
        suggestion:
          "Turn this workflow into a reusable workflow (`on: workflow_call`) and call it from the upstream workflow as a job with `needs:` on the jobs it depends on; pass build outputs as job outputs or artifacts within the same run.",
        related: upstream.flatMap((candidate) => (candidate ? [{ path: candidate.path, line: candidate.triggersLine }] : [])),
        confidence: "medium",
      });
    }
  },
});
