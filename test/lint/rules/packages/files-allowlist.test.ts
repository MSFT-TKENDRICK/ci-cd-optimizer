import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/packages/files-allowlist.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const pkg = (json: Record<string, unknown>) => `${JSON.stringify(json, null, 2)}\n`;
const library = { name: "@acme/ui", version: "1.0.0", main: "dist/index.js", types: "dist/index.d.ts" };
const workspaceRoot = pkg({ name: "acme", private: true, workspaces: ["packages/*"] });

ruleTester(rule, {
  valid: [
    { name: "private package", files: { "package.json": pkg({ ...library, private: true }) } },
    { name: "files allowlist present", files: { "package.json": pkg({ ...library, files: ["dist"] }) } },
    { name: ".npmignore present", files: { "package.json": pkg(library), ".npmignore": "src\ntest\n" } },
    { name: "workspace root that only lists workspaces", files: { "package.json": pkg({ name: "acme", version: "0.0.0", workspaces: ["packages/*"] }) } },
    { name: "no version, so it cannot be published", files: { "package.json": pkg({ name: "web", main: "server.js" }) } },
    {
      name: "fixture packages outside the workspace are ignored",
      files: { "package.json": workspaceRoot, "packages/ui/package.json": pkg({ ...library, files: ["dist"] }), "test/fixtures/pkg/package.json": pkg(library) },
    },
    { name: "requires a complete inventory (.npmignore may exist)", files: { "package.json": pkg(library) }, mode: "files" },
  ],
  invalid: [
    {
      name: "single-package library at the root",
      files: { "package.json": pkg(library) },
      errors: [{ path: "package.json", line: 2, messageIncludes: "`@acme/ui` is publishable but has no `files` allowlist" }],
    },
    {
      name: "only workspace packages without an allowlist are reported",
      files: {
        "package.json": workspaceRoot,
        "packages/a/package.json": pkg({ ...library, name: "@acme/a", files: ["dist"] }),
        "packages/b/package.json": pkg({ ...library, name: "@acme/b" }),
        "packages/c/package.json": pkg({ ...library, name: "@acme/c", private: true }),
      },
      errors: [{ path: "packages/b/package.json", line: 2, messageIncludes: "packages/b" }],
    },
    {
      name: ".npmignore in another package does not count",
      files: {
        "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n",
        "package.json": pkg({ name: "acme", private: true }),
        "libs/x/package.json": pkg({ name: "@acme/x", version: "2.0.0", bin: { x: "bin/x.js" } }),
        "libs/y/package.json": pkg({ name: "@acme/y", version: "2.0.0" }),
        "libs/y/.npmignore": "test\n",
      },
      errors: [{ path: "libs/x/package.json", line: 2 }],
    },
    {
      name: "name is not the first key",
      files: { "package.json": pkg({ version: "1.0.0", description: "cli", name: "tool", bin: "cli.js" }) },
      errors: [{ path: "package.json", line: 4 }],
    },
  ],
});

describe("packages/files-allowlist suggestions", () => {
  const suggestion = (files: Record<string, string>) => runRule(rule, { files })[0]?.suggestion;

  it("suggests the directory the entry points live in", () => {
    expect(suggestion({ "package.json": pkg({ ...library, main: "./lib/index.cjs", module: "./esm/index.js", types: "./lib/index.d.ts" }) })).toContain(
      '`"files": ["lib","esm"]`',
    );
  });

  it("falls back to the tsconfig outDir, then dist", () => {
    expect(
      suggestion({ "package.json": pkg({ name: "x", version: "1.0.0" }), "tsconfig.json": '{\n  // build\n  "compilerOptions": { "outDir": "./build/", },\n}\n' }),
    ).toContain('`"files": ["build"]`');
    expect(suggestion({ "package.json": pkg({ name: "x", version: "1.0.0" }) })).toContain('`"files": ["dist"]`');
  });
});
