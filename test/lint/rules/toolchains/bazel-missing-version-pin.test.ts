import rule from "../../../../src/lint/rules/toolchains/bazel-missing-version-pin.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const job = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", "      - uses: actions/checkout@v5", ...steps);
const WORKFLOW = ".github/workflows/ci.yml";
const MODULE = 'module(name = "demo")\n';

ruleTester(rule, {
  valid: [
    {
      name: ".bazelversion pins an exact release",
      files: { [WORKFLOW]: job("      - run: bazel test //..."), "MODULE.bazel": MODULE, ".bazelversion": "8.4.2\n" },
    },
    {
      name: ".bazeliskrc pins USE_BAZEL_VERSION",
      files: { [WORKFLOW]: job("      - run: bazel build //..."), "WORKSPACE": "", ".bazeliskrc": "USE_BAZEL_VERSION=7.6.1\n" },
    },
    {
      name: "USE_BAZEL_VERSION set in the workflow environment",
      files: {
        [WORKFLOW]: yml(
          "on: push",
          "env:",
          "  USE_BAZEL_VERSION: 8.4.2",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - run: bazel test //...",
        ),
        "MODULE.bazel": MODULE,
      },
    },
    {
      name: "trap: fork-qualified exact version is a pin",
      files: { [WORKFLOW]: job("      - run: bazel test //..."), "MODULE.bazel": MODULE, ".bazelversion": "mycompany/8.4.2\n" },
    },
    {
      name: "trap: bazel invoked in a repository without a Bazel workspace",
      files: { [WORKFLOW]: job("      - run: bazel --version") },
    },
    {
      name: "trap: incomplete inventory cannot prove .bazelversion is absent",
      files: { [WORKFLOW]: job("      - run: bazel test //..."), "MODULE.bazel": MODULE },
      inventoryComplete: false,
    },
  ],
  invalid: [
    {
      name: "MODULE.bazel workspace without any version pin",
      files: { [WORKFLOW]: job("      - run: bazel test //..."), "MODULE.bazel": MODULE },
      errors: [
        {
          line: 7,
          path: WORKFLOW,
          messageIncludes: "The root Bazel workspace has no `.bazelversion`, no `USE_BAZEL_VERSION` in `.bazeliskrc`",
        },
      ],
    },
    {
      name: ".bazelversion with the floating `latest` label",
      files: { [WORKFLOW]: job("      - run: bazel test //..."), "MODULE.bazel": MODULE, ".bazelversion": "latest\n" },
      errors: [{ line: 1, path: ".bazelversion", messageIncludes: "selects the floating Bazel label `latest`" }],
    },
    {
      name: ".bazeliskrc with a major-version wildcard",
      files: {
        [WORKFLOW]: job("      - run: bazel build //..."),
        "MODULE.bazel": MODULE,
        ".bazeliskrc": "# CI Bazel\nUSE_BAZEL_VERSION=7.x\n",
      },
      errors: [{ line: 2, path: ".bazeliskrc", messageIncludes: "floating Bazel label `7.x`" }],
    },
    {
      name: "nested workspace via setup-bazel module-root, reported once",
      files: {
        [WORKFLOW]: job(
          "      - uses: bazel-contrib/setup-bazel@0.15.0",
          "        with:",
          "          module-root: tools",
          "      - run: bazel test //...",
          "        working-directory: tools",
        ),
        "tools/MODULE.bazel": MODULE,
      },
      errors: [{ line: 7, messageIncludes: "The Bazel workspace in `tools/` has no `.bazelversion`" }],
    },
  ],
});
