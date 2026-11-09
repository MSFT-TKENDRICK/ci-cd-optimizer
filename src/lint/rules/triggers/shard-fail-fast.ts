import { scalarValue } from "../../parsers/yaml.js";
import { defineRule, isPullRequestWorkflow } from "../helpers.js";
import { strategyField } from "./shared.js";

const SHARD_KEY = /^(?:shard|chunk|partition|split)(?:s|[-_]?(?:index|id|num(?:ber)?|count|total))?$/i;

export default defineRule({
  meta: {
    id: "triggers/shard-fail-fast",
    ruleset: "triggers",
    description: "Let sharded pull request test matrices stop early when one shard fails.",
    rationale:
      "When a test suite is split into shards, each leg runs a slice of the same suite against the same commit. With `fail-fast: false`, a failure in one shard still lets every other shard run to completion, even though the pull request is already red and will need another push. Keeping the default `fail-fast: true` on pull requests cancels the remaining shards and returns those minutes to the queue, which matters most when many agent-authored pull requests are iterating at once.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstrategyfail-fast",
    ],
    impact: "medium",
    example: {
      bad: "strategy:\n  fail-fast: false\n  matrix:\n    shard: [1, 2, 3, 4]",
      good: "strategy:\n  fail-fast: ${{ github.event_name != 'pull_request' }}\n  matrix:\n    shard: [1, 2, 3, 4]",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow" || !isPullRequestWorkflow(workflow)) continue;
      for (const job of workflow.jobs) {
        if (job.uses || !job.matrix || "__expression" in job.matrix) continue;
        const shardKey = Object.keys(job.matrix).find((key) => SHARD_KEY.test(key));
        if (!shardKey) continue;
        const failFast = strategyField(workflow, job, "fail-fast");
        if (!failFast || scalarValue(failFast.value) !== false) continue;
        report({
          path: workflow.path,
          line: failFast.line,
          key: `jobs.${job.id}.strategy.fail-fast`,
          message: `Job "${job.id}" shards its matrix by "${shardKey}" but sets fail-fast: false, so remaining shards keep running after one fails.`,
          suggestion:
            "Drop `fail-fast: false`, or make it conditional (for example `fail-fast: ${{ github.event_name != 'pull_request' }}`) so pull request runs stop at the first failing shard while full runs still report every shard.",
          confidence: "medium",
        });
      }
    }
  },
});
