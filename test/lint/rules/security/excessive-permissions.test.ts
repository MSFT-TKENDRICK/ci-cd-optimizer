import rule from "../../../../src/lint/rules/security/excessive-permissions.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
ruleTester(rule, {
  valid: [
    {
      name: "pull-requests: write on a labeler job that never touches PR code",
      files: yml(
        "on: pull_request_target",
        "permissions: {}",
        "jobs:",
        "  label:",
        "    permissions:",
        "      pull-requests: write",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/labeler@v5",
      ),
    },
    {
      name: "top-level read permissions",
      files: yml("on: push", "permissions:", "  contents: read", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", "      - run: make"),
    },
    {
      name: "every job declares permissions",
      files: yml("on: push", "jobs:", "  a:", "    permissions: {}", "    runs-on: ubuntu-latest", "    steps:", "      - run: make"),
    },
    {
      name: "write access on a trusted trigger",
      files: yml(
        "on: push",
        "permissions:",
        "  contents: write",
        "jobs:",
        "  a:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: make release",
      ),
    },
    {
      name: "reusable workflow inherits the caller's permissions",
      files: yml("on: workflow_call", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", "      - run: make"),
    },
    {
      name: "issues: write on pull_request_target is not a code-write scope",
      files: yml(
        "on: pull_request_target",
        "permissions:",
        "  issues: write",
        "jobs:",
        "  a:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo label",
      ),
    },
  ],
  invalid: [
    {
      name: "pull-requests: write on a job that checks out the PR head",
      files: yml(
        "on: pull_request_target",
        "permissions: {}",
        "jobs:",
        "  a:",
        "    permissions:",
        "      pull-requests: write",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v5",
        "        with:",
        "          ref: ${{ github.event.pull_request.head.sha }}",
        "      - run: npm test",
      ),
      errors: [{ line: 5, messageIncludes: "pull-requests: write" }],
    },
    {
      name: "top-level pull-requests: write inherited by a job that interpolates PR text",
      files: yml(
        "on: pull_request_target",
        "permissions:",
        "  pull-requests: write",
        "jobs:",
        "  a:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        '      - run: echo "${{ github.event.pull_request.body }}"',
      ),
      errors: [{ line: 2, messageIncludes: "pull-requests: write" }],
    },
    {
      name: "no permissions anywhere",
      files: yml("on: push", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", "      - run: make"),
      errors: [{ line: 3, messageIncludes: "no `permissions:`" }],
    },
    {
      name: "write-all on push",
      files: yml("on: push", "permissions: write-all", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", "      - run: make"),
      errors: [{ line: 2, messageIncludes: "write-all" }],
    },
    {
      name: "contents: write on pull_request_target job",
      files: yml(
        "on: pull_request_target",
        "permissions: {}",
        "jobs:",
        "  a:",
        "    permissions:",
        "      contents: write",
        "      pull-requests: write",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: make",
      ),
      errors: [{ line: 5, messageIncludes: "pull_request_target" }],
    },
    {
      name: "write-all on workflow_run is reported once",
      files: yml("on: workflow_run", "permissions: write-all", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", "      - run: make"),
      errors: [{ line: 2, messageIncludes: "workflow_run" }],
    },
  ],
});