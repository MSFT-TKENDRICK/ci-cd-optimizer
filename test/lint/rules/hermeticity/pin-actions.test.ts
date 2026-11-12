import rule from "../../../../src/lint/rules/hermeticity/pin-actions.js";
import { ruleTester } from "../../rule-tester.js";

const SHA = "08eba0b27e820071cde6df949e0beb9ba4906955";
const wf = (body: string) => `on: push\njobs:\n  b:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;
const locked = {
  ".github/workflows/ci.yml": wf("      - uses: actions/checkout@v7.0.1\n"),
  ".github/workflows/actions.lock": `version: 'v0.0.3'
workflows:
  '.github/workflows/ci.yml':
    - 'actions/checkout@v7.0.1'
dependencies:
  'actions/checkout@v7.0.1':
    ref: 'v7.0.1'
    commit: 'sha1-${SHA}'
    owner_id: 44036562
    repo_id: 197814629
`,
};

ruleTester(rule, {
  valid: [
    { name: "SHA pinned with version comment", files: wf(`      - uses: actions/checkout@${SHA} # v6.0.0\n`) },
    { name: "local actions", files: wf("      - uses: ./.github/actions/setup\n") },
    { name: "expressions are unknown", files: wf("      - uses: ${{ matrix.action }}\n") },
    {
      name: "docker image pinned by digest",
      files: wf(`      - uses: docker://alpine:3.22@sha256:${"a".repeat(64)}\n`),
    },
    { name: "ignored owners (case-insensitive)", files: wf("      - uses: Actions/checkout@v6\n      - uses: my-org/build@main\n"), options: { ignoreOwners: ["actions", "My-Org"] } },
    { name: "local reusable workflow", files: "on: push\njobs:\n  call:\n    uses: ./.github/workflows/reusable.yml\n" },
    { name: "pinned reusable workflow", files: `on: push\njobs:\n  call:\n    uses: o/r/.github/workflows/build.yml@${SHA}\n` },
    { name: "lockfile-covered action does not need a workflow SHA pin", files: locked },
  ],
  invalid: [
    { name: "tag", files: wf("      - uses: actions/checkout@v6\n"), errors: [{ line: 6, messageIncludes: "mutable ref `v6`" }] },
    { name: "branch", files: wf("      - uses: some/action@main\n"), errors: [{ messageIncludes: "`main`" }] },
    { name: "short SHA", files: wf("      - uses: some/action@08eba0b\n"), errors: [{ messageIncludes: "short SHA" }] },
    { name: "no ref", files: wf("      - uses: some/action\n"), errors: [{ messageIncludes: "has no ref" }] },
    { name: "docker image by tag", files: wf("      - uses: docker://alpine:3.22\n"), errors: [{ line: 6, messageIncludes: "sha256" }] },
    {
      name: "reusable workflow by tag",
      files: "on: push\njobs:\n  call:\n    uses: o/r/.github/workflows/build.yml@v2\n",
      errors: [{ line: 4, messageIncludes: "Reusable workflow" }],
    },
    {
      name: "lockfile coverage is per workflow",
      files: {
        ...locked,
        ".github/workflows/other.yml": wf("      - uses: actions/checkout@v7.0.1\n"),
      },
      errors: [{ path: ".github/workflows/other.yml", messageIncludes: "mutable ref" }],
    },
    {
      name: "ignoreOwners only skips listed owners",
      files: wf("      - uses: actions/checkout@v6\n      - uses: other/action@v1\n"),
      options: { ignoreOwners: ["actions"] },
      errors: [{ line: 7 }],
    },
    {
      name: "composite actions",
      files: { "action.yml": "runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v7\n" },
      errors: [{ path: "action.yml", line: 4 }],
    },
  ],
});
