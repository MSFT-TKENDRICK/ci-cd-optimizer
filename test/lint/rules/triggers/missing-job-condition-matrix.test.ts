import rule from "../../../../src/lint/rules/triggers/missing-job-condition-matrix.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]) => `${lines.join("\n")}\n`;

const CHANGES = [
  "  changes:",
  "    runs-on: x",
  "    outputs:",
  "      src: ${{ steps.f.outputs.src }}",
  "    steps:",
  "      - id: f",
  "        uses: dorny/paths-filter@v3",
];
const LINT = ["  lint:", "    needs: changes", "    if: needs.changes.outputs.src == 'true'", "    runs-on: x", "    steps:", "      - run: make lint"];
const MATRIX = ["  test:", "    runs-on: x", "    strategy:", "      matrix:", "        node: [18, 20, 22]", "    steps:", "      - run: make test"];

ruleTester(rule, {
  valid: [
    { name: "no change detection", files: yml("on: pull_request", "jobs:", ...MATRIX) },
    { name: "change job outputs unused", files: yml("on: pull_request", "jobs:", ...CHANGES, ...MATRIX) },
    {
      name: "matrix already needs the change job",
      files: yml("on: pull_request", "jobs:", ...CHANGES, ...LINT, ...MATRIX.slice(0, 2), "    needs: lint", ...MATRIX.slice(2)),
    },
    {
      name: "matrix has its own condition",
      files: yml("on: pull_request", "jobs:", ...CHANGES, ...LINT, ...MATRIX.slice(0, 2), "    if: github.actor != 'bot'", ...MATRIX.slice(2)),
    },
    { name: "push only", files: yml("on: push", "jobs:", ...CHANGES, ...LINT, ...MATRIX) },
    {
      name: "single-leg matrix",
      files: yml("on: pull_request", "jobs:", ...CHANGES, ...LINT, ...MATRIX.slice(0, 4), "        node: [20]", ...MATRIX.slice(5)),
    },
  ],
  invalid: [
    {
      files: yml("on: pull_request", "jobs:", ...CHANGES, ...LINT, ...MATRIX),
      errors: [{ line: 16, messageIncludes: 'Matrix job "test" (3 legs)' }],
    },
  ],
});
