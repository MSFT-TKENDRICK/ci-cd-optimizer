import { defineRule, steps } from "../helpers.js";
import { ENV_FILE_WRITE, isRefName, scriptLines, untrustedEnvNames, untrustedExpressions } from "./shared.js";

export default defineRule({
  meta: {
    id: "security/env-file-injection",
    ruleset: "security",
    description:
      "Attacker-controlled values must not be written to `$GITHUB_ENV`, `$GITHUB_PATH`, or `$GITHUB_OUTPUT`.",
    rationale:
      "Lines written to `$GITHUB_ENV` become environment variables for every later step, and `$GITHUB_PATH` entries change which binaries run. A branch name or issue title containing a newline can append its own `NODE_OPTIONS=--require=...`, `LD_PRELOAD`, or `PATH` entry and take over subsequent steps, including ones holding secrets. Interpolated values written to `$GITHUB_OUTPUT` can likewise forge outputs consumed by later jobs.",
    kind: "practice",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/security/secure-use#good-practices-for-mitigating-script-injection-attacks",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#setting-an-environment-variable",
    ],
    impact: "high",
    example: {
      bad: '- run: echo "BRANCH=${{ github.head_ref }}" >> "$GITHUB_ENV"',
      good: '- env:\n    HEAD_REF: ${{ github.head_ref }}\n  run: |\n    if [[ "$HEAD_REF" =~ ^[A-Za-z0-9._/-]+$ ]]; then echo "BRANCH=$HEAD_REF" >> "$GITHUB_OUTPUT"; fi',
    },
  },
  check({ project, report }) {
    for (const { workflow, job, step } of steps([...project.workflows, ...project.actions])) {
      if (!step.run) continue;
      const tainted = untrustedEnvNames(workflow, job, step, (expression) => !isRefName(expression));
      for (const line of scriptLines(step)) {
        const target = ENV_FILE_WRITE.exec(line.text)?.[1];
        if (target === undefined) continue;
        const expression = untrustedExpressions(line.text)[0];
        if (expression) {
          report({
            path: workflow.path,
            line: line.line,
            key: `${step.key}.run`,
            message: `\`${expression.context}\` is interpolated into a write to $${target}; a crafted value can inject extra variables, paths, or outputs.`,
            suggestion:
              "Pass the value through `env:`, validate it against a strict pattern, and use a heredoc delimiter for multi-line values before writing it.",
          });
          continue;
        }
        const variable = tainted.find(
          (name) =>
            /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
            new RegExp(String.raw`\$(?:\{${name}\}|${name}\b)`).test(line.text),
        );
        if (variable === undefined) continue;
        report({
          path: workflow.path,
          line: line.line,
          key: `${step.key}.run`,
          message: `\`$${variable}\` holds an attacker-controlled value and is written to $${target}, where a newline can inject extra entries.`,
          suggestion:
            "Validate the value against a strict pattern (no newlines) before writing it, or use a random heredoc delimiter (`name<<EOF_$RANDOM`) so a newline cannot start a new entry.",
        });
      }
    }
  },
});
