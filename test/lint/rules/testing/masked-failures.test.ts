import rule from "../../../../src/lint/rules/testing/masked-failures.js";
import { ruleTester } from "../../rule-tester.js";

const wf = (body: string, extra = "") => `on: push\njobs:\n  b:\n    runs-on: ubuntu-24.04\n${extra}    steps:\n${body}`;

ruleTester(rule, {
  valid: [
    { name: "tests fail the job", files: wf("      - run: npm test\n") },
    { name: "continue-on-error on a non-test step", files: wf("      - run: npm run lint\n        continue-on-error: true\n") },
    { name: "matrix-driven continue-on-error", files: wf("      - run: pytest\n        continue-on-error: ${{ matrix.experimental }}\n") },
    {
      name: "outcome checked by a later step",
      files: wf(
        "      - id: t\n        run: go test ./...\n        continue-on-error: true\n      - run: exit 1\n        if: steps.t.outcome == 'failure'\n",
      ),
    },
    { name: "|| true on a non-test command", files: wf("      - run: rm -rf out || true\n") },
  ],
  invalid: [
    {
      files: wf("      - run: npx jest --ci\n        continue-on-error: true\n"),
      errors: [{ line: 7, messageIncludes: "continue-on-error" }],
    },
    {
      name: "|| true after a test command",
      files: wf("      - run: |\n          npm ci\n          cargo test --all || true\n"),
      errors: [{ line: 8, messageIncludes: "|| true" }],
    },
    {
      name: "job-level continue-on-error",
      files: wf("      - run: mvn -B test\n", "    continue-on-error: true\n"),
      errors: [{ line: 5, messageIncludes: "Job `b`" }],
    },
  ],
});
