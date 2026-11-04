import type { PackageManifest } from "../../parsers/manifest.js";
import type { StepModel } from "../../parsers/workflow.js";
import type { Location } from "../../types.js";
import { commandsOf, defineRule, expandedJobSteps } from "../helpers.js";
import { isWorkspaceRoot, packageManifests } from "../packages/workspace.js";

const GITHUB_NPM = "https://npm.pkg.github.com";

function normalizeUrl(url: string): string {
  return url.trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "").toLowerCase();
}

function isGithubRegistry(url: string): boolean {
  return /^(https?:)?\/\/npm\.pkg\.github\.com(\/[^/]*)?$/.test(normalizeUrl(url));
}

function scopeOf(name: string | undefined): string | undefined {
  return name?.startsWith("@") && name.includes("/") ? name.split("/")[0]?.toLowerCase() : undefined;
}

function publishConfigOf(manifest: PackageManifest): Record<string, unknown> | undefined {
  const value = manifest.json.publishConfig;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** `publishConfig.registry`, or the `publishConfig["@scope:registry"]` override for the package's own scope. */
function publishRegistryOf(manifest: PackageManifest): string | undefined {
  const config = publishConfigOf(manifest);
  const scope = scopeOf(manifest.name);
  const scoped = scope ? Object.entries(config ?? {}).find(([key]) => key.toLowerCase() === `${scope}:registry`)?.[1] : undefined;
  const registry = typeof scoped === "string" ? scoped : config?.registry;
  return typeof registry === "string" ? registry : undefined;
}

function setupNode(step: StepModel): boolean {
  const action = step.uses?.action;
  return action?.kind === "remote" && action.name === "actions/setup-node";
}

const PUBLISHERS = new Set(["npm", "pnpm", "yarn", "npx", "lerna", "changeset"]);

/**
 * Registry an `npm|pnpm|yarn|lerna|changeset publish` command targets via `--registry`: `""` when it passes none,
 * undefined when the command does not publish.
 */
function publishRegistry(command: string): string | undefined {
  const parts = command.split(/\s+/).filter(Boolean);
  while (parts[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0])) parts.shift();
  if (!PUBLISHERS.has(parts[0] ?? "")) return undefined;
  const index = parts.indexOf("publish");
  if (index < 0 || parts.slice(0, index).includes("run")) return undefined;
  const args = parts.slice(index + 1);
  if (args.includes("--dry-run")) return undefined;
  for (let position = 0; position < args.length; position += 1) {
    const word = args[position] ?? "";
    if (word === "--registry") return args[position + 1] ?? "";
    if (word.startsWith("--registry=")) return word.slice("--registry=".length);
  }
  return "";
}

const PUBLISH_SETUP = (scope: string) =>
  `Publish with \`actions/setup-node\` (\`registry-url: ${GITHUB_NPM}\`, \`scope: ${scope}\`), \`permissions: packages: write\`, and \`NODE_AUTH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\`; consumers add \`${scope}:registry=${GITHUB_NPM}\` to .npmrc.`;

