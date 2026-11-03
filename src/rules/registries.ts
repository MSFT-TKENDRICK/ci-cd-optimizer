import type { Rule } from "../types.js";
import { lineOf, workflowFiles } from "../utils.js";

export const registryRules: Rule[] = [
  {
    id: "github-npm-registry",
    description: "Prefer GitHub Packages for organization-scoped internal npm packages.",
    evaluate(context) {
      const packages = context.files.filter((file) => /(^|\/)package\.json$/.test(file.path));
      const hasWorkspaces = packages.some((file) => /"workspaces"\s*:/.test(file.content));
      const publishesNpm = workflowFiles(context.files).find((file) => /\bnpm publish\b/.test(file.content));
      const usesGitHubRegistry = context.files.some(
        (file) =>
          /npm\.pkg\.github\.com/.test(file.content) ||
          /registry-url:\s*['"]?https:\/\/npm\.pkg\.github\.com/.test(file.content),
      );
      if (!publishesNpm || usesGitHubRegistry) return [];

      return [
        {
          ruleId: "github-npm-registry",
          title: "Publish internal packages to GitHub Packages",
          severity: hasWorkspaces ? "medium" : "low",
          confidence: "medium",
          effort: "medium",
          category: "registries",
          estimatedImpact:
            "Enables organization-local package reuse with GitHub-native permissions and provenance.",
          explanation:
            "An npm publish step was found, but no GitHub npm registry configuration was detected.",
          recommendation:
            "For internal organization packages, configure the @scope registry as https://npm.pkg.github.com and authenticate with GITHUB_TOKEN.",
          evidence: {
            path: publishesNpm.path,
            line: lineOf(publishesNpm.content, "npm publish") ?? 1,
            excerpt: "npm publish",
          },
          documentationUrl:
            "https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-npm-registry",
        },
      ];
    },
  },
];
