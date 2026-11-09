import rule from "../../../../src/lint/rules/security/untrusted-checkout.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const wf = (on: string, ...stepLines: string[]): string =>
  yml(`on: ${on}`, "permissions: {}", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", ...stepLines);

const prHead = [
  "      - uses: actions/checkout@v5",
  "        with:",
  "          ref: ${{ github.event.pull_request.head.sha }}",
];

ruleTester(rule, {
  valid: [
    {
      name: "build-push without a context builds the git ref, not the checked-out workspace",
      files: wf("pull_request_target", ...prHead, "      - uses: docker/build-push-action@v6", "        with:", "          push: false"),
    },
    {
      name: "setup-node cache only hashes lockfiles",
      files: wf("pull_request_target", ...prHead, "      - uses: actions/setup-node@v4", "        with:", "          cache: npm"),
    },
    {
      name: "pull_request_target checking out the base",
      files: wf("pull_request_target", "      - uses: actions/checkout@v5", "      - run: npm test"),
    },
    {
      name: "pull_request can check out the head safely",
      files: wf("pull_request", ...prHead, "      - run: npm test"),
    },
    {
      name: "head checkout with no later execution",
      files: wf("pull_request_target", "      - run: echo labeling", ...prHead),
    },
  ],
  invalid: [
    {
      name: "an action that runs workspace code (cypress)",
      files: wf("pull_request_target", ...prHead, "      - uses: cypress-io/github-action@v6"),
      errors: 1,
    },
    {
      name: "build-push with a local context",
      files: wf("pull_request_target", ...prHead, "      - uses: docker/build-push-action@v6", "        with:", "          context: ."),
      errors: 1,
    },
    {
      name: "pull_request_target runs head code",
      files: wf("pull_request_target", ...prHead, "      - run: npm install && npm test"),
      errors: [{ line: 7, messageIncludes: "untrusted pull request code" }],
    },
    {
      name: "workflow_run checks out the triggering head sha",
      files: wf(
        "workflow_run",
        "      - uses: actions/checkout@v5",
        "        with:",
        "          ref: ${{ github.event.workflow_run.head_sha }}",
        "      - uses: ./.github/actions/build",
      ),
      errors: 1,
    },
    {
      name: "gh pr checkout followed by a build",
      files: wf(
        "pull_request_target",
        "      - run: gh pr checkout ${{ github.event.pull_request.number }}",
        "      - run: make",
      ),
      errors: 1,
    },
  ],
});