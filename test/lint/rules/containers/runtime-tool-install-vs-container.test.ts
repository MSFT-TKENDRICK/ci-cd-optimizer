import rule from "../../../../src/lint/rules/containers/runtime-tool-install-vs-container.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const job = (id: string, runsOn: string, ...steps: string[]): string[] => [
  `  ${id}:`,
  `    runs-on: ${runsOn}`,
  "    steps:",
  ...steps.map((line) => `      ${line}`),
];

const workflow = (...jobs: string[][]): string => yml("on: push", "jobs:", ...jobs.flat());

ruleTester(rule, {
  valid: [
    {
      name: "a single job installs the tools",
      files: workflow(job("lint", "ubuntu-24.04", "- run: sudo apt-get install -y jq shellcheck")),
    },
    {
      name: "different package sets",
      files: workflow(
        job("lint", "ubuntu-24.04", "- run: sudo apt-get install -y jq shellcheck"),
        job("test", "ubuntu-24.04", "- run: sudo apt-get install -y jq"),
      ),
    },
    {
      name: "one of the jobs already runs in a container",
      files: workflow(
        job("lint", "ubuntu-24.04", "- run: sudo apt-get install -y jq"),
        ["  test:", "    runs-on: ubuntu-24.04", "    container: node:22", "    steps:", "      - run: apt-get install -y jq"],
      ),
    },
    {
      name: "project dependencies rather than tools",
      files: workflow(
        job("lint", "ubuntu-24.04", "- run: pip install -r requirements.txt"),
        job("test", "ubuntu-24.04", "- run: pip install -r requirements.txt"),
      ),
    },
    {
      name: "job that drives the Docker daemon",
      files: workflow(
        job("lint", "ubuntu-24.04", "- run: sudo apt-get install -y jq"),
        job("image", "ubuntu-24.04", "- run: sudo apt-get install -y jq", "- run: docker build -t app ."),
      ),
    },
    {
      name: "non-Ubuntu or computed runner labels",
      files: workflow(
        job("mac", "macos-14", "- run: npm install -g pnpm-lockfile-check"),
        job("matrix", "${{ matrix.os }}", "- run: npm install -g pnpm-lockfile-check"),
      ),
    },
    {
      name: "package names from variables",
      files: workflow(
        job("lint", "ubuntu-24.04", "- run: sudo apt-get install -y $TOOLS"),
        job("test", "ubuntu-24.04", "- run: sudo apt-get install -y $TOOLS"),
      ),
    },
  ],
  invalid: [
    {
      name: "same apt packages in a different order, reported once at the first job",
      files: workflow(
        job("lint", "ubuntu-24.04", "- uses: actions/checkout@v4", "- run: sudo apt-get install -y jq shellcheck"),
        job("test", "ubuntu-latest", "- run: |", "    sudo apt-get update", "    sudo apt-get install -y --no-install-recommends shellcheck jq"),
      ),
      errors: [
        {
          line: 7,
          messageIncludes:
            "installs `jq`, `shellcheck` at runtime in 2 jobs: `lint` (.github/workflows/ci.yml:7), `test` (.github/workflows/ci.yml:13)",
        },
      ],
    },
    {
      name: "pip tools across workflow files",
      files: {
        ".github/workflows/ci.yml": workflow(job("lint", "ubuntu-24.04", "- run: python -m pip install Ruff mypy")),
        ".github/workflows/nightly.yml": workflow(job("typecheck", "ubuntu-22.04", "- run: pip install mypy ruff")),
      },
      errors: [
        {
          path: ".github/workflows/ci.yml",
          line: 6,
          messageIncludes: "installs `mypy`, `ruff` at runtime in 2 jobs: `lint` (.github/workflows/ci.yml:6), `typecheck` (.github/workflows/nightly.yml:6)",
        },
      ],
    },
    {
      name: "binary archive download with a higher threshold",
      options: { minJobs: 3 },
      files: workflow(
        job("a", "ubuntu-24.04", "- run: curl -fsSL https://example.com/tool-v1.tar.gz | tar -xz -C /usr/local/bin"),
        job("b", "ubuntu-24.04", "- run: curl -fsSL https://example.com/tool-v1.tar.gz | sudo tar -xz -C /usr/local/bin"),
        job("c", "ubuntu-24.04", "- run: wget -qO- https://example.com/tool-v1.tar.gz | tar -xz"),
        job("d", "ubuntu-24.04", "- run: sudo npm install -g markdownlint-cli"),
        job("e", "ubuntu-24.04", "- run: npm i -g markdownlint-cli"),
      ),
      errors: [{ line: 6, messageIncludes: "installs the archive `https://example.com/tool-v1.tar.gz` at runtime in 3 jobs" }],
    },
  ],
});
