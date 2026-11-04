import { defineRule } from "../helpers.js";
import { isWorkspaceRoot, joinPath, packageManifests, publishedEntries } from "./workspace.js";

export default defineRule({
  meta: {
    id: "packages/files-allowlist",
    ruleset: "packages",
    description: "Publishable packages should declare a `files` allowlist (or an `.npmignore`) so the tarball only ships build output.",
    rationale:
      "Without an allowlist `npm publish` packs the whole package directory: sources, tests, fixtures, configs, and stray build caches. Bloated tarballs make every install, CI cache restore, and container layer that contains node_modules larger and slower, and can leak files that were never meant to be published. A `files` allowlist keeps composable packages small.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://docs.npmjs.com/cli/v11/configuring-npm/package-json#files",
      "https://docs.npmjs.com/cli/v11/using-npm/developers#keeping-files-out-of-your-package",
      "https://docs.npmjs.com/cli/v11/commands/npm-pack",
    ],
    impact: "medium",
    example: {
      bad: '{\n  "name": "@acme/ui",\n  "version": "1.4.0",\n  "main": "dist/index.js"\n}',
      good: '{\n  "name": "@acme/ui",\n  "version": "1.4.0",\n  "main": "dist/index.js",\n  "files": ["dist"]\n}',
    },
  },
  check({ project, report }) {
    for (const manifest of packageManifests(project)) {
      if (manifest.private || !manifest.name || isWorkspaceRoot(project, manifest)) continue;
      if (typeof manifest.json.version !== "string") continue;
      if (manifest.json.files !== undefined) continue;
      if (project.files.has(joinPath(manifest.dir, ".npmignore"))) continue;
      const entries = publishedEntries(project, manifest);
      const location = manifest.dir || "the repository root";
      report({
        path: manifest.path,
        line: manifest.lineOf("name"),
        key: "files-missing",
        message: `\`${manifest.name}\` is publishable but has no \`files\` allowlist or \`.npmignore\`, so \`npm publish\` packs everything in ${location} (sources, tests, fixtures, configs) into the tarball.`,
        suggestion: `Add \`"files": ${JSON.stringify(entries)}\` to ${manifest.path} so the tarball only contains build output (package.json, README, and LICENSE are always included), then check the contents with \`npm pack --dry-run\`.`,
      });
    }
  },
});
