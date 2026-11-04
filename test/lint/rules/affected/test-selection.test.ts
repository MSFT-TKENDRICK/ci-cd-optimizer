import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/affected/test-selection.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const WORKFLOW = ".github/workflows/ci.yml";

const workspaces = {
  "package.json": json({ name: "acme", private: true, workspaces: ["packages/*"] }),
  "packages/web/package.json": json({ name: "@acme/web" }),
  "packages/api/package.json": json({ name: "@acme/api" }),
};

const pr = (...stepLines: string[]): string =>
  yml("on:", "  pull_request:", "jobs:", "  test:", "    runs-on: ubuntu-24.04", "    steps:", "      - uses: actions/checkout@v7", ...stepLines);

const monorepo = (workflow: string, extra: Record<string, string> = {}): Record<string, string> => ({
  ...workspaces,
  ...extra,
  [WORKFLOW]: workflow,
});

ruleTester(rule, {
  valid: [
    {
      name: "affected commands",
      files: monorepo(
        pr(
          "      - uses: nrwl/nx-set-shas@v5",
          "      - run: npx nx affected -t test",
          "      - run: npx turbo run test --affected",
          "      - run: pnpm --filter '...[origin/main]' test",
          "      - run: npx lerna run test --since origin/main",
          "      - run: yarn workspaces foreach -A --since run test",
        ),
      ),
    },
    {
      name: "not a monorepo",
      files: { "package.json": json({ name: "app" }), [WORKFLOW]: pr("      - run: npx nx run-many -t test") },
    },
    {
      name: "push-only workflows are not pull request CI",
      files: monorepo(
        yml("on:", "  push:", "    branches: [main]", "jobs:", "  test:", "    runs-on: ubuntu-24.04", "    steps:", "      - run: pnpm -r test"),
      ),
    },
    {
      name: "jobs and steps guarded to non-PR events",
      files: monorepo(
        yml(
          "on: [push, pull_request]",
          "jobs:",
          "  full:",
          "    if: github.event_name == 'push'",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - run: npx nx run-many -t test",
          "  nightly:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - if: github.ref == 'refs/heads/main'",
          "        run: npx turbo run test",
        ),
      ),
    },
    {
      name: "scoped or non-test commands",
      files: monorepo(
        pr(
          "      - run: npx nx run-many -t test -p web api",
          "      - run: npx nx run-many -t build",
          "      - run: npx turbo run test --filter=web",
          "      - run: pnpm -r build",
          "      - run: npm run test -w packages/web",
          "      - run: npx lerna run test --scope @acme/web",
          "      - run: bazel test //packages/web/...",
          "      - run: echo turbo run test",
        ),
      ),
    },
    {
      name: "diff mode without workspace facts stays quiet",
      mode: "diff",
      files: { [WORKFLOW]: pr("      - run: npx nx run-many -t test") },
    },
    {
      name: "a Gradle settings file alone is not a JavaScript monorepo",
      files: { "settings.gradle": "rootProject.name = 'app'\n", [WORKFLOW]: pr("      - run: npx turbo run test") },
    },
  ],
  invalid: [
    {
      name: "nx run-many with test targets",
      files: monorepo(pr("      - run: npx nx run-many -t lint test --parallel=3"), { "nx.json": "{}\n" }),
      errors: [{ line: 8, messageIncludes: "`nx run-many` runs the `lint`, `test` targets for every project" }],
    },
    {
      name: "turbo, pnpm, npm, yarn and lerna in one multi-line script",
      files: monorepo(
        pr(
          "      - run: |",
          "          npx turbo run test",
          "          pnpm --recursive run test:unit",
          "          npm test --workspaces --if-present",
          "          yarn workspaces foreach -A -j 4 run test",
          "          npx lerna run test --stream",
        ),
      ),
      errors: [
        { line: 9, messageIncludes: "`turbo run` runs the `test` target" },
        { line: 10, messageIncludes: "`pnpm -r` runs the `test:unit` script" },
        { line: 11, messageIncludes: "`npm --workspaces`" },
        { line: 12, messageIncludes: "`yarn workspaces`" },
        { line: 13, messageIncludes: "`lerna run`" },
      ],
    },
    {
      name: "bazel test of the whole graph, detected through the tool file alone",
      files: {
        "MODULE.bazel": 'module(name = "acme")\n',
        [WORKFLOW]: pr("      - run: bazel test //... --config=ci"),
      },
      errors: [{ line: 8, messageIncludes: "every test target in the workspace" }],
    },
    {
      name: "commands inside a local composite action are reported in the action",
      files: monorepo(pr("      - uses: ./.github/actions/test"), {
        ".github/actions/test/action.yml": yml(
          "name: test",
          "runs:",
          "  using: composite",
          "  steps:",
          "    - run: pnpm -r test",
          "      shell: bash",
        ),
      }),
      errors: [{ path: ".github/actions/test/action.yml", line: 5, messageIncludes: "`pnpm -r`" }],
    },
    {
      name: "pull_request_target workflows and npm suggestions adapt to the detected tool",
      files: monorepo(
        yml("on: pull_request_target", "jobs:", "  test:", "    runs-on: ubuntu-24.04", "    steps:", "      - run: npm run test -ws"),
        { "turbo.json": "{}\n" },
      ),
      errors: [{ line: 6, messageIncludes: "`npm --workspaces` runs the `test` script in every workspace" }],
    },
  ],
});

describe("affected/test-selection suggestions", () => {
  it("points npm workspaces at the detected task runner", () => {
    const [diagnostic] = runRule(rule, { files: monorepo(pr("      - run: npm test --workspaces"), { "turbo.json": "{}\n" }) });
    expect(diagnostic?.suggestion).toContain("turbo run test --affected");
  });

  it("keeps every nx target in the affected command", () => {
    const [diagnostic] = runRule(rule, { files: monorepo(pr("      - run: npx nx run-many --target=test,e2e")) });
    expect(diagnostic?.suggestion).toContain("nx affected -t test e2e");
  });
});