import rule from "../../../../src/lint/rules/caching/pr-branch-cache-save.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const CI = ".github/workflows/ci.yml";
const MAIN = ".github/workflows/main.yml";
const KEY = "npm-${{ hashFiles('package-lock.json') }}";

const workflow = (on: string[], ...stepLines: string[]): string =>
  yml(...on, "jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v5", ...stepLines);

const cacheStep = (action = "actions/cache@v6", path = "~/.npm", key = KEY, ...extra: string[]): string[] => [
  `      - uses: ${action}`,
  "        with:",
  `          path: ${path}`,
  `          key: ${key}`,
  ...extra,
];

ruleTester(rule, {
  valid: [
    {
      name: "workflow also runs on push to main",
      files: workflow(["on:", "  pull_request:", "  push:", "    branches: [main]"], ...cacheStep()),
    },
    {
      name: "restore-only step in a PR workflow",
      files: workflow(["on: pull_request"], ...cacheStep("actions/cache/restore@v6")),
    },
    {
      name: "trap: a push workflow saves the same cache path",
      files: {
        [CI]: workflow(["on: pull_request"], ...cacheStep()),
        [MAIN]: workflow(["on:", "  push:", "    branches: [main]"], ...cacheStep("actions/cache/save@v6", "~/.npm", "npm-main")),
      },
    },
    {
      name: "trap: a push workflow calls a remote reusable workflow that may save it",
      files: {
        [CI]: workflow(["on: pull_request"], ...cacheStep()),
        [MAIN]: yml("on: push", "jobs:", "  build:", "    uses: org/shared/.github/workflows/build.yml@v1"),
      },
    },
    {
      name: "trap: lookup-only never saves",
      files: workflow(["on: pull_request"], ...cacheStep("actions/cache@v6", "~/.npm", KEY, "          lookup-only: true")),
    },
    {
      name: "trap: cache-mode overrides the default cache access",
      files: yml(
        "on: pull_request",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    cache-mode: read-only",
        "    steps:",
        ...cacheStep(),
      ),
    },
    {
      name: "trap: schedule trigger runs in the default branch scope",
      files: workflow(["on:", "  pull_request:", "  schedule:", "    - cron: '0 3 * * *'"], ...cacheStep()),
    },
  ],
  invalid: [
    {
      name: "PR-only workflow with combined actions/cache",
      files: workflow(["on: pull_request"], ...cacheStep()),
      errors: [
        {
          line: 7,
          messageIncludes: `\`actions/cache\` saves cache \`${KEY}\` in a workflow that only runs on \`pull_request\`, and no workflow that runs on the default branch saves this cache.`,
        },
      ],
    },
    {
      name: "PR + merge_group workflow with an explicit save step",
      files: workflow(["on: [pull_request, merge_group]"], "      - run: npm ci", ...cacheStep("actions/cache/save@v6")),
      errors: [{ line: 8, messageIncludes: "`actions/cache/save` saves cache `npm-" }],
    },
    {
      name: "a push workflow caching a different path does not help",
      files: {
        [CI]: workflow(["on: pull_request"], ...cacheStep("actions/cache@v6", ".venv", "venv-${{ hashFiles('uv.lock') }}")),
        [MAIN]: workflow(["on:", "  push:", "    branches: [main]"], ...cacheStep()),
      },
      errors: [{ path: CI, line: 7, messageIncludes: "saves cache `venv-${{ hashFiles('uv.lock') }}`" }],
    },
    {
      name: "a push workflow that only restores does not save",
      files: {
        [CI]: workflow(["on: pull_request"], ...cacheStep()),
        [MAIN]: workflow(["on: push"], ...cacheStep("actions/cache/restore@v6")),
      },
      errors: [{ path: CI, line: 7, messageIncludes: "only runs on `pull_request`" }],
    },
  ],
});
