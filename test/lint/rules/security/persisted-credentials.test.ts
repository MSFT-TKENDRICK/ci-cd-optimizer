import rule from "../../../../src/lint/rules/security/persisted-credentials.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const wf = (on: string, ...stepLines: string[]): string =>
  yml(`on: ${on}`, "permissions: {}", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", ...stepLines);

const hiddenUpload = [
  "      - uses: actions/upload-artifact@v4",
  "        with:",
  "          path: .",
  "          include-hidden-files: true",
];

ruleTester(rule, {
  valid: [
    {
      name: "plain checkout with no exposure",
      files: wf("push", "      - uses: actions/checkout@v5", "      - run: make"),
    },
    {
      name: "credentials already disabled",
      files: wf("push", "      - uses: actions/checkout@v5", "        with:", "          persist-credentials: false", ...hiddenUpload),
    },
    {
      name: "upload of a build directory",
      files: wf(
        "push",
        "      - uses: actions/checkout@v5",
        "      - uses: actions/upload-artifact@v3",
        "        with:",
        "          path: dist/",
      ),
    },
    {
      name: "workspace upload on v4.4+ excludes hidden files",
      files: wf(
        "push",
        "      - uses: actions/checkout@v5",
        "      - uses: actions/upload-artifact@v4.6.0",
        "        with:",
        "          path: .",
      ),
    },
  ],
  invalid: [
    {
      name: "checkout without with: before a hidden-file upload",
      files: wf("push", "      - uses: actions/checkout@v5", ...hiddenUpload),
      errors: [{ line: 7, messageIncludes: ".git/config" }],
      output: wf(
        "push",
        "      - uses: actions/checkout@v5",
        "        with:",
        "          persist-credentials: false",
        ...hiddenUpload,
      ),
    },
    {
      name: "checkout with existing with: before an old workspace upload",
      files: wf(
        "push",
        "      - uses: actions/checkout@v5",
        "        with:",
        "          fetch-depth: 0",
        "      - uses: actions/upload-artifact@v3",
        "        with:",
        "          path: .",
      ),
      errors: 1,
      output: wf(
        "push",
        "      - uses: actions/checkout@v5",
        "        with:",
        "          fetch-depth: 0",
        "          persist-credentials: false",
        "      - uses: actions/upload-artifact@v3",
        "        with:",
        "          path: .",
      ),
    },
    {
      name: "pull_request_target head checkout followed by a build",
      files: wf(
        "pull_request_target",
        "      - uses: actions/checkout@v5",
        "        with:",
        "          ref: ${{ github.event.pull_request.head.sha }}",
        "      - run: npm test",
      ),
      errors: [{ line: 7, messageIncludes: "privileged" }],
    },
  ],
});