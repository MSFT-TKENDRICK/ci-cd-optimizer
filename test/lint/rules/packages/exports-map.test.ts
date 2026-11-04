import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/packages/exports-map.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const pkg = (json: Record<string, unknown>) => `${JSON.stringify(json, null, 2)}\n`;
const root = pkg({ name: "acme", private: true, workspaces: ["packages/*", "apps/*"] });

ruleTester(rule, {
  valid: [
    {
      name: "library with exports and sideEffects",
      files: {
        "package.json": root,
        "packages/ui/package.json": pkg({ name: "@acme/ui", module: "dist/index.js", exports: { ".": "./dist/index.js" }, sideEffects: false }),
      },
    },
    { name: "app without entry fields", files: { "package.json": root, "apps/web/package.json": pkg({ name: "web", private: true, scripts: { start: "next start" } }) } },
    { name: "private CLI app with bin", files: { "package.json": root, "apps/cli/package.json": pkg({ name: "cli", private: true, main: "dist/cli.js", bin: { cli: "dist/cli.js" } }) } },
    { name: "workspace root is not a library", files: { "package.json": pkg({ name: "acme", main: "index.js", workspaces: ["packages/*"] }) } },
    { name: "CommonJS library with exports needs no sideEffects", files: { "package.json": pkg({ name: "lib", main: "index.js", exports: "./index.js" }) } },
  ],
  invalid: [
    {
      name: "dual CJS/ESM library without exports or sideEffects",
      files: {
        "package.json": root,
        "packages/ui/package.json": pkg({ name: "@acme/ui", version: "1.0.0", main: "dist/index.cjs", module: "dist/index.mjs", types: "dist/index.d.ts" }),
      },
      errors: [
        { path: "packages/ui/package.json", line: 4, messageIncludes: "Library `@acme/ui` has no `exports` map" },
        { path: "packages/ui/package.json", line: 5, messageIncludes: "ESM library `@acme/ui` does not declare `sideEffects`" },
      ],
    },
    {
      name: "CommonJS library without exports",
      files: { "package.json": pkg({ name: "lib", version: "1.0.0", main: "index.js" }) },
      errors: [{ path: "package.json", line: 4, messageIncludes: "no `exports` map" }],
    },
    {
      name: "type: module library with exports but no sideEffects",
      files: { "package.json": pkg({ name: "esm-lib", type: "module", main: "./dist/index.js", exports: { ".": "./dist/index.js" } }) },
      errors: [{ path: "package.json", line: 3, messageIncludes: "does not declare `sideEffects`" }],
    },
    {
      name: "private internal library is still checked",
      files: { "package.json": root, "packages/utils/package.json": pkg({ name: "@acme/utils", private: true, types: "src/index.ts", sideEffects: false }) },
      errors: [{ path: "packages/utils/package.json", line: 4 }],
    },
  ],
});

describe("packages/exports-map suggestions", () => {
  const suggestions = (json: Record<string, unknown>) => runRule(rule, { files: { "package.json": pkg(json) } }).map((d) => d.suggestion);

  it("builds conditional exports from main, module, and types", () => {
    expect(suggestions({ name: "x", main: "dist/index.cjs", module: "./dist/index.mjs", types: "dist/index.d.ts" })[0]).toContain(
      '`"exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.mjs", "require": "./dist/index.cjs" }, "./package.json": "./package.json" }`',
    );
  });

  it("uses a default condition for a single entry", () => {
    expect(suggestions({ name: "x", main: "lib/index.js", typings: "lib/index.d.ts" })[0]).toContain(
      '{ ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" }',
    );
  });

  it("suggests sideEffects: false", () => {
    expect(suggestions({ name: "x", module: "esm/index.js", exports: "./esm/index.js" })[0]).toContain('"sideEffects": false');
  });
});
