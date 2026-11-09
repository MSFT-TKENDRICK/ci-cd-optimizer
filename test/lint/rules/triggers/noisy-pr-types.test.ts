import rule from "../../../../src/lint/rules/triggers/noisy-pr-types.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]) => `${lines.join("\n")}\n`;

const BUILD = ["jobs:", "  test:", "    runs-on: x", "    steps:", "      - uses: actions/checkout@v4", "      - run: make test"];

ruleTester(rule, {
  valid: [
    { name: "code-only types", files: yml("on:", "  pull_request:", "    types: [opened, synchronize, reopened]", ...BUILD) },
    { name: "default types", files: yml("on: pull_request", ...BUILD) },
    {
      name: "labeler workflow",
      files: { ".github/workflows/labeler.yml": yml("on:", "  pull_request:", "    types: [labeled, unlabeled]", ...BUILD) },
    },
    {
      name: "job filters on the label",
      files: yml(
        "on:",
        "  pull_request:",
        "    types: [opened, synchronize, labeled]",
        "jobs:",
        "  test:",
        "    if: github.event.action != 'labeled' || github.event.label.name == 'run-e2e'",
        "    runs-on: x",
        "    steps:",
        "      - run: make e2e",
      ),
    },
    {
      name: "no build steps",
      files: yml("on:", "  pull_request:", "    types: [edited]", "jobs:", "  t:", "    runs-on: x", "    steps:", "      - uses: some/commenter@v1"),
    },
  ],
  invalid: [
    {
      files: yml("on:", "  pull_request:", "    types: [opened, synchronize, edited, labeled]", ...BUILD),
      errors: [{ line: 2, messageIncludes: "(edited, labeled)" }],
    },
    {
      name: "pull_request_target",
      files: yml("on:", "  pull_request_target:", "    types: [assigned]", ...BUILD),
      errors: [{ messageIncludes: "pull_request_target" }],
    },
  ],
});
