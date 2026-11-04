import rule from "../../../../src/lint/rules/workflow/job-timeout.js";
import { ruleTester } from "../../rule-tester.js";

ruleTester(rule, {
  valid: [
    { files: "on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n    steps:\n      - run: echo hi\n" },
    { name: "reusable workflow call jobs are skipped", files: "on: push\njobs:\n  call:\n    uses: ./.github/workflows/reuse.yml\n" },
    { name: "expression timeouts are trusted", files: "on: push\njobs:\n  t:\n    runs-on: x\n    timeout-minutes: ${{ inputs.t }}\n" },
    { name: "custom maximum", files: "on: push\njobs:\n  t:\n    runs-on: x\n    timeout-minutes: 200\n", options: { maxMinutes: 240 } },
  ],
  invalid: [
    {
      files: "on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n",
      errors: [{ line: 3, messageIncludes: "no timeout-minutes" }],
      output: "on: push\njobs:\n  test:\n    timeout-minutes: 30\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n",
    },
    {
      name: "uses configured default in the fix",
      files: "on: push\njobs:\n  a:\n    runs-on: x\n  b:\n    runs-on: y\n",
      options: { defaultMinutes: 10 },
      errors: 2,
      output: "on: push\njobs:\n  a:\n    timeout-minutes: 10\n    runs-on: x\n  b:\n    timeout-minutes: 10\n    runs-on: y\n",
    },
    {
      name: "excessive literal timeout",
      files: "on: push\njobs:\n  t:\n    runs-on: x\n    timeout-minutes: 300\n",
      errors: [{ line: 5, messageIncludes: "above the configured maximum" }],
    },
    {
      name: "no fix when runs-on comes from an alias",
      files: "on: push\nx: &r ubuntu-24.04\njobs:\n  t:\n    runs-on: *r\n",
      errors: 1,
      output: "on: push\nx: &r ubuntu-24.04\njobs:\n  t:\n    runs-on: *r\n",
    },
  ],
});
