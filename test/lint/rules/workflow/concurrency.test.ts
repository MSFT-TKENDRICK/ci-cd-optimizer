import rule from "../../../../src/lint/rules/workflow/concurrency.js";
import { ruleTester } from "../../rule-tester.js";

const GROUP = "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}";
const CANCEL = "${{ github.event_name == 'pull_request' }}";

ruleTester(rule, {
  valid: [
    { files: `on: pull_request\nconcurrency:\n  group: ${GROUP}\n  cancel-in-progress: true\njobs:\n  t:\n    runs-on: x\n` },
    { name: "push-only workflows are not flagged", files: "on: push\njobs:\n  t:\n    runs-on: x\n" },
    { name: "every job has concurrency", files: "on: pull_request\njobs:\n  t:\n    runs-on: x\n    concurrency: t-${{ github.ref }}\n" },
    {
      name: "deploy workflow that queues",
      files: { ".github/workflows/deploy.yml": "on: push\nconcurrency:\n  group: deploy\njobs:\n  d:\n    runs-on: x\n    environment: prod\n" },
    },
    {
      name: "deploy workflows are never asked to cancel",
      files: { ".github/workflows/release.yml": "on: pull_request\njobs:\n  d:\n    runs-on: x\n" },
    },
  ],
  invalid: [
    {
      files: "on: pull_request\njobs:\n  t:\n    runs-on: x\n",
      errors: [{ line: 1, messageIncludes: "no concurrency group" }],
      output: `on: pull_request\nconcurrency:\n  group: ${GROUP}\n  cancel-in-progress: ${CANCEL}\n\njobs:\n  t:\n    runs-on: x\n`,
    },
    {
      name: "deploy cancelling in-progress runs",
      files: {
        ".github/workflows/deploy.yml": "on: push\nconcurrency:\n  group: deploy\n  cancel-in-progress: true\njobs:\n  d:\n    runs-on: x\n",
      },
      errors: [{ path: ".github/workflows/deploy.yml", messageIncludes: "cancels in-progress" }],
    },
    {
      name: "job environment marks a workflow as a deploy",
      files: "on: push\njobs:\n  d:\n    runs-on: x\n    environment: prod\n    concurrency:\n      group: d\n      cancel-in-progress: true\n",
      errors: 1,
    },
  ],
});
