import rule from "../../../../src/lint/rules/security/install-scripts-privileged.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const wf = (on: string, perms: string, ...stepLines: string[]): string =>
  yml(`on: ${on}`, `permissions: ${perms}`, "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", ...stepLines);

ruleTester(rule, {
  valid: [
    {
      name: "pull_request is not privileged",
      files: wf("pull_request", "write-all", "      - run: npm ci"),
    },
    {
      name: "read-only token and no secrets",
      files: wf("pull_request_target", "{}", "      - run: npm ci"),
    },
    {
      name: "scripts disabled on the command line",
      files: wf("pull_request_target", "write-all", "      - run: npm ci --ignore-scripts"),
    },
    {
      name: "scripts disabled in .npmrc",
      files: {
        ".github/workflows/ci.yml": wf("pull_request_target", "write-all", "      - run: npm ci"),
        ".npmrc": "ignore-scripts=true\n",
      },
    },
    {
      name: "non-install commands",
      files: wf("workflow_run", "write-all", "      - run: npm test && yarn build"),
    },
  ],
  invalid: [
    {
      name: "npm ci with a write token",
      files: wf("pull_request_target", "write-all", "      - run: npm ci"),
      errors: [{ line: 7, messageIncludes: "npm ci" }],
    },
    {
      name: "yarn with secrets in env",
      files: wf(
        "issue_comment",
        "{}",
        "      - env:",
        "          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}",
        "        run: |",
        "          yarn --frozen-lockfile",
        "          pnpm install",
      ),
      errors: 2,
    },
  ],
});