import { isMap } from "yaml";
import { fix, insertLinesAfter, lineText } from "../../fix.js";
import { lineOfNode } from "../../parsers/yaml.js";
import type { WorkflowModel } from "../../parsers/workflow.js";
import { defineRule, steps, stepsUsing } from "../helpers.js";
import { listOf } from "../caching/shared.js";
import { continueOnErrorTrue, outcomeInspected, stepNode } from "./shared.js";

const DEBUG_PATH = /(^|[/\\])(?:playwright-report|test-results|traces?|videos?|screenshots?|cypress\/(?:videos|screenshots))([/\\*]|$)/i;
const HEAVY_PATH = /(^|[/\\])(?:traces?|videos?|screenshots?|cypress\/(?:videos|screenshots))([/\\*]|$)|\.(?:zip|webm|mp4|png)$/i;
const MACHINE_READABLE = /junit|\.(?:xml|json|trx|sarif|lcov)$|coverage/i;
const SUCCESS_ONLY = /^\s*(?:\$\{\{\s*)?success\(\)\s*(?:\}\}\s*)?$/;
const ALWAYS = /^\s*(?:\$\{\{\s*)?(?:always\(\)|!\s*cancelled\(\))\s*(?:\}\}\s*)?$/;

function downloaded(workflows: WorkflowModel[], name: string | undefined): boolean {
  for (const { step } of stepsUsing(workflows, "actions/download-artifact")) {
    const wanted = step.with.get("name") ?? step.with.get("pattern");
    if (!wanted || wanted.kind !== "literal" || name === undefined) return true;
    const pattern = String(wanted.value);
    if (pattern === name) return true;
    const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    if (regex.test(name)) return true;
  }
  return false;
}

export default defineRule({
  meta: {
    id: "testing/unconditional-debug-upload",
    ruleset: "testing",
    description: "Consider failure-only uploads for test artifacts used solely for debugging.",
    rationale:
      "A step's default success condition can skip a debugging upload after an earlier unhandled failure. When successful-run artifacts are not needed, `if: failure()` may avoid unnecessary transfers while retaining failure diagnostics. Visible conditions and consumers are only a heuristic: verify artifact consumers, continue-on-error behavior and diagnostic needs before changing the condition.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions",
      "https://github.com/actions/upload-artifact",
      "https://playwright.dev/docs/ci-intro",
    ],
    impact: "low",
    fixable: true,
    example: {
      bad: "- run: npx playwright test\n- uses: actions/upload-artifact@v4\n  with:\n    name: playwright-report\n    path: playwright-report/",
      good:
        "- run: npx playwright test\n- uses: actions/upload-artifact@v4\n  if: failure()\n  with:\n    name: playwright-report\n    path: playwright-report/",
    },
  },
  check({ project, report }) {
    for (const { workflow, job, step } of steps(project.workflows)) {
      if (step.uses?.action.kind !== "remote" || step.uses.action.name !== "actions/upload-artifact") continue;
      const pathEntry = step.with.get("path");
      if (!pathEntry || pathEntry.kind !== "literal" || typeof pathEntry.value !== "string") continue;
      const paths = listOf(pathEntry.value).filter((entry) => !entry.startsWith("!"));
      if (paths.length === 0 || !paths.every((entry) => DEBUG_PATH.test(entry) && !MACHINE_READABLE.test(entry))) continue;
      const nameEntry = step.with.get("name");
      if (nameEntry && (nameEntry.kind !== "literal" || MACHINE_READABLE.test(String(nameEntry.value)))) continue;
      const name = nameEntry === undefined ? "artifact" : String(nameEntry.value);
      if (downloaded(project.workflows, name)) continue;

      const condition = step.if;
      const line = step.uses.line;
      // An earlier step that continues on error and is checked later means this step also runs when the tests fail.
      const earlier = job.steps.slice(0, job.steps.indexOf(step));
      if (
        (condition === undefined || SUCCESS_ONLY.test(condition)) &&
        earlier.some((other) => continueOnErrorTrue(workflow.source, stepNode(workflow.source, other)) && outcomeInspected(job.steps, other))
      ) {
        continue;
      }
      if (condition !== undefined && !SUCCESS_ONLY.test(condition)) {
        if (!ALWAYS.test(condition) || !paths.every((entry) => HEAVY_PATH.test(entry))) continue;
        report({
          path: workflow.path,
          line,
          key: `${step.key}:always`,
          message: `The upload condition permits traces, videos or screenshots (${paths.join(", ")}) on successful jobs.`,
          suggestion: "If successful-run artifacts are not needed, consider `if: failure()` and verify downstream consumers.",
        });
        continue;
      }

      let applied;
      if (condition === undefined) {
        const node = stepNode(workflow.source, step);
        const file = project.files.get(workflow.path);
        const first = file ? lineText(file.content, step.line) : "";
        const dash = /^(\s*)-\s+[\w-]+:/.exec(first);
        if (file && dash && isMap(node) && !node.flow && lineOfNode(workflow.source, node) === step.line && !/[|>][-+0-9]*\s*(#.*)?$/.test(first)) {
          applied = fix("Upload only when the job fails", insertLinesAfter(file, step.line, [`${dash[1] ?? ""}  if: failure()`]));
        }
      }
      report({
        path: workflow.path,
        line,
        key: step.key,
        message:
          condition === undefined
            ? `Debugging output (${paths.join(", ")}) uses the default success condition and may be skipped after an earlier failure.`
            : `Debugging output (${paths.join(", ")}) uses an explicit success condition (\`if: success()\`).`,
        suggestion: "If the artifacts are only needed for failure diagnostics, use `if: failure()`; verify consumers and continue-on-error behavior.",
        ...(applied ? { fix: applied } : {}),
      });
    }
  },
});
