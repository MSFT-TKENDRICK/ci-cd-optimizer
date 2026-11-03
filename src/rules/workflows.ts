import type { Finding, Rule } from "../types.js";
import { lineOf, workflowFiles } from "../utils.js";

const actionsCacheDocs =
  "https://docs.github.com/actions/using-workflows/caching-dependencies-to-speed-up-workflows";

export const workflowRules: Rule[] = [
  {
    id: "workflow-concurrency",
    description: "Cancel obsolete workflow runs for superseded commits.",
    evaluate(context) {
      return workflowFiles(context.files).flatMap((file): Finding[] => {
        if (/^concurrency:/m.test(file.content)) return [];
        return [
          {
            ruleId: "workflow-concurrency",
            title: "Cancel superseded workflow runs",
            severity: "medium",
            confidence: "high",
            effort: "small",
            category: "workflow",
            estimatedImpact: "Avoids spending runner minutes on commits that can no longer merge.",
            explanation:
              "This workflow does not define a concurrency group, so outdated pull-request runs continue after newer commits arrive.",
            recommendation:
              "Add a branch- or pull-request-scoped concurrency group with cancel-in-progress enabled.",
            evidence: { path: file.path, line: 1 },
            documentationUrl:
              "https://docs.github.com/actions/using-jobs/using-concurrency",
          },
        ];
      });
    },
  },
  {
    id: "workflow-timeout",
    description: "Bound jobs so stuck builds do not consume runners indefinitely.",
    evaluate(context) {
      return workflowFiles(context.files).flatMap((file): Finding[] => {
        if (/timeout-minutes:/m.test(file.content)) return [];
        return [
          {
            ruleId: "workflow-timeout",
            title: "Set explicit job timeouts",
            severity: "low",
            confidence: "high",
            effort: "small",
            category: "workflow",
            estimatedImpact: "Caps wasted runner time from deadlocks, hung tests, and network stalls.",
            explanation: "No timeout-minutes setting was found in this workflow.",
            recommendation:
              "Set timeout-minutes on each job using a value slightly above its observed p95 duration.",
            evidence: { path: file.path, line: 1 },
          },
        ];
      });
    },
  },
  {
    id: "dependency-cache",
    description: "Use native setup-action or explicit dependency caching.",
    evaluate(context) {
      return workflowFiles(context.files).flatMap((file): Finding[] => {
        const installsDependencies =
          /(npm (?:ci|install)|pnpm install|yarn install|pip install|poetry install|\bmvn\b|\bgradle\b|go mod download|dotnet restore)/.test(
            file.content,
          );
        const cachesDependencies =
          /actions\/cache@|cache:\s*(?:['"])?(?:npm|yarn|pnpm|pip|gradle|maven)|setup-java@[\s\S]*cache:/m.test(
            file.content,
          );
        if (!installsDependencies || cachesDependencies) return [];
        const installMatch = file.content.match(
          /(npm (?:ci|install)|pnpm install|yarn install|pip install|poetry install|go mod download|dotnet restore)/,
        );
        return [
          {
            ruleId: "dependency-cache",
            title: "Cache downloaded dependencies",
            severity: "high",
            confidence: "high",
            effort: "small",
            category: "caching",
            estimatedImpact: "Often removes 30-90% of dependency download time on warm runs.",
            explanation:
              "The workflow installs dependencies but does not appear to configure a package-manager cache.",
            recommendation:
              "Prefer the cache option on the relevant setup action; otherwise use actions/cache with a lockfile-derived key.",
            evidence: {
              path: file.path,
              line: installMatch ? (lineOf(file.content, installMatch[0]) ?? 1) : 1,
              excerpt: installMatch?.[0] ?? "dependency installation",
            },
            documentationUrl: actionsCacheDocs,
          },
        ];
      });
    },
  },
  {
    id: "immutable-dependency-install",
    description: "Require lockfile-enforced, deterministic dependency installation.",
    evaluate(context) {
      return workflowFiles(context.files).flatMap((file): Finding[] => {
        const riskyInstall = file.content.match(
          /\b(npm install|yarn install(?![^\n]*(?:--immutable|--frozen-lockfile))|pnpm install(?![^\n]*--frozen-lockfile))\b/,
        );
        if (!riskyInstall) return [];
        return [
          {
            ruleId: "immutable-dependency-install",
            title: "Use a lockfile-enforced dependency install",
            severity: "high",
            confidence: "medium",
            effort: "small",
            category: "hermeticity",
            estimatedImpact: "Improves cache reuse and prevents dependency drift between identical commits.",
            explanation: `The workflow uses '${riskyInstall[0]}', which may resolve a different dependency graph over time.`,
            recommendation:
              "Use npm ci, pnpm install --frozen-lockfile, or yarn install --immutable as appropriate.",
            evidence: {
              path: file.path,
              line: lineOf(file.content, riskyInstall[0]) ?? 1,
              excerpt: riskyInstall[0],
            },
          },
        ];
      });
    },
  },
  {
    id: "artifact-retention",
    description: "Set retention for transient workflow artifacts.",
    evaluate(context) {
      return workflowFiles(context.files).flatMap((file): Finding[] => {
        if (!/actions\/upload-artifact@/.test(file.content) || /retention-days:/.test(file.content)) {
          return [];
        }
        return [
          {
            ruleId: "artifact-retention",
            title: "Limit transient artifact retention",
            severity: "low",
            confidence: "high",
            effort: "small",
            category: "workflow",
            estimatedImpact: "Reduces artifact storage growth and cleanup overhead.",
            explanation:
              "The workflow uploads artifacts without an explicit retention period.",
            recommendation:
              "Set retention-days to the shortest period that supports debugging and release requirements.",
            evidence: {
              path: file.path,
              line: lineOf(file.content, "actions/upload-artifact@") ?? 1,
              excerpt: "actions/upload-artifact@",
            },
          },
        ];
      });
    },
  },
  {
    id: "path-filtering",
    description: "Avoid running expensive workflows for unrelated monorepo changes.",
    evaluate(context) {
      const packageManifests = context.files.filter((file) =>
        /(^|\/)(package\.json|pom\.xml|build\.gradle(?:\.kts)?|go\.mod|pyproject\.toml)$/.test(
          file.path,
        ),
      );
      if (packageManifests.length < 3) return [];

      return workflowFiles(context.files).flatMap((file): Finding[] => {
        if (/\b(paths|paths-ignore):/.test(file.content)) return [];
        return [
          {
            ruleId: "path-filtering",
            title: "Skip unaffected monorepo workflows",
            severity: "medium",
            confidence: "medium",
            effort: "medium",
            category: "monorepo",
            estimatedImpact: "Prevents unaffected projects from consuming runner capacity.",
            explanation:
              "Multiple project manifests suggest a monorepo, but this workflow has no path filters.",
            recommendation:
              "Use paths/paths-ignore for coarse filtering and an affected-project tool such as Nx, Turborepo, or Bazel for job-level selection.",
            evidence: { path: file.path, line: 1 },
          },
        ];
      });
    },
  },
];
