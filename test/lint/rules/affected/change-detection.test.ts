import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/affected/change-detection.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const WORKFLOW = ".github/workflows/ci.yml";

const workspaces = {
  "package.json": json({ name: "acme", private: true, workspaces: ["apps/*"] }),
  "apps/web/package.json": json({ name: "web" }),
  "apps/api/package.json": json({ name: "api" }),
};

const monorepo = (workflow: string, extra: Record<string, string> = {}): Record<string, string> => ({
  ...workspaces,
  ...extra,
  [WORKFLOW]: workflow,
});

const job = (id: string, ...lines: string[]): string[] => [
  `  ${id}:`,
  "    runs-on: ubuntu-24.04",
  "    steps:",
  "      - uses: actions/checkout@v7",
  ...(lines.length > 0 ? lines : [`      - run: npm test -w apps/${id}`]),
];

const twoJobs = yml("name: CI", "on:", "  pull_request:", "jobs:", ...job("web"), ...job("api"));

ruleTester(rule, {
  valid: [
    {
      name: "paths-filter changes job",
      files: monorepo(
        yml(
          "on: pull_request",
          "jobs:",
          "  changes:",
          "    runs-on: ubuntu-24.04",
          "    outputs:",
          "      web: ${{ steps.filter.outputs.web }}",
          "    steps:",
          "      - id: filter",
          "        uses: dorny/paths-filter@v4",
          "        with:",
          "          filters: |",
          "            web: [apps/web/**]",
          "  web:",
          "    needs: changes",
          "    if: needs.changes.outputs.web == 'true'",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - run: npm test -w apps/web",
        ),
      ),
    },
    {
      name: "affected tooling inside a job",
      files: monorepo(yml("on: pull_request", "jobs:", ...job("lint", "      - run: npx nx affected -t lint"), ...job("api"))),
    },
    {
      name: "git diff based filter inside a local composite action",
      files: monorepo(yml("on: pull_request", "jobs:", ...job("web", "      - uses: ./.github/actions/changed"), ...job("api")), {
        ".github/actions/changed/action.yml": yml(
          "name: changed",
          "runs:",
          "  using: composite",
          "  steps:",
          "    - run: git diff --name-only origin/${{ github.base_ref }}...HEAD > changed.txt",
          "      shell: bash",
        ),
      }),
    },
    {
      name: "change detection in a local reusable workflow",
      files: monorepo(
        yml(
          "on: pull_request",
          "jobs:",
          "  detect:",
          "    uses: ./.github/workflows/detect.yml",
          ...job("web"),
        ),
        {
          ".github/workflows/detect.yml": yml(
            "on: workflow_call",
            "jobs:",
            "  filter:",
            "    runs-on: ubuntu-24.04",
            "    steps:",
            "      - uses: dorny/paths-filter@v4",
          ),
        },
      ),
    },
    {
      name: "remote reusable workflows are opaque",
      files: monorepo(yml("on: pull_request", "jobs:", "  shared:", "    uses: acme/workflows/.github/workflows/ci.yml@v1", ...job("web"))),
    },
    {
      name: "single-job workflows, push-only workflows, path-filtered workflows and non-monorepos",
      files: {
        ...monorepo(yml("on: pull_request", "jobs:", ...job("web"))),
        ".github/workflows/main.yml": yml("on: push", "jobs:", ...job("web"), ...job("api")),
        ".github/workflows/docs.yml": yml("on:", "  pull_request:", "    paths: ['docs/**']", "jobs:", ...job("web"), ...job("api")),
      },
    },
    {
      name: "not a monorepo",
      files: { "package.json": json({ name: "app" }), [WORKFLOW]: twoJobs },
    },
    {
      name: "job conditions on a differently named change output",
      files: monorepo(
        yml(
          "on: pull_request",
          "jobs:",
          ...job("setup", "      - id: diff", "        run: ./scripts/areas.sh"),
          "  web:",
          "    needs: setup",
          "    if: needs.setup.outputs.should-test-web == 'true'",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - run: npm test",
        ),
      ),
    },
  ],
  invalid: [
    {
      name: "two jobs without change detection",
      files: monorepo(twoJobs),
      errors: [{ line: 2, messageIncludes: "runs all 2 jobs on every change" }],
    },
    {
      name: "short trigger list reports at the on line",
      files: monorepo(yml("on: [push, pull_request]", "jobs:", ...job("web"), ...job("api"), ...job("docs"))),
      errors: [{ line: 1, messageIncludes: "runs all 3 jobs" }],
    },
    {
      name: "unrelated needs outputs and git diff --exit-code do not count",
      files: monorepo(
        yml(
          "on: pull_request_target",
          "jobs:",
          ...job("build", "      - run: npm run codegen", "      - run: git diff --exit-code"),
          "  test:",
          "    needs: build",
          "    if: needs.build.outputs.version != ''",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - run: npm test",
        ),
      ),
      errors: [{ line: 1 }],
    },
    {
      name: "monorepo detected from a tool file only",
      files: { "turbo.json": "{}\n", [WORKFLOW]: twoJobs },
      errors: [{ line: 2 }],
    },
  ],
});

describe("affected/change-detection suggestion", () => {
  it("mentions paths-filter permissions and the gate job, plus the detected task runner", () => {
    const [diagnostic] = runRule(rule, { files: monorepo(twoJobs, { "nx.json": "{}\n" }) });
    expect(diagnostic?.suggestion).toContain("pull-requests: read");
    expect(diagnostic?.suggestion).toContain("if: always()");
    expect(diagnostic?.suggestion).toContain("nx affected");
  });

  it("is skipped in diff mode", () => {
    expect(runRule(rule, { files: monorepo(twoJobs), mode: "diff" })).toEqual([]);
  });
});
