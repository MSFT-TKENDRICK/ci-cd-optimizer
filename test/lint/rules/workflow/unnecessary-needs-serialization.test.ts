import rule from "../../../../src/lint/rules/workflow/unnecessary-needs-serialization.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const PREPARE = [
  "  prepare:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v5",
  "      - run: npm ci",
];

const UNIT = (...needsLines: string[]): string[] => [
  "  unit:",
  ...needsLines,
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v5",
  "      - run: npm ci && npm test",
];

const workflow = (...jobLines: string[]): string => yml("on: push", "jobs:", ...jobLines);

ruleTester(rule, {
  valid: [
    {
      name: "upstream job with outputs",
      files: workflow(
        "  prepare:",
        "    runs-on: ubuntu-latest",
        "    outputs:",
        "      version: ${{ steps.v.outputs.version }}",
        "    steps:",
        "      - id: v",
        "        run: echo \"version=1\" >> \"$GITHUB_OUTPUT\"",
        ...UNIT("    needs: prepare"),
      ),
    },
    {
      name: "downstream reads the upstream result",
      files: workflow(...PREPARE, ...UNIT("    needs: prepare", "    env:", "      PREP: ${{ needs.prepare.result }}")),
    },
    {
      name: "upstream uploads an artifact",
      files: workflow(
        "  prepare:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v5",
        "      - uses: actions/upload-artifact@v7",
        "        with:",
        "          path: dist/",
        ...UNIT("    needs: prepare"),
      ),
    },
    {
      name: "trap: gate-named upstream (lint) is an intentional ordering",
      files: workflow(
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v5",
        "      - run: npm ci",
        ...UNIT("    needs: lint"),
      ),
    },
    {
      name: "trap: upstream build step may fail and gate the dependent job",
      files: workflow(
        "  prepare:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v5",
        "      - run: npm ci && npm run build",
        ...UNIT("    needs: prepare"),
      ),
    },
    {
      name: "trap: setup-node with a cache saves state the next job can restore",
      files: workflow(
        "  prepare:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v5",
        "      - uses: actions/setup-node@v6",
        "        with:",
        "          cache: npm",
        "      - run: npm ci",
        ...UNIT("    needs: prepare"),
      ),
    },
    {
      name: "trap: self-hosted upstream may share a machine with the dependent job",
      files: workflow(
        "  prepare:",
        "    runs-on: [self-hosted, linux]",
        "    steps:",
        "      - uses: actions/checkout@v5",
        "      - run: npm ci",
        ...UNIT("    needs: prepare"),
      ),
    },
    {
      name: "trap: deploy-like workflow (a job targets an environment)",
      files: workflow(
        ...PREPARE,
        "  ship:",
        "    needs: prepare",
        "    environment: production",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: ./deploy.sh",
      ),
    },
    {
      name: "trap: dependent job inspects the whole needs context",
      files: workflow(...PREPARE, ...UNIT("    needs: prepare", "    if: ${{ !contains(toJSON(needs), 'failure') }}")),
    },
  ],
  invalid: [
    {
      name: "scalar needs on a checkout+install job",
      files: workflow(...PREPARE, ...UNIT("    needs: prepare")),
      errors: [{ line: 9, messageIncludes: "Job `unit` needs `prepare`, but `prepare` only checks out, installs dependencies" }],
    },
    {
      name: "only the inert edge of a needs list is reported",
      files: workflow(
        ...PREPARE,
        "  lint:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm run lint",
        ...UNIT("    needs: [lint, prepare]"),
      ),
      errors: [{ line: 13, messageIncludes: "needs `prepare`" }],
    },
    {
      name: "block-sequence needs item line and toolchain-only upstream",
      files: workflow(
        "  tools:",
        "    runs-on: ubuntu-24.04",
        "    steps:",
        "      - uses: actions/setup-node@v6",
        "        with:",
        "          node-version: 22",
        "      - run: node --version",
        ...UNIT("    needs:", "      - tools"),
      ),
      errors: [{ line: 12, messageIncludes: "only sets up a toolchain, prints information" }],
    },
    {
      name: "echo-only upstream",
      files: workflow(
        "  hello:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo \"starting\" >> \"$GITHUB_STEP_SUMMARY\"",
        ...UNIT("    needs: hello"),
      ),
      errors: [{ line: 8, messageIncludes: "consider removing the edge" }],
    },
  ],
});
