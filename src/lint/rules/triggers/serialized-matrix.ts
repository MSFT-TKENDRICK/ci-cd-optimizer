import { scalarValue } from "../../parsers/yaml.js";
import { defineRule, isDeployLike } from "../helpers.js";
import { matrixSize, strategyField } from "./shared.js";

export default defineRule({
  meta: {
    id: "triggers/serialized-matrix",
    ruleset: "triggers",
    description: "Avoid throttling a matrix with a `max-parallel` far below its number of legs.",
    rationale:
      "A matrix exists to fan work out across runners. Setting `strategy.max-parallel` to 1, or to a small fraction of the matrix size, turns that fan-out back into a queue: wall-clock time grows with every leg while the total minutes billed stay the same. When agents open many pull requests, that latency stacks up across every change. Serializing is only worth it when legs genuinely contend for a shared resource, which is better expressed with `concurrency` or an environment.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: { maxRatio: 4 },
    validateOptions: (options) =>
      Object.entries(options)
        .filter(([, value]) => typeof value !== "number" || value < 2)
        .map(([key]) => `${key} must be a number of at least 2`),
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstrategymax-parallel",
      "https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations",
    ],
    impact: "medium",
    example: {
      bad: "strategy:\n  max-parallel: 1\n  matrix:\n    node: [18, 20, 22]",
      good: "strategy:\n  matrix:\n    node: [18, 20, 22]",
    },
  },
  check({ project, options, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow" || isDeployLike(workflow)) continue;
      for (const job of workflow.jobs) {
        if (job.uses || job.concurrency || job.environment) continue;
        const size = matrixSize(job);
        if (size === undefined || size < 2) continue;
        const limit = strategyField(workflow, job, "max-parallel");
        const value = scalarValue(limit?.value);
        if (!limit || typeof value !== "number" || !Number.isInteger(value) || value < 1 || value >= size) continue;
        if (value > 1 && size / value < options.maxRatio) continue;
        report({
          path: workflow.path,
          line: limit.line,
          key: `jobs.${job.id}.strategy.max-parallel`,
          message: `Job "${job.id}" runs its ${size} matrix legs at most ${value} at a time, so they queue instead of running in parallel.`,
          suggestion:
            "Remove `max-parallel` (or raise it) so the matrix fans out. If the legs share a scarce resource, guard that with a `concurrency` group or environment instead and document why.",
          confidence: "medium",
        });
      }
    }
  },
});
