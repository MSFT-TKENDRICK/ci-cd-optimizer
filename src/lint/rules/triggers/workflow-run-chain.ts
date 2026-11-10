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
      "A completed `workflow_run` subscription waits for the upstream workflow, which may include jobs the follow-up does not need. A dependent job can express narrower prerequisites, but it still has scheduling and runner costs; consolidation does not guarantee a faster run. Preserve deliberate privilege boundaries, trigger semantics and artifact dependencies, then measure whether the changed dependency graph reduces waiting.",
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
        message: `Workflow subscribes to ${label} via workflow_run; narrower job dependencies may reduce waiting.`,
        suggestion:
          "If the workflow boundary is not needed, consider a reusable workflow (`on: workflow_call`) called with `needs:` on its actual prerequisites. Preserve permissions, trigger semantics and artifact consumers, and compare the resulting critical path.",
        related: upstream.flatMap((candidate) => (candidate ? [{ path: candidate.path, line: candidate.triggersLine }] : [])),
        confidence: "medium",
      });
    }
  },
});
