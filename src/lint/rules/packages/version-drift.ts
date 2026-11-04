import type { Location } from "../../types.js";
import type { PackageManifest } from "../../parsers/manifest.js";
import { defineRule, isKnownMonorepo } from "../helpers.js";
import { internalNames, packageManifests } from "./workspace.js";

const LOCAL_SPEC = /^(workspace|catalog|file|link|portal):/;

interface Declaration {
  manifest: PackageManifest;
  spec: string;
}

function policy(manager: string | undefined, dependency: string): string {
  switch (manager) {
    case "pnpm":
      return `Define \`${dependency}\` once in a pnpm catalog (\`catalog:\` in pnpm-workspace.yaml) and reference it as \`"${dependency}": "catalog:"\` in every package, or align the ranges with \`syncpack fix-mismatches\`.`;
    case "yarn":
      return `Align every \`${dependency}\` range on one version and enforce it with Yarn constraints (\`yarn constraints --fix\`) or \`syncpack fix-mismatches\` in CI.`;
    default:
      return `Align every \`${dependency}\` range on one version (for example with \`syncpack fix-mismatches\`) and check it in CI; a root \`overrides\` entry can also force a single copy.`;
  }
}

export default defineRule({
  meta: {
    id: "packages/version-drift",
    ruleset: "packages",
    description: "Workspace packages should declare each third-party dependency with the same version specifier.",
    rationale:
      "When packages in one monorepo ask for different ranges of the same dependency, the lockfile carries several copies, installs and node_modules grow, Docker dependency layers and CI caches fragment by package, and packages behave differently at runtime and in tests. A single version policy keeps one hermetic dependency set that every package and image layer can share.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: { ignore: [] as string[] },
    validateOptions: (value) =>
      value.ignore === undefined || (Array.isArray(value.ignore) && value.ignore.every((entry) => typeof entry === "string"))
        ? []
        : ["ignore must be an array of dependency names"],
    references: [
      "https://pnpm.io/catalogs",
      "https://yarnpkg.com/features/constraints",
      "https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides",
      "https://github.com/JamieMason/syncpack",
    ],
    impact: "medium",
    example: {
      bad: '// packages/a/package.json\n{ "dependencies": { "zod": "^3.22.0" } }\n// packages/b/package.json\n{ "dependencies": { "zod": "^3.24.1" } }',
      good:
        '# pnpm-workspace.yaml\ncatalog:\n  zod: ^3.24.1\n// packages/a/package.json and packages/b/package.json\n{ "dependencies": { "zod": "catalog:" } }',
    },
  },
  check({ project, options, report }) {
    if (!isKnownMonorepo(project)) return;
    const manifests = packageManifests(project);
    if (manifests.length < 2) return;
    const internal = internalNames(project);
    const ignored = new Set(options.ignore);
    const declarations = new Map<string, Declaration[]>();
    for (const manifest of manifests) {
      for (const record of [manifest.dependencies, manifest.devDependencies]) {
        for (const [dependency, raw] of Object.entries(record)) {
          const spec = raw.trim();
          if (!spec || LOCAL_SPEC.test(spec) || internal.has(dependency) || ignored.has(dependency)) continue;
          const list = declarations.get(dependency) ?? [];
          if (!list.some((entry) => entry.manifest === manifest && entry.spec === spec)) list.push({ manifest, spec });
          declarations.set(dependency, list);
        }
      }
    }
    const manager = project.facts.packageManager.value;
    for (const [dependency, list] of [...declarations].sort(([a], [b]) => a.localeCompare(b))) {
      const specs = new Map<string, string[]>();
      for (const entry of list) specs.set(entry.spec, [...(specs.get(entry.spec) ?? []), entry.manifest.path]);
      if (specs.size < 2) continue;
      const [first, ...rest] = list;
      if (!first) continue;
      const related: Location[] = [];
      for (const entry of rest) {
        if (entry.manifest === first.manifest || related.some((location) => location.path === entry.manifest.path)) continue;
        related.push({ path: entry.manifest.path, line: entry.manifest.lineOf(dependency) });
      }
      const summary = [...specs]
        .slice(0, 4)
        .map(([spec, paths]) => `\`${spec}\` (${paths.slice(0, 3).join(", ")}${paths.length > 3 ? `, +${paths.length - 3}` : ""})`)
        .join(", ");
      const manifestCount = new Set(list.map((entry) => entry.manifest)).size;
      report({
        path: first.manifest.path,
        line: first.manifest.lineOf(dependency),
        key: `drift:${dependency}`,
        message: `\`${dependency}\` is declared with ${specs.size} different version specifiers across ${manifestCount} manifests: ${summary}${specs.size > 4 ? ", ..." : ""}.`,
        suggestion: policy(manager, dependency),
        related,
      });
    }
  },
});
