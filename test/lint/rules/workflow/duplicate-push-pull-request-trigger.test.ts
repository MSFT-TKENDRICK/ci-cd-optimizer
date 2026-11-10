import rule from "../../../../src/lint/rules/workflow/duplicate-push-pull-request-trigger.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const JOBS = ["jobs:", "  test:", "    runs-on: ubuntu-24.04", "    steps:", "      - run: npm test"];

const workflow = (...onLines: string[]): string => yml(...onLines, ...JOBS);

ruleTester(rule, {
  valid: [
    {
      name: "push restricted to the default branch",
      files: workflow("on:", "  push:", "    branches: [main]", "  pull_request:"),
    },
    {
      name: "push without pull_request runs once",
      files: workflow("on:", "  push:"),
    },
    {
      name: "tag-only push never overlaps PR commits",
      files: workflow("on:", "  push:", "    tags: ['v*']", "  pull_request:"),
    },
    {
      name: "branches-ignore is a deliberate filter",
      files: workflow("on:", "  push:", "    branches-ignore: ['dependabot/**']", "  pull_request:"),
    },
    {
      name: "trap: a glob that is not all-branches (release/**) is a deliberate filter",
      files: workflow("on:", "  push:", "    branches: ['main', 'release/**']", "  pull_request:"),
    },
    {
      name: "trap: negated patterns exclude PR branches",
      files: workflow("on:", "  push:", "    branches: ['**', '!feature/**']", "  pull_request:"),
    },
    {
      name: "trap: pull_request without synchronize does not run on PR commits",
      files: workflow("on:", "  push:", "  pull_request:", "    types: [opened, labeled]"),
    },
    {
      name: "trap: jobs that skip duplicate events themselves",
      files: yml(
        "on: [push, pull_request]",
        "jobs:",
        "  test:",
        "    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name != github.repository",
        "    runs-on: ubuntu-24.04",
        "    steps:",
        "      - run: npm test",
      ),
    },
    {
      name: "trap: concurrency keyed on head_ref cancels the duplicate",
      files: yml(
        "on: [push, pull_request]",
        "concurrency:",
        "  group: ${{ github.workflow }}-${{ github.head_ref || github.ref_name }}",
        "  cancel-in-progress: true",
        ...JOBS,
      ),
    },
  ],
  invalid: [
    {
      name: "bare push is reported for manual trigger-policy review",
      files: workflow("on:", "  push:", "  pull_request:"),
      errors: [{ line: 2, messageIncludes: "`push` has no `branches` filter" }],
      output: null,
    },
    {
      name: "push with a paths filter gets a manual branch-policy recommendation",
      files: workflow(
        "on:",
        "  push:",
        "    paths: ['src/**']",
        "  pull_request:",
        "    branches: [develop]",
      ),
      errors: [{ line: 2, messageIncludes: "`push` has no `branches` filter and `pull_request` is also a trigger, so pushes to open same-repository pull requests may trigger overlapping work. Push and PR merge refs are different; this does not prove duplicate coverage." }],
      output: null,
    },
    {
      name: "configured default branches and 4-space indentation",
      files: workflow("on:", "    push:", "    pull_request:"),
      options: { defaultBranches: ["main", "release"] },
      errors: [{ line: 2 }],
      output: null,
    },
    {
      name: "all-branches glob is reported without a fix",
      files: workflow("on:", "  push:", "    branches: ['**']", "  pull_request:"),
      errors: [{ line: 2, messageIncludes: "`push` matches `branches: [**]`" }],
      output: null,
    },
    {
      name: "flow-sequence triggers are reported without a fix",
      files: workflow("on: [push, pull_request]"),
      errors: [{ line: 1, messageIncludes: "no `branches` filter" }],
      output: null,
    },
    {
      name: "pull_request types that include synchronize still duplicate",
      files: workflow("on:", "  push:", "  pull_request:", "    types: [opened, synchronize]"),
      errors: [{ line: 2 }],
      output: null,
    },
  ],
});
