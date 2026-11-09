import rule from "../../../../src/lint/rules/security/expression-injection.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const wf = (on: string, ...stepLines: string[]): string =>
  yml(`on: ${on}`, "permissions: {}", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", ...stepLines);

ruleTester(rule, {
  valid: [
    {
      name: "untrusted value passed via env",
      files: wf(
        "pull_request",
        "      - env:",
        "          TITLE: ${{ github.event.pull_request.title }}",
        '        run: echo "$TITLE"',
      ),
    },
    {
      name: "trusted contexts are fine",
      files: wf("pull_request", "      - run: echo ${{ github.event.pull_request.number }} ${{ github.sha }}"),
    },
    {
      name: "untrusted text outside an expression is ignored",
      files: wf("push", "      - run: echo github.event.head_commit.message"),
    },
    {
      name: "github-script reading the payload via context",
      files: wf(
        "issues",
        "      - uses: actions/github-script@v7",
        "        with:",
        "          script: console.log(context.payload.issue.title)",
      ),
    },
  ],
  invalid: [
    {
      name: "bracket property access is normalized",
      files: wf("pull_request_target", "      - run: echo \"${{ github.event['pull_request']['title'] }}\""),
      errors: 1,
    },
    {
      name: "pull request title in run",
      files: wf("pull_request", '      - run: echo "${{ github.event.pull_request.title }}"'),
      errors: [{ line: 7, messageIncludes: "github.event.pull_request.title" }],
    },
    {
      name: "head_ref in a multi-line script",
      files: wf("pull_request", "      - run: |", "          echo start", "          git switch ${{ github.head_ref }}"),
      errors: [{ line: 9, messageIncludes: "github.head_ref" }],
    },
    {
      name: "comment body in github-script",
      files: wf(
        "issue_comment",
        "      - uses: actions/github-script@v7",
        "        with:",
        "          script: |",
        '            const body = "${{ github.event.comment.body }}"',
      ),
      errors: 1,
    },
    {
      name: "head commit message on push",
      files: wf("push", "      - run: echo '${{ github.event.head_commit.message }}'"),
      errors: 1,
    },
  ],
});