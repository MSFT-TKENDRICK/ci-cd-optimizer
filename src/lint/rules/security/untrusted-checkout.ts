import { hasTrigger } from "../../parsers/workflow.js";
import { usesAction } from "../caching/shared.js";
import { commandsOf, defineRule, stepLine } from "../helpers.js";
import { executesWorkspace, untrustedCheckoutTarget } from "./shared.js";

const PR_CHECKOUT = /\bgh\s+pr\s+checkout\b/;

export default defineRule({
  meta: {
    id: "security/untrusted-checkout",
    ruleset: "security",
    description:
      "`pull_request_target` and `workflow_run` workflows must not check out the pull request's code and then execute it.",
    rationale:
      "These triggers run in the base repository's context with its secrets and a token that can write. Checking out the contributor's head commit and then running a build, test, script, or local action executes attacker-authored code with those privileges (a \"pwn request\"). Run untrusted code in a `pull_request` workflow instead, and hand results to the privileged workflow as data.",
    kind: "practice",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target",
      "https://docs.github.com/en/actions/reference/security/secure-use",
      "https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/",
    ],
    impact: "high",
    example: {
      bad: "on: pull_request_target\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n      - run: npm ci && npm test",
      good: "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@v5\n      - run: npm ci && npm test",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (!hasTrigger(workflow, "pull_request_target", "workflow_run")) continue;
      for (const job of workflow.jobs) {
        for (const [index, step] of job.steps.entries()) {
          let target: string | undefined;
          let line = stepLine(step);
          if (usesAction(step, "actions/checkout")) {
            target = untrustedCheckoutTarget(step);
          } else {
            const command = commandsOf(step).find((entry) => PR_CHECKOUT.test(entry.command));
            if (command) {
              target = "gh pr checkout";
              line = command.line;
            }
          }
          if (target === undefined) continue;
          let executes: (typeof job.steps)[number] | undefined;
          let what = "";
          for (const later of job.steps.slice(index + 1)) {
            if (later.run !== undefined) what = "a `run` step";
            else if (later.uses?.action.kind === "local") what = `the local action \`${later.uses.value}\``;
            else what = executesWorkspace(later) ?? "";
            if (what) {
              executes = later;
              break;
            }
          }
          if (!executes) continue;
          report({
            path: workflow.path,
            line,
            key: step.key,
            message: `Privileged workflow checks out untrusted pull request code (${target}) and then executes ${what} at line ${stepLine(executes)}.`,
            suggestion:
              "Move build and test steps to a `pull_request` workflow. If this job must stay privileged, check out the base ref only, or keep the PR checkout in a separate path and treat it strictly as data.",
            related: [{ path: workflow.path, line: stepLine(executes) }],
          });
        }
      }
    }
  },
});
