import { fix, insertLinesAfter } from "../../fix.js";
import { field } from "../../parsers/yaml.js";
import { defineRule, isDeployLike, isPullRequestWorkflow } from "../helpers.js";

const GROUP = "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}";
const CANCEL = "${{ github.event_name == 'pull_request' }}";

export default defineRule({
  meta: {
    id: "workflow/concurrency",
    ruleset: "workflow",
    description: "Pull request workflows should cancel superseded runs; deploy workflows must not.",
    rationale:
      "Agents push many small commits. Without a concurrency group every push keeps running to completion, wasting runner minutes and delaying feedback. Deploy and release workflows must never cancel in-progress runs.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: ["https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency"],
    impact: "high",
    fixable: true,
    example: {
      bad: "on: [pull_request]\njobs: ...",
      good: `on: [pull_request]\nconcurrency:\n  group: ${GROUP}\n  cancel-in-progress: ${CANCEL}\njobs: ...`,
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      const deploy = isDeployLike(workflow);
      const concurrency = workflow.concurrency;
      if (deploy) {
        const cancels = [concurrency, ...workflow.jobs.map((job) => job.concurrency)].find((entry) => {
          const value = entry?.value as { "cancel-in-progress"?: unknown } | undefined;
          return value && typeof value === "object" && value["cancel-in-progress"] === true;
        });
        if (cancels) {
          report({
            path: workflow.path,
            line: cancels.line,
            key: "deploy-cancel",
            message: "Deploy/release workflow cancels in-progress runs, which can interrupt a deployment midway.",
            suggestion: "Use a concurrency group without `cancel-in-progress` (queue deployments) for deploy workflows.",
            impact: "high",
          });
        }
        continue;
      }
      if (!isPullRequestWorkflow(workflow) || concurrency) continue;
      if (workflow.jobs.length > 0 && workflow.jobs.every((job) => job.concurrency)) continue;
      const file = project.files.get(workflow.path);
      const jobsField = field(workflow.source, workflow.source.doc.contents, "jobs");
      report({
        path: workflow.path,
        line: workflow.triggersLine,
        key: "missing",
        message: "Pull request workflow has no concurrency group, so superseded pushes keep running.",
        suggestion: `Add a workflow-level \`concurrency\` group keyed by PR number with \`cancel-in-progress: ${CANCEL}\`.`,
        ...(file && jobsField && jobsField.origin === "direct"
          ? {
              fix: fix(
                "Cancel superseded pull request runs",
                insertLinesAfter(file, jobsField.line - 1, [
                  "concurrency:",
                  `  group: ${GROUP}`,
                  `  cancel-in-progress: ${CANCEL}`,
                  "",
                ]),
              ),
            }
          : {}),
      });
    }
  },
});
