import rule from "../../../../src/lint/rules/workflow/merge-group.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const testJob = ["jobs:", "  test:", "    runs-on: ubuntu-24.04", "    steps:", "      - uses: actions/checkout@v7", "      - run: npm test"];

ruleTester(rule, {
  valid: [
    { name: "already runs in the merge queue", files: yml("on:", "  pull_request:", "  merge_group:", ...testJob) },
    { name: "push-only workflows are out of scope", files: yml("on: push", ...testJob) },
    { name: "pull_request_target-only workflows are skipped", files: yml("on: pull_request_target", ...testJob) },
    {
      name: "label-only activity types are not code checks",
      files: yml("on:", "  pull_request:", "    types: [labeled, unlabeled]", ...testJob),
    },
    {
      name: "PR automation workflows are skipped",
      files: {
        ".github/workflows/labeler.yml": yml(
          "on: pull_request",
          "jobs:",
          "  label:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - uses: actions/labeler@v6",
        ),
      },
    },
    {
      name: "deploy-like workflows are skipped",
      files: yml(
        "on: pull_request",
        "jobs:",
        "  preview:",
        "    runs-on: ubuntu-24.04",
        "    environment: preview",
        "    steps:",
        "      - run: ./deploy.sh",
      ),
    },
  ],
  invalid: [
    {
      name: "pull_request mapping without merge_group",
      files: yml("on:", "  push:", "    branches: [main]", "  pull_request:", ...testJob),
      errors: [{ line: 4, messageIncludes: "not merge_group" }],
    },
    {
      name: "list form reports at the on key",
      files: yml("name: CI", "on: [push, pull_request]", ...testJob),
      errors: [{ line: 2 }],
    },
    {
      name: "reusable workflow callers count as checks",
      files: yml("on: pull_request", "jobs:", "  ci:", "    uses: ./.github/workflows/reusable.yml"),
      errors: 1,
    },
    {
      name: "explicit synchronize type is a code check",
      files: yml("on:", "  pull_request:", "    types: [opened, synchronize]", ...testJob),
      errors: [{ line: 2 }],
    },
    {
      name: "jobs using only a local action count",
      files: {
        ".github/workflows/lint.yml": yml(
          "on: pull_request",
          "jobs:",
          "  lint:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - uses: ./.github/actions/lint",
        ),
      },
      errors: [{ path: ".github/workflows/lint.yml", line: 1 }],
    },
  ],
});