export default defineRule({
  meta: {
    id: "registries/github-npm",
    ruleset: "registries",
    description: "Internal scoped npm packages should be published to the GitHub npm registry (npm.pkg.github.com).",
    rationale:
      "Publishing internal packages to GitHub Packages keeps them next to their source: Actions publish and install with the workflow's GITHUB_TOKEN instead of long-lived npm tokens, access follows organization and repository permissions, and small composable packages can be versioned and consumed independently by every repository and container build in the organization.",
    kind: "policy",
    defaultSeverity: "info",
    presets: ["github"],
    requires: [],
    defaultOptions: { scopes: [] as string[] },
    validateOptions: (value) =>
      value.scopes === undefined || (Array.isArray(value.scopes) && value.scopes.every((scope) => typeof scope === "string" && /^@?[a-z0-9][\w.-]*$/i.test(scope)))
        ? []
        : ["scopes must be an array of npm scopes such as \"@acme\""],
    references: [
      "https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry",
      "https://docs.github.com/en/actions/use-cases-and-examples/publishing-packages/publishing-nodejs-packages#publishing-packages-to-github-packages",
      "https://docs.npmjs.com/cli/v11/configuring-npm/package-json#publishconfig",
    ],
    impact: "low",
    example: {
      bad: '{\n  "name": "@acme/ui",\n  "version": "1.0.0"\n}',
      good: '{\n  "name": "@acme/ui",\n  "version": "1.0.0",\n  "publishConfig": { "registry": "https://npm.pkg.github.com" }\n}',
    },
  },
  check({ project, options, input, report }) {
    const configured = options.scopes.map((scope) => (scope.startsWith("@") ? scope : `@${scope}`).toLowerCase());
    const repoScopes = new Set(project.manifests.map((manifest) => scopeOf(manifest.name)).filter((scope): scope is string => scope !== undefined));
    const internal = configured.length > 0 ? new Set(configured) : repoScopes;
    const isInternal = (scope: string | undefined) => scope !== undefined && internal.has(scope);

    // .npmrc scope mappings.
    const githubScopes = new Set<string>();
    for (const [path, file] of project.files) {
      if (!/(^|\/)\.npmrc$/.test(path)) continue;
      file.content.split(/\r?\n/).forEach((text, index) => {
        const match = /^\s*(@[^:\s]+):registry\s*=\s*(\S+)/.exec(text);
        if (!match) return;
        const scope = (match[1] ?? "").toLowerCase();
        const url = match[2] ?? "";
        if (isGithubRegistry(url)) {
          githubScopes.add(scope);
          return;
        }
        if (!isInternal(scope) || url.includes("${")) return;
        report({
          path,
          line: index + 1,
          key: `npmrc:${scope}`,
          message: `\`.npmrc\` maps the internal scope \`${scope}\` to \`${url}\` instead of the GitHub npm registry.`,
          suggestion: `Use \`${scope}:registry=${GITHUB_NPM}\` with \`//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\`, so CI installs with the workflow's GITHUB_TOKEN (\`packages: read\`) instead of a separate registry token.`,
        });
      });
    }

    // Yarn Berry maps scopes in .yarnrc.yml (`npmScopes.<scope>.npmRegistryServer`).
    const yarnrcUsesGithub = [...project.files].some(([path, file]) => /(^|\/)\.yarnrc\.yml$/.test(path) && /npm\.pkg\.github\.com/i.test(file.content));

    // Workflow publish steps.
    const workflowsUseGithub = [...project.workflows, ...project.actions].some((model) =>
      model.jobs.some((job) => job.steps.some((step) => setupNode(step) && isGithubRegistry(String(step.with.get("registry-url")?.value ?? "")))),
    );
    const publishable = (manifest: PackageManifest) =>
      !manifest.private && typeof manifest.json.version === "string" && !isWorkspaceRoot(project, manifest);
    const internalPackages = packageManifests(project).filter((manifest) => publishable(manifest) && isInternal(scopeOf(manifest.name)));
    const primaryScope = scopeOf(internalPackages[0]?.name) ?? [...internal][0] ?? "@<org>";
    const allPinnedToGithub = internalPackages.every((manifest) => {
      const registry = publishRegistryOf(manifest);
      return registry !== undefined && isGithubRegistry(registry);
    });

    if (internalPackages.length > 0) {
      for (const model of [...project.workflows, ...project.actions]) {
        for (const job of model.jobs) {
          const entries = expandedJobSteps(project, model, job);
          entries.forEach((entry, position) => {
            for (const { command, line } of commandsOf(entry.step)) {
              const registry = publishRegistry(command);
              if (registry === undefined) continue;
              if (registry) {
                if (registry.includes("$") || isGithubRegistry(registry)) continue;
                report({
                  path: entry.path,
                  line,
                  key: `${entry.step.key}:publish-registry:${registry}`,
                  message: `This step publishes to \`${registry}\` instead of the GitHub npm registry.`,
                  suggestion: PUBLISH_SETUP(primaryScope),
                });
                continue;
              }
              if (allPinnedToGithub) continue;
              const setup = entries
                .slice(0, position)
                .reverse()
                .find((candidate) => setupNode(candidate.step) && candidate.step.with.has("registry-url"));
              const url = setup?.step.with.get("registry-url");
              if (!setup || !url || url.kind !== "literal" || isGithubRegistry(String(url.value))) continue;
              const related: Location[] = [{ path: entry.path, line }];
              report({
                path: setup.path,
                line: url.line,
                key: `${setup.step.key}:registry-url`,
                message: `\`actions/setup-node\` sets \`registry-url: ${String(url.value)}\`, so the \`publish\` step on line ${line} publishes internal packages outside the GitHub npm registry.`,
                suggestion: PUBLISH_SETUP(primaryScope),
                related,
              });
            }
          });
        }
      }
    }

    // package.json publishConfig.
    const completeInventory = input.mode === "repository" && input.inventoryComplete;
    for (const manifest of internalPackages) {
      const scope = scopeOf(manifest.name) ?? primaryScope;
      const config = publishConfigOf(manifest);
      const registry = publishRegistryOf(manifest);
      if (registry !== undefined) {
        if (isGithubRegistry(registry) || registry.includes("${")) continue;
        report({
          path: manifest.path,
          line: typeof config?.registry === "string" ? manifest.lineOf("registry") : manifest.lineOf(`${scope}:registry`),
          key: "publish-config:registry",
          message: `Internal package \`${manifest.name ?? manifest.path}\` publishes to \`${registry}\` instead of the GitHub npm registry.`,
          suggestion: `Set \`"publishConfig": { "registry": "${GITHUB_NPM}" }\` (the scope \`${scope}\` must match the GitHub organization). ${PUBLISH_SETUP(scope)}`,
        });
        continue;
      }
      if (!completeInventory || githubScopes.has(scope) || workflowsUseGithub || yarnrcUsesGithub) continue;
      report({
        path: manifest.path,
        line: config ? manifest.lineOf("publishConfig") : manifest.lineOf("name"),
        key: "publish-config:missing",
        message: `Internal package \`${manifest.name ?? manifest.path}\` has no \`publishConfig.registry\` and no \`.npmrc\` mapping for \`${scope}\`, so \`npm publish\` targets the public npm registry.`,
        suggestion: `Add \`"publishConfig": { "registry": "${GITHUB_NPM}" }\` (the scope \`${scope}\` must match the GitHub organization). ${PUBLISH_SETUP(scope)}`,
      });
    }
  },
});
