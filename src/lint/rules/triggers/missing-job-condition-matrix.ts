import type { JobModel, WorkflowModel } from "../../parsers/workflow.js";
import { defineRule, isDeployLike, isPullRequestWorkflow } from "../helpers.js";
import { CHANGE_ACTIONS, ancestors, matrixSize } from "./shared.js";

function changeJobs(workflow: WorkflowModel): JobModel[] {
  return workflow.jobs.filter((job) => {
    if (job.uses || job.matrix) return false;
    if (!job.steps.some((step) => step.uses?.action.name !== undefined && CHANGE_ACTIONS.has(step.uses.action.name))) return false;
    // Only trust the pattern once another job in the same workflow already gates itself on this job's outputs.
    const outputs = new RegExp(`needs\\.${job.id.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\.outputs\\.`);
    return workflow.jobs.some(
      (other) => other !== job && other.needs.includes(job.id) && other.if !== undefined && outputs.test(other.if),
    );
  });
}

export default defineRule({
  meta: {
    id: "triggers/missing-job-condition-matrix",
    ruleset: "triggers",
    description: "Gate matrix jobs on the workflow's existing change-detection job.",
    rationale:
      "When a workflow already computes which paths a pull request touched and uses that result to skip some jobs, a matrix job that ignores it runs every leg on every pull request, including documentation-only or unrelated changes. Matrices are the most expensive jobs in a workflow, so they gain the most from the same gate. Adding the change job to `needs:` and an `if:` on its outputs lets the matrix skip cleanly when its inputs did not change.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idif",
      "https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/pass-job-outputs",
    ],
    impact: "medium",
    example: {
      bad: "jobs:\n  changes: ...\n  lint:\n    needs: changes\n    if: needs.changes.outputs.src == 'true'\n  test:\n    strategy:\n      matrix:\n        node: [18, 20, 22]",
      good: "jobs:\n  changes: ...\n  test:\n    needs: changes\n    if: needs.changes.outputs.src == 'true'\n    strategy:\n      matrix:\n        node: [18, 20, 22]",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow" || !isPullRequestWorkflow(workflow) || isDeployLike(workflow)) continue;
      const detectors = changeJobs(workflow);
      if (detectors.length === 0) continue;
      for (const job of workflow.jobs) {
        if (job.uses || job.if !== undefined || detectors.includes(job)) continue;
        const size = matrixSize(job);
        if (size === undefined || size < 2) continue;
        const upstream = new Set(ancestors(workflow, job).map((candidate) => candidate.id));
        if (detectors.some((detector) => upstream.has(detector.id))) continue;
        const detector = detectors[0] as JobModel;
        report({
          path: workflow.path,
          line: job.line,
          key: `jobs.${job.id}`,
          message: `Matrix job "${job.id}" (${size} legs) runs on every pull request even though job "${detector.id}" already detects which paths changed.`,
          suggestion: `Add \`needs: ${detector.id}\` and an \`if:\` on \`needs.${detector.id}.outputs.<filter>\` so the matrix skips when its inputs are unchanged.`,
          related: [{ path: workflow.path, line: detector.line }],
          confidence: "medium",
        });
      }
    }
  },
});
