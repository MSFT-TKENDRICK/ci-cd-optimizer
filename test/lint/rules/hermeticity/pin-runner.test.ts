import rule from "../../../../src/lint/rules/hermeticity/pin-runner.js";
import { ruleTester } from "../../rule-tester.js";

const job = (runsOn: string, extra = "") => `on: push\njobs:\n  b:\n${extra}    runs-on: ${runsOn}\n    steps:\n      - run: make\n`;

ruleTester(rule, {
  valid: [
    { name: "pinned ubuntu", files: job("ubuntu-24.04") },
    { name: "pinned windows and macos", files: "on: push\njobs:\n  w:\n    runs-on: windows-2025\n  m:\n    runs-on: macos-15\n" },
    { name: "self-hosted labels are never flagged", files: job("[self-hosted, ubuntu-latest]") },
    { name: "runner groups", files: job("\n      group: large\n      labels: ubuntu-latest") },
    { name: "expressions other than matrix refs are unknown", files: job("${{ inputs.runner }}") },
    {
      name: "matrix with pinned values",
      files: job("${{ matrix.os }}", "    strategy:\n      matrix:\n        os: [ubuntu-24.04, windows-2025]\n"),
    },
    { name: "reusable workflow jobs have no runner", files: "on: push\njobs:\n  call:\n    uses: ./.github/workflows/r.yml\n" },
  ],
  invalid: [
    {
      name: "ubuntu-latest is fixed to the current image",
      files: job("ubuntu-latest"),
      errors: [{ line: 4, messageIncludes: "Ubuntu 26.04" }],
      output: job("ubuntu-24.04"),
    },
    {
      name: "windows and macos use their options",
      files: "on: push\njobs:\n  w:\n    runs-on: windows-latest\n  m:\n    runs-on: 'macos-latest'\n",
      errors: [
        { line: 4, messageIncludes: "windows-latest" },
        { line: 6, messageIncludes: "macos-latest" },
      ],
      output: "on: push\njobs:\n  w:\n    runs-on: windows-2025\n  m:\n    runs-on: 'macos-15'\n",
    },
    {
      name: "options override the pinned label",
      files: job("Ubuntu-Latest"),
      options: { ubuntu: "ubuntu-26.04" },
      errors: 1,
      output: job("ubuntu-26.04"),
    },
    {
      name: "array runs-on reports the item line",
      files: "on: push\njobs:\n  b:\n    runs-on:\n      - ubuntu-latest\n      - gpu\n",
      errors: [{ line: 5 }],
      output: "on: push\njobs:\n  b:\n    runs-on:\n      - ubuntu-24.04\n      - gpu\n",
    },
    {
      name: "labels object form",
      files: job("\n      labels: [ubuntu-latest]"),
      errors: [{ line: 5 }],
      output: job("\n      labels: [ubuntu-24.04]"),
    },
    {
      name: "matrix values are reported on their own lines without a fix",
      files: job(
        "${{ matrix.os }}",
        "    strategy:\n      matrix:\n        os:\n          - ubuntu-latest\n          - windows-latest\n        include:\n          - os: macos-latest\n",
      ),
      errors: [{ line: 7 }, { line: 8 }, { line: 10 }],
      output: job(
        "${{ matrix.os }}",
        "    strategy:\n      matrix:\n        os:\n          - ubuntu-latest\n          - windows-latest\n        include:\n          - os: macos-latest\n",
      ),
    },
    {
      name: "aliased runs-on is reported at the anchor without a fix",
      files: "on: push\njobs:\n  a:\n    runs-on: &os ubuntu-latest\n  b:\n    runs-on: *os\n",
      errors: [{ line: 4 }],
      output: "on: push\njobs:\n  a:\n    runs-on: &os ubuntu-24.04\n  b:\n    runs-on: *os\n",
    },
  ],
});
