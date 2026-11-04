import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/packages/version-drift.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const pkg = (json: Record<string, unknown>) => `${JSON.stringify(json, null, 2)}\n`;
const root = (extra: Record<string, unknown> = {}) => pkg({ name: "acme", private: true, workspaces: ["packages/*"], ...extra });

ruleTester(rule, {
  valid: [
    {
      name: "same specifier everywhere",
      files: {
        "package.json": root({ devDependencies: { typescript: "^5.6.0" } }),
        "packages/a/package.json": pkg({ name: "a", dependencies: { zod: "^3.24.1" }, devDependencies: { typescript: "^5.6.0" } }),
        "packages/b/package.json": pkg({ name: "b", dependencies: { zod: "^3.24.1" } }),
      },
    },
    {
      name: "workspace, catalog, file, and link protocols are skipped",
      files: {
        "package.json": root(),
        "packages/a/package.json": pkg({ name: "a", dependencies: { zod: "catalog:", b: "workspace:*", c: "file:../c" } }),
        "packages/b/package.json": pkg({ name: "b", dependencies: { zod: "catalog:default", c: "link:../c" } }),
        "packages/c/package.json": pkg({ name: "c", dependencies: { zod: "^3.24.1" } }),
      },
    },
    {
      name: "internal packages referenced by version are not third-party drift",
      files: {
        "package.json": root(),
        "packages/a/package.json": pkg({ name: "a", version: "1.2.0" }),
        "packages/b/package.json": pkg({ name: "b", dependencies: { a: "^1.0.0" } }),
        "packages/c/package.json": pkg({ name: "c", dependencies: { a: "^1.2.0" } }),
      },
    },
    {
      name: "not a monorepo",
      files: { "package.json": pkg({ name: "app", dependencies: { zod: "^3.0.0" } }), "examples/demo/package.json": pkg({ dependencies: { zod: "^3.24.0" } }) },
    },
    {
      name: "ignore option",
      files: {
        "package.json": root(),
        "packages/a/package.json": pkg({ name: "a", devDependencies: { typescript: "~5.4.0" } }),
        "packages/b/package.json": pkg({ name: "b", devDependencies: { typescript: "^5.6.0" } }),
      },
      options: { ignore: ["typescript"] },
    },
  ],
  invalid: [
    {
      name: "runtime and dev declarations drift",
      files: {
        "package.json": root({ devDependencies: { typescript: "^5.6.0" } }),
        "packages/a/package.json": pkg({ name: "a", dependencies: { zod: "^3.22.0" }, devDependencies: { typescript: "~5.4.0" } }),
        "packages/b/package.json": pkg({ name: "b", dependencies: { zod: "^3.24.1" }, devDependencies: { typescript: "^5.6.0" } }),
      },
      errors: [
        { path: "package.json", line: 8, messageIncludes: "`typescript` is declared with 2 different version specifiers across 3 manifests" },
        { path: "packages/a/package.json", line: 4, messageIncludes: "`zod` is declared with 2 different" },
      ],
    },
    {
      name: "pnpm workspace suggests catalogs",
      files: {
        "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        "package.json": pkg({ name: "acme", private: true }),
        "apps/api/package.json": pkg({ name: "api", dependencies: { react: "18.3.1" } }),
        "apps/web/package.json": pkg({ name: "web", dependencies: { react: "^19.0.0" } }),
      },
      errors: [{ path: "apps/api/package.json", line: 4, messageIncludes: "`18.3.1` (apps/api/package.json), `^19.0.0` (apps/web/package.json)" }],
    },
    {
      name: "turbo repo without workspace globs",
      files: {
        "turbo.json": "{}",
        "package.json": pkg({ name: "acme", private: true, devDependencies: { eslint: "^9.0.0" } }),
        "services/a/package.json": pkg({ name: "svc-a", devDependencies: { eslint: "^8.57.0" } }),
      },
      errors: [{ path: "package.json", line: 5 }],
    },
  ],
});

describe("packages/version-drift details", () => {
  it("relates the other manifests and suggests a pnpm catalog", () => {
    const [diagnostic] = runRule(rule, {
      files: {
        "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
        "package.json": pkg({ name: "acme", private: true, packageManager: "pnpm@10.0.0" }),
        "apps/api/package.json": pkg({ name: "api", dependencies: { react: "18.3.1" } }),
        "apps/web/package.json": pkg({ name: "web", dependencies: { react: "^19.0.0" } }),
        "apps/docs/package.json": pkg({ name: "docs", dependencies: { react: "^19.0.0" } }),
      },
    });
    expect(diagnostic?.path).toBe("apps/api/package.json");
    expect(diagnostic?.related).toEqual([
      { path: "apps/docs/package.json", line: 4 },
      { path: "apps/web/package.json", line: 4 },
    ]);
    expect(diagnostic?.suggestion).toContain('`"react": "catalog:"`');
  });

  it("suggests overrides or syncpack for npm", () => {
    const [diagnostic] = runRule(rule, {
      files: {
        "package.json": root(),
        "package-lock.json": "{}",
        "packages/a/package.json": pkg({ name: "a", dependencies: { lodash: "4.17.20" } }),
        "packages/b/package.json": pkg({ name: "b", dependencies: { lodash: "4.17.21" } }),
      },
    });
    expect(diagnostic?.suggestion).toContain("syncpack fix-mismatches");
    expect(diagnostic?.suggestion).toContain("overrides");
  });
});
