import rule from "../../../../src/lint/rules/workflow/artifact-retention.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const job = (...stepLines: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", ...stepLines);

ruleTester(rule, {
  valid: [
    {
      name: "retention within the default maximum",
      files: job(
        "      - uses: actions/upload-artifact@v7",
        "        with:",
        "          name: dist",
        "          path: dist/",
        "          retention-days: 5",
      ),
    },
    {
      name: "expression retention is trusted",
      files: job(
        "      - uses: actions/upload-artifact@v7",
        "        with:",
        "          path: dist/",
        "          retention-days: ${{ inputs.days }}",
      ),
    },
    {
      name: "custom maximum",
      files: job(
        "      - uses: actions/upload-artifact@v7",
        "        with:",
        "          path: dist/",
        "          retention-days: 30",
      ),
      options: { maxDays: 30 },
    },
    {
      name: "other actions are ignored",
      files: job("      - uses: actions/download-artifact@v8", "        with:", "          name: dist"),
    },
    {
      name: "retention inherited through a merge key counts",
      files: yml(
        "x-upload: &upload",
        "  retention-days: 3",
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-24.04",
        "    steps:",
        "      - uses: actions/upload-artifact@v7",
        "        with:",
        "          <<: *upload",
        "          path: dist/",
      ),
    },
  ],
  invalid: [
    {
      name: "missing retention-days is fixed after the last entry",
      files: job(
        "      - uses: actions/upload-artifact@v7",
        "        with:",
        "          name: dist",
        "          path: dist/",
        "      - run: echo done",
      ),
      errors: [{ line: 6, messageIncludes: "no retention-days" }],
      output: job(
        "      - uses: actions/upload-artifact@v7",
        "        with:",
        "          name: dist",
        "          path: dist/",
        "          retention-days: 7",
        "      - run: echo done",
      ),
    },
    {
      name: "block scalar last entry inserts before the first entry with configured days",
      files: job(
        "      - uses: actions/upload-artifact@v7",
        "        with:",
        "          name: dist",
        "          path: |",
        "            dist/",
        "            coverage/",
      ),
      options: { maxDays: 3 },
      errors: 1,
      output: job(
        "      - uses: actions/upload-artifact@v7",
        "        with:",
        "          retention-days: 3",
        "          name: dist",
        "          path: |",
        "            dist/",
        "            coverage/",
      ),
    },
    {
      name: "literal retention above the maximum is reported without a fix",
      files: job(
        "      - uses: actions/upload-artifact@v7",
        "        with:",
        "          path: dist/",
        "          retention-days: 90",
      ),
      errors: [{ line: 9, messageIncludes: "kept for 90 days" }],
    },
    {
      name: "retention-days 0 falls back to the repository default",
      files: job(
        "      - uses: actions/upload-artifact@v7",
        "        with:",
        "          path: dist/",
        "          retention-days: '0'",
      ),
      errors: [{ line: 9, messageIncludes: "repository default" }],
    },
    {
      name: "no with block: reported without a fix",
      files: job("      - uses: actions/upload-artifact/merge@v7"),
      errors: [{ line: 6 }],
      output: job("      - uses: actions/upload-artifact/merge@v7"),
    },
    {
      name: "aliased with block: reported without a fix",
      files: yml(
        "x-with: &with",
        "  path: dist/",
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-24.04",
        "    steps:",
        "      - uses: actions/upload-artifact@v7",
        "        with: *with",
      ),
      errors: 1,
      output: yml(
        "x-with: &with",
        "  path: dist/",
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-24.04",
        "    steps:",
        "      - uses: actions/upload-artifact@v7",
        "        with: *with",
      ),
    },
    {
      name: "flow-style with block: reported without a fix",
      files: job("      - uses: actions/upload-artifact@v7", "        with: { path: dist/ }"),
      errors: 1,
      output: job("      - uses: actions/upload-artifact@v7", "        with: { path: dist/ }"),
    },
    {
      name: "composite actions are checked and fixed in place",
      files: {
        ".github/actions/publish/action.yml": yml(
          "name: publish",
          "runs:",
          "  using: composite",
          "  steps:",
          "    - uses: actions/upload-artifact@v7",
          "      with:",
          "        path: out/",
        ),
      },
      errors: [{ path: ".github/actions/publish/action.yml", line: 5 }],
      output: {
        ".github/actions/publish/action.yml": yml(
          "name: publish",
          "runs:",
          "  using: composite",
          "  steps:",
          "    - uses: actions/upload-artifact@v7",
          "      with:",
          "        path: out/",
          "        retention-days: 7",
        ),
      },
    },
  ],
});
