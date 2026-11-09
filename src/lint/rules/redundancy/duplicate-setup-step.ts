import type { StepModel } from "../../parsers/workflow.js";
import { defineRule } from "../helpers.js";
import { setupActionOf, withSignature } from "./shared.js";

export default defineRule({
  meta: {
    id: "redundancy/duplicate-setup-step",
    ruleset: "redundancy",
    description: "A job should not run the same toolchain setup action twice with the same inputs.",
    rationale:
      "Running a setup action a second time with identical inputs reinstalls the same toolchain, adds download and cache-restore time to every run, and usually signals a copy-paste mistake that hides which configuration is authoritative.",
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
            message: `Job "${job.id}" runs ${action} again with the same inputs as the step on line ${first.line}.`,
            suggestion: "Remove the repeated setup step; the toolchain from the first step is still on PATH.",
            related: [{ path: workflow.path, line: first.line }],
          });
        }
      }
    }
  },
});
