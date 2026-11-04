import type { PackageManifest } from "../../parsers/manifest.js";
import { defineRule } from "../helpers.js";
import { isWorkspaceRoot, packageManifests, stringField } from "./workspace.js";

function relative(path: string): string {
  return path.startsWith("./") || path.startsWith("../") ? path : `./${path.replace(/^\/+/, "")}`;
}

function exportsSnippet(manifest: PackageManifest): string | undefined {
  const types = stringField(manifest, "types") ?? stringField(manifest, "typings");
  const module = stringField(manifest, "module");
  const main = stringField(manifest, "main");
  const conditions: Array<[string, string]> = [];
  if (types) conditions.push(["types", relative(types)]);
  if (module && main && module !== main) {
    conditions.push(["import", relative(module)], ["require", relative(main)]);
  } else if (module ?? main) {
    conditions.push(["default", relative((module ?? main) as string)]);
  }
  if (conditions.length === 0) return undefined;
  const entry = conditions.map(([condition, path]) => `"${condition}": "${path}"`).join(", ");
  return `"exports": { ".": { ${entry} }, "./package.json": "./package.json" }`;
}

function isEsm(manifest: PackageManifest): boolean {
  return stringField(manifest, "module") !== undefined || manifest.json.type === "module";
}

export default defineRule({
  meta: {
    id: "packages/exports-map",
    ruleset: "packages",
    description: "Library packages should declare an `exports` map, and ESM libraries a `sideEffects` field.",
    rationale:
      "An `exports` map is the package's public API: it blocks deep imports into internals, so packages can be split, moved, and rebuilt independently without breaking consumers, and it lets bundlers and TypeScript resolve the right entry without probing. `sideEffects` tells bundlers which modules are safe to drop, which keeps tree-shaking effective and app bundles (and their build times) small.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nodejs.org/api/packages.html#package-entry-points",
      "https://nodejs.org/api/packages.html#conditional-exports",
      "https://webpack.js.org/guides/tree-shaking/#mark-the-file-as-side-effect-free",
      "https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-exports",
    ],
    impact: "low",
    example: {
      bad: '{\n  "name": "@acme/ui",\n  "main": "dist/index.cjs",\n  "module": "dist/index.mjs",\n  "types": "dist/index.d.ts"\n}',
      good:
        '{\n  "name": "@acme/ui",\n  "main": "dist/index.cjs",\n  "module": "dist/index.mjs",\n  "types": "dist/index.d.ts",\n  "exports": {\n    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.mjs", "require": "./dist/index.cjs" },\n    "./package.json": "./package.json"\n  },\n  "sideEffects": false\n}',
    },
  },
  check({ project, report }) {
    for (const manifest of packageManifests(project)) {
      if (isWorkspaceRoot(project, manifest)) continue;
      const entryKey = ["main", "module", "types", "typings"].find((key) => stringField(manifest, key) !== undefined);
      if (!entryKey) continue;
      if (manifest.private && manifest.json.bin !== undefined) continue;
      const name = manifest.name ? `\`${manifest.name}\`` : manifest.path;
      if (manifest.json.exports === undefined) {
        const snippet = exportsSnippet(manifest);
        if (snippet) {
          report({
            path: manifest.path,
            line: manifest.lineOf(entryKey),
            key: "exports-missing",
            message: `Library ${name} has no \`exports\` map, so consumers can deep-import any internal file and bundlers cannot rely on a fixed public entry point.`,
            suggestion: `Add \`${snippet}\` (add subpaths like \`"./feature": "./dist/feature.js"\` for each public entry). Publish it as a major version if consumers import internal paths today.`,
          });
        }
      }
      if (isEsm(manifest) && manifest.json.sideEffects === undefined) {
        const esmKey = stringField(manifest, "module") !== undefined ? "module" : "type";
        report({
          path: manifest.path,
          line: manifest.lineOf(esmKey),
          key: "side-effects-missing",
          message: `ESM library ${name} does not declare \`sideEffects\`, so bundlers must assume every module has side effects and keep unused code.`,
          suggestion:
            'Add `"sideEffects": false` if importing a module has no side effects, or list the files that do (for example `"sideEffects": ["*.css", "./dist/polyfills.js"]`).',
        });
      }
    }
  },
});
