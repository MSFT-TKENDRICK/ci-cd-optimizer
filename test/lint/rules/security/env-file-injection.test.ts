import rule from "../../../../src/lint/rules/security/env-file-injection.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const wf = (on: string, ...stepLines: string[]): string =>
  yml(`on: ${on}`, "permissions: {}", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", ...stepLines);

ruleTester(rule, {
  valid: [
    {
      name: "trusted value written to GITHUB_ENV",
      files: wf("pull_request", '      - run: echo "SHA=${{ github.sha }}" >> "$GITHUB_ENV"'),
    },
    {
      name: "branch name via env (refs cannot contain newlines)",
      files: wf(
        "pull_request",
        "      - env:",
        "          BRANCH: ${{ github.head_ref }}",
        '        run: echo "BRANCH=$BRANCH" >> "$GITHUB_ENV"',
      ),
    },
    {
      name: "untrusted expression echoed but not written to an env file",
      files: wf("issues", "      - env:", "          T: ${{ github.event.issue.title }}", '        run: echo "$T"'),
    },
  ],
  invalid: [
    {
      name: "untrusted value written to GITHUB_OUTPUT",
      files: wf("pull_request_target", '      - run: echo "title=${{ github.event.pull_request.title }}" >> "$GITHUB_OUTPUT"'),
      errors: 1,
    },
    {
      name: "issue title written to GITHUB_ENV",
      files: wf("issues", '      - run: echo "TITLE=${{ github.event.issue.title }}" >> $GITHUB_ENV'),
      errors: [{ line: 7, messageIncludes: "GITHUB_ENV" }],
    },
    {
      name: "PR body written to GITHUB_OUTPUT",
      files: wf("pull_request", '      - run: echo "body=${{ github.event.pull_request.body }}" >> "$GITHUB_OUTPUT"'),
      errors: 1,
    },
    {
      name: "tainted env var written to GITHUB_ENV",
      files: wf(
        "issue_comment",
        "      - env:",
        "          BODY: ${{ github.event.comment.body }}",
        '        run: echo "BODY=$BODY" >> "$GITHUB_ENV"',
      ),
      errors: 1,
    },
  ],
});