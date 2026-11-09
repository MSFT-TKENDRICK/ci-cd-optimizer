import rule from "../../../../src/lint/rules/redundancy/toolchain-version-drift.js";
import { ruleTester } from "../../rule-tester.js";

const workflow = (action: string, input: string, value: string, extra = "") => `on: push
jobs:
  build:
    runs-on: ubuntu-24.04
${extra}    steps:
      - uses: ${action}
        with:
          ${input}: ${value}
`;

const node = (value: string) => workflow("actions/setup-node@v4", "node-version", value);

ruleTester(rule, {
  valid: [
    { name: "same version everywhere", files: { ".github/workflows/a.yml": node("22"), ".github/workflows/b.yml": node("'22'") } },
    { name: "compatible precision", files: { ".github/workflows/a.yml": node("20.x"), ".github/workflows/b.yml": node("20.11.1") } },
    {
      name: "version file",
      files: {
        ".github/workflows/a.yml": node("20"),
        ".github/workflows/b.yml": workflow("actions/setup-node@v4", "node-version-file", ".nvmrc"),
      },
    },
    { name: "aliases are ignored", files: { ".github/workflows/a.yml": node("lts/*"), ".github/workflows/b.yml": node("22") } },
    {
      name: "matrix expressions",
      files: {
        ".github/workflows/a.yml": node("${{ matrix.node }}"),
        ".github/workflows/b.yml": node("22"),
      },
    },
    {
      name: "jobs with a matrix are skipped",
      files: {
        ".github/workflows/a.yml": workflow("actions/setup-node@v4", "node-version", "20", "    strategy:\n      matrix:\n        os: [a, b]\n"),
        ".github/workflows/b.yml": node("22"),
      },
    },
    {
      name: "one file deliberately testing several versions",
      files: `on: push
jobs:
  node20:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
  node22:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
`,
    },
    {
      name: "different actions",
      files: {
        ".github/workflows/a.yml": node("20"),
        ".github/workflows/b.yml": workflow("actions/setup-go@v5", "go-version", "1.22"),
      },
    },
  ],
  invalid: [
    {
      files: { ".github/workflows/a.yml": node("20"), ".github/workflows/b.yml": node("22") },
      errors: [{ path: ".github/workflows/a.yml", line: 8, messageIncludes: "20, 22" }],
    },
    {
      name: "python minor versions are not collapsed by YAML",
      files: {
        ".github/workflows/a.yml": workflow("actions/setup-python@v5", "python-version", "3.10"),
        ".github/workflows/b.yml": workflow("actions/setup-python@v5", "python-version", "3.1"),
      },
      errors: [{ messageIncludes: "3.10, 3.1" }],
    },
    {
      name: "workflow and composite action",
      files: {
        ".github/workflows/a.yml": workflow("actions/setup-java@v4", "java-version", "17"),
        ".github/actions/setup/action.yml": `name: setup
description: setup
runs:
  using: composite
  steps:
    - uses: actions/setup-java@v4
      with:
        distribution: temurin
        java-version: "21"
`,
      },
      errors: 1,
    },
  ],
});
