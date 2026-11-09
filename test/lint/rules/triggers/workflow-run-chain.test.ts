import rule from "../../../../src/lint/rules/triggers/workflow-run-chain.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]) => `${lines.join("\n")}\n`;

const CI = yml("name: CI", "on: push", "jobs:", "  build:", "    runs-on: x", "    steps:", "      - run: make");
const CHAINED = yml(
  "name: Publish docs",
  "on:",
  "  workflow_run:",
  "    workflows: [CI]",
  "    types: [completed]",
  "jobs:",
  "  docs:",
  "    runs-on: x",
  "    steps:",
  "      - run: make docs",
);

ruleTester(rule, {
  valid: [
    { name: "no workflow_run trigger", files: { ".github/workflows/ci.yml": CI } },
    {
      name: "upstream runs on pull requests (fork privilege boundary)",
      files: {
        ".github/workflows/ci.yml": yml("name: CI", "on: pull_request", "jobs:", "  build:", "    runs-on: x"),
        ".github/workflows/docs.yml": CHAINED,
      },
    },
    { name: "upstream workflow not in the repository", files: { ".github/workflows/docs.yml": CHAINED } },
    {
      name: "only listens for requested",
      files: {
        ".github/workflows/ci.yml": CI,
        ".github/workflows/docs.yml": CHAINED.replace("types: [completed]", "types: [requested]"),
      },
    },
  ],
  invalid: [
    {
      files: { ".github/workflows/ci.yml": CI, ".github/workflows/docs.yml": CHAINED },
      errors: [{ line: 3, messageIncludes: 'waits for "CI"' }],
    },
    {
      name: "single-string workflows and no types",
      files: {
        ".github/workflows/ci.yml": CI,
        ".github/workflows/docs.yml": yml("on:", "  workflow_run:", "    workflows: CI", "jobs:", "  docs:", "    runs-on: x"),
      },
      errors: 1,
    },
  ],
});
