import rule from "../../../../src/lint/rules/affected/path-filter-required-checks.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const jobs = ["jobs:", "  test:", "    runs-on: ubuntu-24.04", "    steps:", "      - run: npm test"];

ruleTester(rule, {
  valid: [
    {
      name: "pull request trigger without path filters",
      files: yml("on:", "  pull_request:", "    branches: [main]", ...jobs),
    },
    {
      name: "push-only path filters are fine",
      files: yml("on:", "  push:", "    branches: [main]", "    paths: ['src/**']", "  pull_request:", ...jobs),
    },
    {
      name: "deploy-like workflows are not required checks",
      files: {
        ".github/workflows/deploy-preview.yml": yml("on:", "  pull_request:", "    paths: ['site/**']", ...jobs),
      },
    },
    {
      name: "short trigger forms have no filters",
      files: yml("on: [pull_request, push]", ...jobs),
    },
    {
      name: "composite actions are not workflows",
      files: {
        ".github/actions/x/action.yml": yml("name: x", "runs:", "  using: composite", "  steps:", "    - run: echo", "      shell: bash"),
      },
    },
  ],
  invalid: [
    {
      name: "paths on pull_request",
      files: yml("name: CI", "on:", "  pull_request:", "    paths:", "      - 'packages/api/**'", ...jobs),
      errors: [{ line: 4, messageIncludes: "`pull_request` runs are filtered by `paths`" }],
    },
    {
      name: "paths-ignore on pull_request_target, push filters ignored",
      files: yml(
        "on:",
        "  push:",
        "    paths-ignore: ['docs/**']",
        "  pull_request_target:",
        "    types: [opened, synchronize]",
        "    paths-ignore:",
        "      - 'docs/**'",
        ...jobs,
      ),
      errors: [{ line: 6, messageIncludes: "filtered by `paths-ignore`" }],
    },
    {
      name: "each pull request event is reported",
      files: yml(
        "on:",
        "  pull_request:",
        "    paths: ['src/**']",
        "  pull_request_target:",
        "    paths: ['src/**']",
        ...jobs,
      ),
      errors: [
        { line: 3, messageIncludes: "`pull_request`" },
        { line: 5, messageIncludes: "`pull_request_target`" },
      ],
    },
    {
      name: "required check is Pending, not skipped",
      files: yml("on:", "  pull_request:", "    branches: [main]", "    paths: ['src/**']", ...jobs),
      errors: [{ line: 4, messageIncludes: "leave the check Pending" }],
    },
  ],
});
