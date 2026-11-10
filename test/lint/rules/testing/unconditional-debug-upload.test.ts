import rule from "../../../../src/lint/rules/testing/unconditional-debug-upload.js";
import { ruleTester } from "../../rule-tester.js";

const wf = (body: string) => `on: push\njobs:\n  b:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;
const upload = (path: string, condition = "") =>
  `      - run: npx playwright test\n      - uses: actions/upload-artifact@v4\n${condition}        with:\n          name: report\n          path: ${path}\n`;

ruleTester(rule, {
  valid: [
    {
      name: "tests continue on error and a later step checks the outcome",
      files: wf(
        "      - id: tests\n        continue-on-error: true\n        run: npx playwright test\n      - uses: actions/upload-artifact@v4\n        with:\n          name: report\n          path: playwright-report/\n      - if: steps.tests.outcome == 'failure'\n        run: exit 1\n",
      ),
    },
    { name: "already failure-only", files: wf(upload("playwright-report/", "        if: failure()\n")) },
    { name: "always() report upload is a deliberate choice", files: wf(upload("playwright-report/", "        if: ${{ !cancelled() }}\n")) },
    { name: "machine-readable results are kept", files: wf(upload("test-results/junit.xml")) },
    { name: "build output is not debugging output", files: wf(upload("dist/")) },
    {
      name: "artifact consumed by another job",
      files: wf(upload("playwright-report/") + "  merge:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/download-artifact@v4\n        with:\n          name: report\n"),
    },
  ],
  invalid: [
    {
      files: wf(upload("playwright-report/")),
      errors: [{ line: 7, messageIncludes: "default success condition" }],
      output: wf(upload("playwright-report/", "        if: failure()\n")),
    },
    {
      name: "success() is flagged",
      files: wf(upload("test-results/", "        if: success()\n")),
      errors: [{ line: 7, messageIncludes: "explicit success condition" }],
    },
    {
      name: "always() upload of heavy traces",
      files: wf(upload("traces/", "        if: always()\n")),
      errors: [{ line: 7, messageIncludes: "permits traces, videos or screenshots" }],
    },
  ],
});
