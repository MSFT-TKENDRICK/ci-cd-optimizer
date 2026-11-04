import rule from "../../../../src/lint/rules/checkout/partial-clone.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const job = (...stepLines: string[]): string =>
  yml("on: pull_request", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", ...stepLines);

ruleTester(rule, {
  valid: [
    { name: "default shallow checkout", files: job("      - uses: actions/checkout@v7") },
    {
      name: "already blobless",
      files: job("      - uses: actions/checkout@v7", "        with:", "          fetch-depth: 0", "          filter: blob:none"),
    },
    {
      name: "sparse checkout is left alone",
      files: job("      - uses: actions/checkout@v7", "        with:", "          fetch-depth: 0", "          sparse-checkout: packages/web"),
    },
    {
      name: "expression depth is trusted",
      files: job("      - uses: actions/checkout@v7", "        with:", "          fetch-depth: ${{ inputs.depth }}"),
    },
    {
      name: "bounded depth is fine",
      files: job("      - uses: actions/checkout@v7", "        with:", "          fetch-depth: 50"),
    },
  ],
  invalid: [
    {
      name: "full history is fixed with filter: blob:none",
      files: job(
        "      - uses: actions/checkout@v7",
        "        with:",
        "          fetch-depth: 0 # needed for nx affected",
        "      - run: npx nx affected -t test",
      ),
      errors: [{ line: 8, messageIncludes: "full history" }],
      output: job(
        "      - uses: actions/checkout@v7",
        "        with:",
        "          fetch-depth: 0 # needed for nx affected",
        "          filter: blob:none",
        "      - run: npx nx affected -t test",
      ),
    },
    {
      name: "quoted zero inside a composite action",
      files: {
        ".github/actions/setup/action.yml": yml(
          "name: setup",
          "runs:",
          "  using: composite",
          "  steps:",
          "    - uses: actions/checkout@v7",
          "      with:",
          "        fetch-depth: '0'",
          "        ref: main",
        ),
      },
      errors: [{ path: ".github/actions/setup/action.yml", line: 7 }],
      output: {
        ".github/actions/setup/action.yml": yml(
          "name: setup",
          "runs:",
          "  using: composite",
          "  steps:",
          "    - uses: actions/checkout@v7",
          "      with:",
          "        fetch-depth: '0'",
          "        filter: blob:none",
          "        ref: main",
        ),
      },
    },
    {
      name: "aliased with block: reported without a fix",
      files: yml(
        "x-full: &full",
        "  fetch-depth: 0",
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-24.04",
        "    steps:",
        "      - uses: actions/checkout@v7",
        "        with: *full",
      ),
      errors: 1,
      output: yml(
        "x-full: &full",
        "  fetch-depth: 0",
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-24.04",
        "    steps:",
        "      - uses: actions/checkout@v7",
        "        with: *full",
      ),
    },
    {
      name: "merged fetch-depth: reported without a fix",
      files: yml(
        "x-full: &full",
        "  fetch-depth: 0",
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-24.04",
        "    steps:",
        "      - uses: actions/checkout@v7",
        "        with:",
        "          <<: *full",
        "          ref: main",
      ),
      errors: 1,
      output: yml(
        "x-full: &full",
        "  fetch-depth: 0",
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-24.04",
        "    steps:",
        "      - uses: actions/checkout@v7",
        "        with:",
        "          <<: *full",
        "          ref: main",
      ),
    },
    {
      name: "flow mapping: reported without a fix",
      files: job("      - uses: actions/checkout@v7", "        with: { fetch-depth: 0 }"),
      errors: [{ line: 7 }],
      output: job("      - uses: actions/checkout@v7", "        with: { fetch-depth: 0 }"),
    },
    {
      name: "checkout older than v4.1 is told to upgrade instead of fixed",
      files: job("      - uses: actions/checkout@v3", "        with:", "          fetch-depth: 0"),
      errors: [{ line: 8 }],
      output: job("      - uses: actions/checkout@v3", "        with:", "          fetch-depth: 0"),
    },
  ],
});
