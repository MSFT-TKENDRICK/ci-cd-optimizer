import rule from "../../../../src/lint/rules/workflow/larger-runner-unjustified.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const job = (runsOn: string, ...stepLines: string[]): string =>
  yml("on: pull_request", "jobs:", "  format:", `    runs-on: ${runsOn}`, "    steps:", "      - uses: actions/checkout@v5", ...stepLines);

const withManifest = (workflow: string, scripts: Record<string, string>): Record<string, string> => ({
  ".github/workflows/ci.yml": workflow,
  "package.json": JSON.stringify({ name: "app", scripts }),
});

ruleTester(rule, {
  valid: [
    {
      name: "standard runner",
      files: job("ubuntu-latest", "      - run: npx prettier --check ."),
    },
    {
      name: "larger runner that builds",
      files: job("ubuntu-24.04-16core", "      - run: npm ci", "      - run: npm run build"),
    },
    {
      name: "trap: eslint script may do type-aware linting, which is CPU bound",
      files: withManifest(job("ubuntu-24.04-8core", "      - run: npm ci", "      - run: npm run lint"), {
        lint: "tsc --noEmit && eslint .",
      }),
    },
    {
      name: "trap: self-hosted runner label with cores",
      files: job("[self-hosted, linux-16-cores]", "      - run: npx prettier --check ."),
    },
    {
      name: "trap: runner chosen by expression",
      files: job("${{ matrix.runner }}", "      - run: npx prettier --check ."),
    },
    {
      name: "trap: 2-core label is not a larger runner",
      files: job("ubuntu-2-cores", "      - run: npx prettier --check ."),
    },
    {
      name: "trap: piped command may do real work",
      files: job("ubuntu-24.04-16core", "      - run: npx prettier --list-different . | xargs ./check.sh"),
    },
    {
      name: "trap: job with service containers",
      files: yml(
        "on: pull_request",
        "jobs:",
        "  format:",
        "    runs-on: ubuntu-24.04-16core",
        "    services:",
        "      db:",
        "        image: postgres:17",
        "    steps:",
        "      - run: npx prettier --check .",
      ),
    },
  ],
  invalid: [
    {
      name: "16-core Linux runner for prettier",
      files: job("ubuntu-24.04-16core", "      - uses: actions/setup-node@v6", "      - run: npm ci", "      - run: npx prettier --check ."),
      errors: [
        {
          line: 4,
          messageIncludes:
            "Job `format` runs on larger runner `ubuntu-24.04-16core` but only checks out, sets up tools, installs dependencies and runs formatters or linters, which gain little from extra cores. If it is a GitHub-hosted linux x64 16-core runner it bills $0.042/min versus $0.006/min for a standard Linux 2-core (x64) runner",
        },
      ],
    },
    {
      name: "Windows 8-core runner running a format-only npm script",
      files: withManifest(job("windows-2025-8-cores", "      - run: npm ci", "      - run: npm run format:check"), {
        "format:check": "prettier --check . && actionlint",
      }),
      errors: [{ line: 4, messageIncludes: "$0.042/min versus $0.01/min for a standard Windows 2-core (x64) runner" }],
    },
    {
      name: "macOS xlarge runner that only prints information",
      files: job("macos-15-xlarge", "      - run: sw_vers --version", "      - run: echo done"),
      errors: [{ line: 4, messageIncludes: "$0.102/min versus $0.062/min" }],
    },
    {
      name: "custom larger-runner name without a known platform",
      files: job("[org-32-cores]", "      - run: npx --yes markdownlint-cli2 '**/*.md'"),
      errors: [{ line: 4, messageIncludes: "larger runner `org-32-cores`" }],
    },
  ],
});
