import rule from "../../../../src/lint/rules/triggers/draft-pr-gating.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]) => `${lines.join("\n")}\n`;

const MATRIX_JOB = ["  test:", "    runs-on: x", "    strategy:", "      matrix:", "        os: [a, b]", "    steps:", "      - run: make test"];

ruleTester(rule, {
  valid: [
    { name: "push only", files: yml("on: push", "jobs:", ...MATRIX_JOB) },
    { name: "cheap job", files: yml("on: pull_request", "jobs:", "  lint:", "    runs-on: x", "    steps:", "      - run: make lint") },
    {
      name: "job skips drafts",
      files: yml("on: pull_request", "jobs:", ...MATRIX_JOB.slice(0, 2), "    if: github.event.pull_request.draft == false", ...MATRIX_JOB.slice(2)),
    },
    {
      name: "upstream job skips drafts",
      files: yml(
        "on: pull_request",
        "jobs:",
        "  gate:",
        "    if: ${{ !github.event.pull_request.draft }}",
        "    runs-on: x",
        "    steps:",
        "      - run: true",
        ...MATRIX_JOB.slice(0, 2),
        "    needs: gate",
        ...MATRIX_JOB.slice(2),
      ),
    },
    {
      name: "types include ready_for_review",
      files: yml("on:", "  pull_request:", "    types: [opened, synchronize, ready_for_review]", "jobs:", ...MATRIX_JOB),
    },
    { name: "metadata-only types", files: yml("on:", "  pull_request:", "    types: [labeled]", "jobs:", ...MATRIX_JOB) },
    { name: "deploy workflow", files: { ".github/workflows/deploy-preview.yml": yml("on: pull_request", "jobs:", ...MATRIX_JOB) } },
  ],
  invalid: [
    {
      files: yml("on: pull_request", "jobs:", ...MATRIX_JOB),
      errors: [{ line: 1, messageIncludes: '"test" (2-leg matrix)' }],
    },
    {
      name: "long timeout",
      files: yml("on:", "  pull_request:", "jobs:", "  e2e:", "    runs-on: x", "    timeout-minutes: 45", "    steps:", "      - run: make e2e"),
      errors: [{ line: 2, messageIncludes: "45-minute timeout" }],
    },
    {
      name: "many steps",
      files: yml("on: pull_request", "jobs:", "  t:", "    runs-on: x", "    steps:", ...Array.from({ length: 12 }, (_, i) => `      - run: echo ${i}`)),
      errors: [{ messageIncludes: "12 steps" }],
    },
  ],
});
