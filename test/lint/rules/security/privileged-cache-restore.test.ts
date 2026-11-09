import rule from "../../../../src/lint/rules/security/privileged-cache-restore.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const wf = (on: string, ...stepLines: string[]): string =>
  yml(`on: ${on}`, "permissions: {}", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", ...stepLines);

ruleTester(rule, {
  valid: [
    {
      name: "cache on pull_request is fine",
      files: wf("pull_request", "      - uses: actions/cache@v4", "        with:", "          path: ~/.npm", "          key: k"),
    },
    {
      name: "setup-node without cache input",
      files: wf("pull_request_target", "      - uses: actions/setup-node@v4", "        with:", "          node-version: 22"),
    },
    {
      name: "setup-node with cache disabled",
      files: wf(
        "workflow_run",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          cache: ''",
      ),
    },
  ],
  invalid: [
    {
      name: "actions/cache on pull_request_target",
      files: wf(
        "pull_request_target",
        "      - uses: actions/cache@v4",
        "        with:",
        "          path: ~/.npm",
        "          key: k",
      ),
      errors: [{ line: 7, messageIncludes: "pull_request_target" }],
    },
    {
      name: "setup-python with pip cache on issue_comment",
      files: wf("issue_comment", "      - uses: actions/setup-python@v5", "        with:", "          cache: pip"),
      errors: 1,
    },
  ],
});