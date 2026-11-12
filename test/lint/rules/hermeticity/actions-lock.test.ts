import rule from "../../../../src/lint/rules/hermeticity/actions-lock.js";
import { ruleTester } from "../../rule-tester.js";

const SHA = "08eba0b27e820071cde6df949e0beb9ba4906955";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const workflow = (run = "npm test") => `on: [pull_request, push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7.0.1
      - run: ${run}
`;
const pinnedWorkflow = workflow().replace("actions/checkout@v7.0.1", `actions/checkout@${SHA}`);
const lock = (workflowEntries = `'${WORKFLOW_PATH}':
    - 'actions/checkout@v7.0.1'`) => `version: 'v0.0.3'
workflows:
  ${workflowEntries}
dependencies:
  'actions/checkout@v7.0.1':
    ref: 'v7.0.1'
    commit: 'sha1-${SHA}'
    owner_id: 44036562
    repo_id: 197814629
`;
const files = (workflowBody = workflow(), lockBody = lock()) => ({
  [WORKFLOW_PATH]: workflowBody,
  ".github/workflows/actions.lock": lockBody,
});

ruleTester(rule, {
  valid: [
    { name: "no remote action dependencies", files: "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n" },
    { name: "full SHA pins do not require a lockfile", files: { [WORKFLOW_PATH]: pinnedWorkflow } },
    { name: "covered actions with networked verification", files: files(workflow("gh actions-lock --verify")) },
    {
      name: "remote reusable workflows are outside the action lock",
      files: "on: push\njobs:\n  call:\n    uses: owner/repo/.github/workflows/ci.yml@main\n",
    },
    {
      name: "missing lockfile in a partial inventory is unknown",
      files: { [WORKFLOW_PATH]: workflow() },
      inventoryComplete: false,
    },
  ],
  invalid: [
    {
      name: "missing lockfile",
      files: { [WORKFLOW_PATH]: workflow() },
      errors: [{ path: WORKFLOW_PATH, messageIncludes: "not covered" }],
    },
    {
      name: "workflow not onboarded",
      files: files(workflow("gh actions-lock --verify"), "version: 'v0.0.3'\nworkflows: {}\ndependencies: {}\n"),
      errors: [{ path: WORKFLOW_PATH, messageIncludes: "not onboarded" }],
    },
    {
      name: "dependency omitted from workflow list",
      files: files(workflow("gh actions-lock --verify"), lock(`'${WORKFLOW_PATH}': []`)),
      errors: [{ path: WORKFLOW_PATH, messageIncludes: "missing from this workflow's lockfile entry" }],
    },
    {
      name: "dependency metadata omitted",
      files: files(workflow("gh actions-lock --verify"), `version: 'v0.0.3'
workflows:
  '${WORKFLOW_PATH}':
    - 'actions/checkout@v7.0.1'
dependencies: {}
`),
      errors: [{ path: ".github/workflows/actions.lock", messageIncludes: "no valid dependency metadata" }],
    },
    {
      name: "malformed dependency identity is rejected",
      files: files(workflow("gh actions-lock --verify"), lock().replace(`sha1-${SHA}`, "sha1-short")),
      errors: [{ path: ".github/workflows/actions.lock", messageIncludes: "sha1 commit" }],
    },
    {
      name: "dependency metadata must describe the ref in its key",
      files: files(workflow("gh actions-lock --verify"), lock().replace("ref: 'v7.0.1'", "ref: 'v7.0'")),
      errors: [{ path: ".github/workflows/actions.lock", messageIncludes: "sha1 commit" }],
    },
    {
      name: "action ref casing must match the locked ref",
      files: files(workflow("gh actions-lock --verify").replace("checkout@v7.0.1", "checkout@V7.0.1"), lock()),
      errors: [{ path: WORKFLOW_PATH, messageIncludes: "missing from this workflow's lockfile entry" }],
    },
    {
      name: "verify-local is not networked provenance verification",
      files: files(workflow("gh actions-lock --verify-local")),
      errors: [{ path: ".github/workflows/actions.lock", messageIncludes: "No pull-request or push workflow" }],
    },
    {
      name: "stale workflow entries are reported",
      files: files(workflow("gh actions-lock --verify"), lock(`'${WORKFLOW_PATH}':
    - 'actions/checkout@v7.0.1'
  '.github/workflows/deleted.yml':
    - 'actions/checkout@v7.0.1'`)),
      errors: [{ path: ".github/workflows/actions.lock", messageIncludes: "missing workflow" }],
    },
    {
      name: "accept-moved is never recommended in automation",
      files: files(workflow("gh actions-lock --verify --accept-moved")),
      errors: [{ path: WORKFLOW_PATH, messageIncludes: "do not use it in automation" }],
    },
  ],
});
