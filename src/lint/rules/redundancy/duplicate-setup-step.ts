import type { StepModel } from "../../parsers/workflow.js";
import { defineRule } from "../helpers.js";
import { setupActionOf, withSignature } from "./shared.js";

export default defineRule({
  meta: {
    id: "redundancy/duplicate-setup-step",
    ruleset: "redundancy",
    description: "Review repeated toolchain setup declarations with matching visible inputs.",
    rationale:
      "Repeated setup declarations may add avoidable work, but tool caches can avoid downloads and intervening steps can change the environment or toolchain. Matching visible inputs alone does not establish that the second setup is redundant. Verify conditions, outputs and environment requirements before removing it.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: ["https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idsteps"],
    impact: "low",
    example: {
      bad: "steps:\n  - uses: actions/setup-node@v4\n    with:\n      node-version: 22\n  - run: npm ci\n  - uses: actions/setup-node@v4\n    with:\n      node-version: 22",
      good: "steps:\n  - uses: actions/setup-node@v4\n    with:\n      node-version: 22\n  - run: npm ci",
    },
  },
  check({ project, report }) {
    for (const workflow of [...project.workflows, ...project.actions]) {
      for (const job of workflow.jobs) {
        if (job.uses) continue;
        const seen = new Map<string, StepModel>();
        for (const step of job.steps) {
          const action = setupActionOf(step);
          if (!action) continue;
          const signature = `${action}\u0000${withSignature(step)}\u0000${step.if ?? ""}`;
          const first = seen.get(signature);
          if (!first) {
            seen.set(signature, step);
            continue;
          }
          // A step with an id is likely referenced through `steps.<id>.outputs`; leave it alone.
          if (step.id !== undefined) continue;
          report({
            path: workflow.path,
            line: step.line,
            key: `${step.key}.duplicate-setup`,
            message: `Job "${job.id}" declares ${action} again with matching visible inputs to the step on line ${first.line}.`,
            suggestion: "Before removing the repeated setup, verify conditions, referenced outputs and any toolchain or environment changes between the steps.",
            related: [{ path: workflow.path, line: first.line }],
          });
        }
      }
    }
  },
});
