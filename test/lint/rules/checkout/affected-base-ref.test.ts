import rule from "../../../../src/lint/rules/checkout/affected-base-ref.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const job = (...stepLines: string[]): string =>
  yml("on: pull_request", "jobs:", "  test:", "    runs-on: ubuntu-24.04", "    steps:", ...stepLines);

ruleTester(rule, {
  valid: [
    {
      name: "full history",
      files: job("      - uses: actions/checkout@v7", "        with:", "          fetch-depth: 0", "      - run: npx nx affected -t test"),
    },
    {
      name: "nx-set-shas handles the base",
      files: job("      - uses: actions/checkout@v7", "      - uses: nrwl/nx-set-shas@v5", "      - run: npx nx affected -t test"),
    },
    {
      name: "explicit fetch of the base before the command",
      files: job(
        "      - uses: actions/checkout@v7",
        "      - run: |",
        "          git fetch --no-tags --depth=50 origin ${{ github.base_ref }}",
        "          npx turbo run test --affected",
      ),
    },
    {
      name: "expression depth is trusted",
      files: job(
        "      - uses: actions/checkout@v7",
        "        with:",
        "          fetch-depth: ${{ inputs.depth }}",
        "      - run: pnpm --filter '...[origin/main]' test",
      ),
    },
    {
      name: "commands that do not diff against a base",
      files: job("      - uses: actions/checkout@v7", "      - run: npx nx run-many -t test", "      - run: git diff --exit-code"),
    },
    {
      name: "checkouts of other repositories do not count",
      files: job(
        "      - uses: actions/checkout@v7",
        "        with:",
        "          fetch-depth: 0",
        "      - uses: actions/checkout@v7",
        "        with:",
        "          repository: org/tools",
        "          path: tools",
        "      - run: npx nx affected -t lint",
      ),
    },
  ],
  invalid: [
    {
      name: "nx affected after a default checkout",
      files: job("      - uses: actions/checkout@v7", "      - run: npx nx affected -t test --base=origin/main"),
      errors: [{ line: 7, messageIncludes: "`nx affected` needs the base commit" }],
    },
    {
      name: "explicit fetch-depth 1 with turbo and jest in a multi-line script",
      files: job(
        "      - uses: actions/checkout@v7",
        "        with:",
        "          fetch-depth: 1",
        "      - run: |",
        "          npx turbo run build --filter=...[origin/main]",
        "          npx jest --changedSince=origin/main",
      ),
      errors: [
        { line: 10, messageIncludes: "turbo --filter" },
        { line: 11, messageIncludes: "jest --changedSince" },
      ],
    },
    {
      name: "git fetch after the command does not help",
      files: job(
        "      - uses: actions/checkout@v7",
        "      - run: git diff --name-only origin/main...HEAD",
        "      - run: git fetch origin main",
      ),
      errors: [{ line: 7, messageIncludes: "git diff against the base" }],
    },
    {
      name: "commands inside a composite action are reported in the action file",
      files: {
        ".github/workflows/ci.yml": job("      - uses: actions/checkout@v7", "      - uses: ./.github/actions/test"),
        ".github/actions/test/action.yml": yml(
          "name: test",
          "runs:",
          "  using: composite",
          "  steps:",
          "    - run: pnpm --filter \"...[origin/main]\" test",
          "      shell: bash",
        ),
      },
      errors: [{ path: ".github/actions/test/action.yml", line: 5, messageIncludes: "pnpm --filter" }],
    },
    {
      name: "bare vitest --changed has no base at all",
      files: job("      - uses: actions/checkout@v7", "      - run: npx vitest run --changed"),
      errors: [{ line: 7, messageIncludes: "without a base ref" }],
    },
  ],
});
