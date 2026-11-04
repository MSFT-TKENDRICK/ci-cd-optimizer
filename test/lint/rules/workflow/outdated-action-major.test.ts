import rule from "../../../../src/lint/rules/workflow/outdated-action-major.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const job = (...stepLines: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", ...stepLines);

const SHA = "08eba0b27e820071cde6df949e0beb9ba4906955";

ruleTester(rule, {
  valid: [
    {
      name: "current majors",
      files: job(
        "      - uses: actions/checkout@v7",
        "      - uses: actions/setup-node@v7.1.0",
        "      - uses: actions/cache/restore@v6",
        "      - uses: actions/download-artifact@v8",
      ),
    },
    { name: "SHA pins without a version comment are skipped", files: job(`      - uses: actions/checkout@${SHA}`) },
    { name: "SHA pins with a current version comment", files: job(`      - uses: actions/checkout@${SHA} # v7.0.1`) },
    { name: "branch refs and expressions are skipped", files: job("      - uses: actions/checkout@main", "      - uses: ${{ inputs.action }}") },
    { name: "unknown actions are skipped", files: job("      - uses: some-org/setup-thing@v1") },
    {
      name: "node24 and composite local actions are fine",
      files: {
        ".github/actions/a/action.yml": yml("name: a", "runs:", "  using: node24", "  main: dist/index.js"),
        ".github/actions/b/action.yml": yml("name: b", "runs:", "  using: composite", "  steps:", "    - run: echo hi", "      shell: bash"),
      },
    },
  ],
  invalid: [
    {
      name: "node20-era majors are high impact",
      files: job("      - uses: actions/checkout@v4", "      - uses: actions/setup-python@v5.3.0"),
      errors: [
        { line: 6, messageIncludes: "actions/checkout@v4 targets Node 20 or older" },
        { line: 7, messageIncludes: "actions/setup-python@v5.3.0 targets Node 20 or older" },
      ],
    },
    {
      name: "node24 majors behind latest are reported without the runtime warning",
      files: job("      - uses: actions/checkout@v5", "      - uses: actions/upload-artifact@v6"),
      errors: [
        { line: 6, messageIncludes: "behind the latest major, v7" },
        { line: 7, messageIncludes: "behind the latest major, v7" },
      ],
    },
    {
      name: "SHA pin with an old version comment",
      files: job(`      - uses: actions/cache@${SHA} # v4.2.0`),
      errors: [{ line: 6, messageIncludes: "(v4.2.0) targets Node 20 or older" }],
    },
    {
      name: "composite actions are checked",
      files: {
        ".github/actions/setup/action.yml": yml(
          "name: setup",
          "runs:",
          "  using: composite",
          "  steps:",
          "    - uses: actions/setup-go@v5",
        ),
      },
      errors: [{ path: ".github/actions/setup/action.yml", line: 5 }],
    },
    {
      name: "local JavaScript actions on retired Node runtimes",
      files: {
        ".github/actions/a/action.yml": yml("name: a", "runs:", "  using: node20", "  main: dist/index.js"),
        "action.yml": yml("name: root", "runs:", "  using: 'node16'", "  main: index.js"),
      },
      errors: [
        { path: ".github/actions/a/action.yml", line: 3, messageIncludes: "runs.using: node20" },
        { path: "action.yml", line: 3, messageIncludes: "runs.using: node16" },
      ],
    },
  ],
});
