import rule from "../../../../src/lint/rules/affected/trusted-change-detection.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const step = (...lines: string[]): string =>
  yml("on: pull_request", "jobs:", "  changes:", "    runs-on: ubuntu-24.04", "    steps:", ...lines);

const SAFE_SHA = "2f7c5bfce28377bc069a65ba478de0a74aa0ca32";
const MALICIOUS_SHA = "0e58ed8671d6b60d0890c21b07f8835ace038e67";

ruleTester(rule, {
  valid: [
    {
      name: "patched tags and moving v46 tag",
      files: step(
        "      - uses: tj-actions/changed-files@v46.0.1",
        "      - uses: tj-actions/changed-files@v46",
        "      - uses: tj-actions/changed-files@v47.0.0",
      ),
    },
    {
      name: "SHA pins without a vulnerable version comment",
      files: step(`      - uses: tj-actions/changed-files@${SAFE_SHA}`, `      - uses: tj-actions/changed-files@${SAFE_SHA} # v46.0.5`),
    },
    {
      name: "branches and expressions are not versions",
      files: step("      - uses: tj-actions/changed-files@main", "      - uses: dorny/paths-filter@v4"),
    },
    {
      name: "other actions with old versions",
      files: step("      - uses: step-security/changed-files@v45", "      - uses: tj-actions/branch-names@v8"),
    },
  ],
  invalid: [
    {
      name: "old major tag",
      files: step("      - uses: tj-actions/changed-files@v45", "        with:", "          files: src/**"),
      errors: [{ line: 6, messageIncludes: "tj-actions/changed-files@v45 is in the range affected by CVE-2025-30066 (GHSA-mrrh-fwg8-r2c3)" }],
    },
    {
      name: "v46.0.0 and v35.7.1",
      files: step("      - uses: tj-actions/changed-files@v46.0.0", "      - uses: TJ-Actions/changed-files@v35.7.1"),
      errors: [
        { line: 6, messageIncludes: "@v46.0.0" },
        { line: 7, messageIncludes: "@v35.7.1" },
      ],
    },
    {
      name: "SHA pin whose comment shows a vulnerable version",
      files: step(`      - uses: tj-actions/changed-files@${SAFE_SHA} # v44.5.1`),
      errors: [{ line: 6, messageIncludes: "@2f7c5bf (v44.5.1)" }],
    },
    {
      name: "the malicious commit itself",
      files: step(`      - uses: tj-actions/changed-files@${MALICIOUS_SHA} # v46.0.1`),
      errors: [{ line: 6, messageIncludes: "the malicious commit" }],
    },
    {
      name: "inside a composite action",
      files: {
        ".github/actions/changes/action.yml": yml(
          "name: changes",
          "runs:",
          "  using: composite",
          "  steps:",
          "    - uses: tj-actions/changed-files@v41",
        ),
      },
      errors: [{ path: ".github/actions/changes/action.yml", line: 5, messageIncludes: "@v41" }],
    },
  ],
});
