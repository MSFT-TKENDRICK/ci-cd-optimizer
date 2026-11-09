import rule from "../../../../src/lint/rules/redundancy/duplicate-setup-step.js";
import { ruleTester } from "../../rule-tester.js";

const job = (steps: string) => `on: push
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
${steps}`;

ruleTester(rule, {
  valid: [
    {
      name: "single setup step",
      files: job(`      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci`),
    },
    {
      name: "two different toolchains",
      files: job(`      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"`),
    },
    {
      name: "same action installing two versions",
      files: job(`      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm test
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test`),
    },
    {
      name: "different conditions",
      files: job(`      - uses: actions/setup-node@v4
        if: runner.os == 'Linux'
        with:
          node-version: 22
      - uses: actions/setup-node@v4
        if: runner.os != 'Linux'
        with:
          node-version: 22`),
    },
    {
      name: "repeat with an id is kept for its outputs",
      files: job(`      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - id: node
        uses: actions/setup-node@v4
        with:
          node-version: 22`),
    },
    {
      name: "same setup in different jobs",
      files: `on: push
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/setup-go@v5
  b:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/setup-go@v5`,
    },
    {
      name: "non-setup action repeated",
      files: job(`      - uses: actions/checkout@v4
      - uses: actions/checkout@v4`),
    },
  ],
  invalid: [
    {
      files: job(`      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Setup node again
        uses: actions/setup-node@v4
        with:
          node-version: 22`),
      errors: [{ line: 10, messageIncludes: "actions/setup-node" }],
    },
    {
      name: "same inputs in a different order and ref",
      files: job(`      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip
      - uses: actions/setup-python@v6
        with:
          cache: pip
          python-version: "3.12"`),
      errors: 1,
    },
    {
      name: "composite action",
      files: {
        ".github/actions/setup/action.yml": `name: setup
description: setup
runs:
  using: composite
  steps:
    - uses: actions/setup-java@v4
      with:
        java-version: 21
        distribution: temurin
    - uses: actions/setup-java@v4
      with:
        java-version: 21
        distribution: temurin
`,
      },
      errors: [{ path: ".github/actions/setup/action.yml", line: 10 }],
    },
  ],
});
