import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/packages/monolith.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const pkg = (json: Record<string, unknown>) => `${JSON.stringify(json, null, 2)}\n`;
const deps = (count: number, prefix = "dep") => Object.fromEntries(Array.from({ length: count }, (_, index) => [`${prefix}-${index}`, "^1.0.0"]));
const root = pkg({ name: "acme", private: true, workspaces: ["packages/*"] });

ruleTester(rule, {
  valid: [
    { name: "exactly at the threshold", files: { "package.json": pkg({ name: "app", dependencies: deps(30), devDependencies: deps(10, "dev") }) } },
    {
      name: "monorepo root holding shared tooling is not a package",
      files: { "package.json": pkg({ name: "acme", private: true, workspaces: ["packages/*"], devDependencies: deps(60) }), "packages/a/package.json": pkg({ name: "a" }) },
    },
    { name: "maxDependencies option raises the threshold", files: { "package.json": pkg({ name: "app", dependencies: deps(50) }) }, options: { maxDependencies: 80 } },
    { name: "facts unknown in files mode", files: { "package.json": pkg({ name: "app", dependencies: deps(50) }) }, mode: "files" },
    {
      name: "dependents check is disabled by default",
      files: {
        "package.json": root,
        "packages/core/package.json": pkg({ name: "@acme/core" }),
        "packages/a/package.json": pkg({ name: "@acme/a", dependencies: { "@acme/core": "workspace:*" } }),
      },
    },
  ],
  invalid: [
    {
      name: "single-package repository root",
      files: { "package.json": pkg({ name: "app", dependencies: deps(30), devDependencies: deps(11, "dev") }) },
      errors: [{ path: "package.json", line: 3, messageIncludes: "`app` declares 41 dependencies (30 runtime + 11 dev), more than 40" }],
    },
    {
      name: "workspace package over the threshold",
      files: { "package.json": root, "packages/kitchen-sink/package.json": pkg({ name: "@acme/kitchen-sink", devDependencies: deps(45) }) },
      errors: [{ path: "packages/kitchen-sink/package.json", line: 3, messageIncludes: "45 dependencies (0 runtime + 45 dev)" }],
    },
    {
      name: "maxDependencies option lowers the threshold",
      files: { "package.json": root, "packages/a/package.json": pkg({ name: "a", dependencies: deps(11) }), "packages/b/package.json": pkg({ name: "b", dependencies: deps(10) }) },
      options: { maxDependencies: 10 },
      errors: [{ path: "packages/a/package.json", messageIncludes: "more than 10" }],
    },
    {
      name: "maxWorkspaceDependents flags hub packages",
      files: {
        "package.json": root,
        "packages/core/package.json": pkg({ name: "@acme/core" }),
        "packages/a/package.json": pkg({ name: "@acme/a", dependencies: { "@acme/core": "workspace:*" } }),
        "packages/b/package.json": pkg({ name: "@acme/b", devDependencies: { "@acme/core": "workspace:*" } }),
        "packages/c/package.json": pkg({ name: "@acme/c", peerDependencies: { "@acme/core": "*" } }),
      },
      options: { maxWorkspaceDependents: 2 },
      errors: [{ path: "packages/core/package.json", line: 2, messageIncludes: "is a dependency of 3 workspace packages" }],
    },
  ],
});

describe("packages/monolith details", () => {
  it("is a medium-confidence decomposition hint", () => {
    const [diagnostic] = runRule(rule, { files: { "package.json": pkg({ name: "app", dependencies: deps(41) }) } });
    expect(diagnostic?.confidence).toBe("medium");
    expect(diagnostic?.kind).toBe("insight");
    expect(diagnostic?.suggestion).toContain("npm.pkg.github.com");
    expect(diagnostic?.suggestion).toContain("OCI base layer on GHCR");
  });

  it("rejects invalid options", () => {
    expect(rule.meta.validateOptions?.({ maxDependencies: -1 })).toHaveLength(1);
    expect(rule.meta.validateOptions?.({ maxWorkspaceDependents: 1.5 })).toHaveLength(1);
    expect(rule.meta.validateOptions?.({ maxDependencies: 10, maxWorkspaceDependents: 3 })).toEqual([]);
  });
});
