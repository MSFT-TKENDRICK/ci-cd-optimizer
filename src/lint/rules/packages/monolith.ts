import type { PackageManifest } from "../../parsers/manifest.js";
import { defineRule } from "../helpers.js";
import { isWorkspaceRoot, packageManifests } from "./workspace.js";

function dependsOn(manifest: PackageManifest, name: string): boolean {
  const peer = manifest.json.peerDependencies;
  return (
    name in manifest.dependencies ||
    name in manifest.devDependencies ||
    (peer !== null && typeof peer === "object" && !Array.isArray(peer) && name in peer)
  );
}

const DECOMPOSE =
  "Split it into smaller feature packages with explicit `exports`, publish internal packages to the GitHub npm registry (`npm.pkg.github.com`) or consume them as workspace packages, and ship shared runtime dependencies as an OCI base layer on GHCR, so CI can build, test, and cache only the packages a change affects (`nx affected`, `turbo run --filter=...[origin/main]`, `pnpm --filter ...[origin/main]`).";

const nonNegativeInteger = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;

export default defineRule({
  meta: {
    id: "packages/monolith",
    ruleset: "packages",
    description: "Packages with very many dependencies are candidates for decomposition into smaller composable packages.",
    rationale:
      "A package that pulls in everything is one cache key: any change to it, or to any of its dependencies, reinstalls, rebuilds, and retests the whole thing, and every image that contains it ships all of it. Smaller packages with explicit boundaries let affected-only CI, remote caches, and OCI layers reuse work, which is what keeps agentic edit-test loops fast.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["insights"],
    requires: [],
    defaultOptions: { maxDependencies: 40, maxWorkspaceDependents: 0 },
    validateOptions: (value) => [
      ...(value.maxDependencies !== undefined && !nonNegativeInteger(value.maxDependencies) ? ["maxDependencies must be a non-negative integer"] : []),
      ...(value.maxWorkspaceDependents !== undefined && !nonNegativeInteger(value.maxWorkspaceDependents)
        ? ["maxWorkspaceDependents must be a non-negative integer (0 disables the dependents check)"]
        : []),
    ],
    references: [
      "https://docs.npmjs.com/cli/v11/using-npm/workspaces",
      "https://nx.dev/ci/features/affected",
      "https://turbo.build/repo/docs/crafting-your-repository/structuring-a-repository",
      "https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry",
    ],
    impact: "medium",
    example: {
      bad: '{\n  "name": "app",\n  "dependencies": { "...": "60 runtime and build dependencies" }\n}',
      good:
        '// packages/ui, packages/api-client, packages/billing each declare only what they use\n{\n  "name": "app",\n  "dependencies": { "@acme/ui": "workspace:*", "@acme/billing": "workspace:*" }\n}',
    },
  },
  check({ project, options, report }) {
    const { isMonorepo, workspacePackages } = project.facts;
    if (isMonorepo.status !== "known" || workspacePackages.status !== "known") return;
    const workspace = new Set(workspacePackages.value);
    const candidates = packageManifests(project).filter((manifest) =>
      isMonorepo.value ? workspace.has(manifest) : manifest.dir === "" && !isWorkspaceRoot(project, manifest),
    );
    for (const manifest of candidates) {
      const runtime = Object.keys(manifest.dependencies).length;
      const dev = Object.keys(manifest.devDependencies).length;
      const name = manifest.name ? `\`${manifest.name}\`` : manifest.path;
      if (runtime + dev > options.maxDependencies) {
        report({
          path: manifest.path,
          line: manifest.lineOf(runtime > 0 ? "dependencies" : "devDependencies"),
          key: "monolith",
          confidence: "medium",
          message: `${name} declares ${runtime + dev} dependencies (${runtime} runtime + ${dev} dev), more than ${options.maxDependencies}; every change to it reinstalls, rebuilds, and retests all of them as one unit.`,
          suggestion: DECOMPOSE,
        });
      }
      const packageName = manifest.name;
      if (options.maxWorkspaceDependents > 0 && packageName) {
        const dependents = [...workspace].filter((other) => other !== manifest && dependsOn(other, packageName));
        if (dependents.length > options.maxWorkspaceDependents) {
          report({
            path: manifest.path,
            line: manifest.lineOf("name"),
            key: "hub",
            confidence: "medium",
            message: `${name} is a dependency of ${dependents.length} workspace packages (more than ${options.maxWorkspaceDependents}), so any change to it invalidates the build and test caches of all of them.`,
            suggestion: `Split ${name} into smaller packages along its consumers' needs, with explicit \`exports\`, so a change only affects the packages that import the changed part.`,
            related: dependents
              .sort((a, b) => a.path.localeCompare(b.path))
              .map((other) => ({ path: other.path, line: other.lineOf(packageName) })),
          });
        }
      }
    }
  },
});
