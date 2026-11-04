import { fix, insertLinesAfter, indentOf } from "../../fix.js";
import { defineRule } from "../helpers.js";

export default defineRule({
  meta: {
    id: "workflow/job-timeout",
    ruleset: "workflow",
    description: "Jobs should set `timeout-minutes` well below the 360 minute default.",
    rationale:
      "A hung job holds a runner (and every dependent job, merge queue entry, and agent loop) for up to six hours. A tight timeout turns hangs into fast, retryable failures.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { defaultMinutes: 30, maxMinutes: 120 },
    validateOptions: (options) =>
      Object.entries(options)
        .filter(([, value]) => typeof value !== "number" || value <= 0)
        .map(([key]) => `${key} must be a positive number`),
    references: ["https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes"],
    impact: "medium",
    fixable: true,
    example: {
      bad: "jobs:\n  test:\n    runs-on: ubuntu-24.04",
      good: "jobs:\n  test:\n    timeout-minutes: 30\n    runs-on: ubuntu-24.04",
    },
  },
  check({ project, options, report }) {
    for (const workflow of project.workflows) {
      const file = project.files.get(workflow.path);
      for (const job of workflow.jobs) {
        if (job.uses) continue;
        const timeout = job.timeoutMinutes;
        if (!timeout) {
          const canFix = file !== undefined && job.runsOn?.origin === "direct";
          report({
            path: workflow.path,
            line: job.line,
            key: job.key,
            message: `Job "${job.id}" has no timeout-minutes and inherits the 360 minute default.`,
            suggestion: `Add \`timeout-minutes: ${options.defaultMinutes}\` (about 2-3x the job's typical duration).`,
            ...(canFix
              ? {
                  fix: fix(
                    `Set timeout-minutes: ${options.defaultMinutes} on job ${job.id}`,
                    insertLinesAfter(file, job.line, [
                      `${indentOf(file.content, job.runsOn?.line ?? job.line + 1)}timeout-minutes: ${options.defaultMinutes}`,
                    ]),
                  ),
                }
              : {}),
          });
          continue;
        }
        if (timeout.kind === "literal" && typeof timeout.value === "number" && timeout.value > options.maxMinutes) {
          report({
            path: workflow.path,
            line: timeout.line,
            key: `${job.key}.timeout-minutes`,
            message: `Job "${job.id}" allows ${timeout.value} minutes, above the configured maximum of ${options.maxMinutes}.`,
            suggestion: "Lower the timeout or split the job so failures surface quickly.",
            impact: "low",
          });
        }
      }
    }
  },
});
