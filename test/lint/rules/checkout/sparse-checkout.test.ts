import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/checkout/sparse-checkout.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const WORKFLOW = ".github/workflows/ci.yml";

const monorepo: Record<string, string> = {
  "package.json": json({ name: "acme", private: true, workspaces: ["packages/*"] }),
  "packages/web/package.json": json({ name: "@acme/web", dependencies: { "@acme/ui": "workspace:*", react: "^19.0.0" } }),
  "packages/ui/package.json": json({ name: "@acme/ui", devDependencies: { "@acme/config": "workspace:*" } }),
  "packages/config/package.json": json({ name: "@acme/config" }),
  "packages/api/package.json": json({ name: "@acme/api" }),
  "patches/react.patch": "diff\n",
};

const withWorkflow = (workflow: string, extra: Record<string, string> = {}): Record<string, string> => ({
  ...monorepo,
  ...extra,
  [WORKFLOW]: workflow,
});

const job = (...lines: string[]): string =>
  yml("on: pull_request", "jobs:", "  web:", "    runs-on: ubuntu-24.04", ...lines);

const scopedByFilter = job(
  "    steps:",
  "      - uses: actions/checkout@v7",
  "      - uses: pnpm/action-setup@v4",
  "      - run: pnpm install --frozen-lockfile",
  "      - run: pnpm --filter @acme/web... test",
);

ruleTester(rule, {
  valid: [
    {
      name: "commands across the whole repository",
      files: withWorkflow(job("    steps:", "      - uses: actions/checkout@v7", "      - run: pnpm -r test")),
    },
    {
      name: "jobs touching two packages are not scoped",
      files: withWorkflow(
        job(
          "    steps:",
          "      - uses: actions/checkout@v7",
          "      - run: pnpm --filter @acme/web test",
          "      - run: pnpm --filter @acme/api test",
        ),
      ),
    },
    {
      name: "already sparse",
      files: withWorkflow(
        job(
          "    steps:",
          "      - uses: actions/checkout@v7",
          "        with:",
          "          sparse-checkout: packages/web",
          "      - run: pnpm --filter @acme/web test",
        ),
      ),
    },
    {
      name: "blobless filter is left alone",
      files: withWorkflow(
        job(
          "    steps:",
          "      - uses: actions/checkout@v7",
          "        with:",
          "          filter: blob:none",
          "      - run: pnpm --filter @acme/web test",
        ),
      ),
    },
    {
      name: "expression working directories are unknown",
      files: withWorkflow(
        job(
          "    defaults:",
          "      run:",
          "        working-directory: ${{ matrix.dir }}",
          "    steps:",
          "      - uses: actions/checkout@v7",
          "      - run: npm test",
        ),
      ),
    },
    {
      name: "dependents selectors cannot be resolved",
      files: withWorkflow(job("    steps:", "      - uses: actions/checkout@v7", "      - run: pnpm --filter ...@acme/ui test")),
    },
    {
      name: "not enough workspace packages by default",
      files: {
        "package.json": json({ workspaces: ["packages/*"] }),
        "packages/web/package.json": json({ name: "web" }),
        "packages/api/package.json": json({ name: "api" }),
        [WORKFLOW]: job("    steps:", "      - uses: actions/checkout@v7", "      - run: pnpm --filter web test"),
      },
    },
    {
      name: "single-package repositories are skipped",
      files: { "package.json": json({ name: "app" }), [WORKFLOW]: job("    steps:", "      - uses: actions/checkout@v7", "      - run: npm test") },
    },
  ],
  invalid: [
    {
      name: "pnpm filter scoped to one package",
      files: withWorkflow(scopedByFilter),
      errors: [{ path: WORKFLOW, line: 6, messageIncludes: 'Job "web" checks out the whole monorepo but only works in packages/web (@acme/web)' }],
    },
    {
      name: "job working-directory under a package",
      files: withWorkflow(
        job(
          "    defaults:",
          "      run:",
          "        working-directory: packages/api/src",
          "    steps:",
          "      - uses: actions/checkout@v7",
          "      - run: npm ci",
          "      - run: npm test",
        ),
      ),
      errors: [{ line: 9, messageIncludes: "packages/api" }],
    },
    {
      name: "cd into a package and npm workspace flag by directory",
      files: withWorkflow(
        job(
          "    steps:",
          "      - uses: actions/checkout@v7",
          "      - run: |",
          "          cd packages/ui",
          "          npx vitest run",
          "      - run: npm run build --workspace=packages/ui",
        ),
      ),
      errors: [{ line: 6, messageIncludes: "packages/ui" }],
    },
    {
      name: "nx run with a project name",
      files: withWorkflow(job("    steps:", "      - uses: actions/checkout@v7", "      - run: npx nx run web:test"), { "nx.json": "{}\n" }),
      errors: [{ line: 6, messageIncludes: "packages/web" }],
    },
    {
      name: "local composite action steps are expanded",
      files: withWorkflow(job("    steps:", "      - uses: actions/checkout@v7", "      - uses: ./.github/actions/web-test"), {
        ".github/actions/web-test/action.yml": yml(
          "name: web-test",
          "runs:",
          "  using: composite",
          "  steps:",
          "    - run: yarn workspace @acme/web test",
          "      shell: bash",
        ),
      }),
      errors: [{ line: 6, messageIncludes: "packages/web" }],
    },
    {
      name: "lower package threshold via options",
      files: {
        "package.json": json({ workspaces: ["packages/*"] }),
        "packages/web/package.json": json({ name: "web" }),
        "packages/api/package.json": json({ name: "api" }),
        [WORKFLOW]: job("    steps:", "      - uses: actions/checkout@v7", "      - run: pnpm --filter web test"),
      },
      options: { minWorkspacePackages: 2 },
      errors: 1,
    },
  ],
});

describe("checkout/sparse-checkout suggestion", () => {
  it("lists the package, its workspace dependencies, and shared dirs, and warns about whole-workspace installs", () => {
    const [diagnostic] = runRule(rule, { files: withWorkflow(scopedByFilter) });
    expect(diagnostic?.suggestion).toContain("sparse-checkout: |\n      packages/web\n      packages/ui\n      packages/config\n      patches");
    expect(diagnostic?.suggestion).not.toContain("packages/api");
    expect(diagnostic?.suggestion).toContain("installs dependencies for the whole workspace");
  });

  it("includes local action directories", () => {
    const [diagnostic] = runRule(rule, {
      files: withWorkflow(job("    steps:", "      - uses: actions/checkout@v7", "      - uses: ./.github/actions/web-test"), {
        ".github/actions/web-test/action.yml": yml("name: t", "runs:", "  using: composite", "  steps:", "    - run: pnpm --filter web test", "      shell: bash"),
      }),
    });
    expect(diagnostic?.suggestion).toContain("      .github/actions/web-test");
  });
});
