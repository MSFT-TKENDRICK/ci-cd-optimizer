import { runLine } from "../../parsers/workflow.js";
import { commandsOf, defineRule, expandedJobSteps, jobCommands, stepLine } from "../helpers.js";
import { continueOnErrorTrue, jobNode, outcomeInspected, scriptLines, sourceFor, stepNode, testCommand } from "./shared.js";

const SWALLOW = /\|\|\s*(?:true|:|exit\s+0)\s*(?=$|[;&)#])/;

/** The test command whose failure `|| true` (or `|| :`, `|| exit 0`) discards on this line, if any. */
function swallowedTest(line: string): string | undefined {
  const match = SWALLOW.exec(line);
  if (!match) return undefined;
  const before = line.slice(0, match.index).split(/&&|\|\||;|\|/);
  return testCommand((before[before.length - 1] ?? "").trim());
}

export default defineRule({
  meta: {
    id: "testing/masked-failures",
    ruleset: "testing",
    description: "Test failures should fail the job, not be silenced by `continue-on-error: true` or `|| true`.",
    rationale:
      "When a failing test step is allowed to pass, the check stays green, regressions merge unnoticed and the minutes spent running the tests buy no signal. Agents that iterate until CI is green are especially misled by a check that cannot fail.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepscontinue-on-error",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idcontinue-on-error",
    ],
    impact: "high",
    example: {
      bad: "- run: npm test\n  continue-on-error: true",
      good: "- run: npm test",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        const expanded = expandedJobSteps(project, workflow, job);
        const all = expanded.map((entry) => entry.step);

        const jobField = continueOnErrorTrue(workflow.source, jobNode(workflow.source, job));
        if (jobField) {
          const test = jobCommands(project, workflow, job).map((entry) => testCommand(entry.command)).find(Boolean);
          if (test) {
            report({
              path: workflow.path,
              line: jobField.line,
              key: `${job.key}:continue-on-error`,
              message: `Job \`${job.id}\` runs \`${test}\` with \`continue-on-error: true\`, so test failures never fail the workflow.`,
              suggestion: "Remove `continue-on-error`, or limit it to known-unstable matrix entries with an expression such as `${{ matrix.experimental }}`.",
            });
          }
        }

        for (const { step, owner, path, direct } of expanded) {
          const commands = commandsOf(step);
          const test = commands.map((entry) => testCommand(entry.command)).find(Boolean);
          if (!test) continue;
          const source = sourceFor(project, path);
          const stepField = source ? continueOnErrorTrue(source.source, stepNode(source.source, step)) : undefined;
          if (stepField && !outcomeInspected(all, step)) {
            report({
              path: workflow.path,
              line: direct ? stepField.line : stepLine(owner),
              key: `${step.key}:continue-on-error`,
              message: `\`${test}\` runs with \`continue-on-error: true\`, so failing tests leave the job green.`,
              suggestion: "Remove `continue-on-error`. To collect results before failing, give the step an `id` and fail a later step on `steps.<id>.outcome == 'failure'`.",
            });
          }
          for (const { text, offset } of scriptLines(step.run?.value ?? "")) {
            const swallowed = swallowedTest(text);
            if (!swallowed) continue;
            report({
              path: workflow.path,
              line: direct ? runLine(step, offset) : stepLine(owner),
              key: `${step.key}:${offset}:or-true`,
              message: `\`${swallowed} || true\` discards the test exit code, so failing tests leave the job green.`,
              suggestion: "Drop the `|| true`. To run follow-up commands regardless, put them in a later step with `if: ${{ !cancelled() }}`.",
            });
          }
        }
      }
    }
  },
});
