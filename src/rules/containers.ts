import type { Finding, Rule } from "../types.js";
import { dockerfiles, lineOf, workflowFiles } from "../utils.js";

export const containerRules: Rule[] = [
  {
    id: "docker-build-cache",
    description: "Persist BuildKit layers between workflow runs.",
    evaluate(context) {
      return workflowFiles(context.files).flatMap((file): Finding[] => {
        if (!/docker\/build-push-action@/.test(file.content)) return [];
        if (/cache-from:|cache-to:/.test(file.content)) return [];
        return [
          {
            ruleId: "docker-build-cache",
            title: "Persist Docker BuildKit cache",
            severity: "high",
            confidence: "high",
            effort: "small",
            category: "caching",
            estimatedImpact: "Can turn unchanged image layers into metadata lookups instead of rebuilds.",
            explanation:
              "docker/build-push-action is used without cache-from or cache-to.",
            recommendation:
              "Use the GitHub Actions cache backend (type=gha) or a registry cache in GHCR for cross-run and cross-runner reuse.",
            evidence: {
              path: file.path,
              line: lineOf(file.content, "docker/build-push-action@") ?? 1,
              excerpt: "docker/build-push-action@",
            },
            documentationUrl:
              "https://docs.docker.com/build/ci/github-actions/cache/",
          },
        ];
      });
    },
  },
  {
    id: "docker-dependency-layer",
    description: "Copy dependency manifests before source to maximize Docker cache reuse.",
    evaluate(context) {
      return dockerfiles(context.files).flatMap((file): Finding[] => {
        const broadCopy = file.content.match(/^COPY\s+\.\s+(?:\.\/?|\/\S*)\s*$/m);
        const install = file.content.match(
          /^RUN\s+.*\b(npm ci|pnpm install|yarn install|pip install|poetry install|dotnet restore|mvn|gradle)\b/m,
        );
        if (!broadCopy || !install || (broadCopy.index ?? 0) > (install.index ?? 0)) return [];
        return [
          {
            ruleId: "docker-dependency-layer",
            title: "Isolate dependencies in a reusable container layer",
            severity: "high",
            confidence: "high",
            effort: "medium",
            category: "containers",
            estimatedImpact: "Avoids reinstalling dependencies when only application source changes.",
            explanation:
              "The full build context is copied before dependency installation, invalidating the dependency layer on most source changes.",
            recommendation:
              "Copy lockfiles and package manifests first, install dependencies, then copy source. In monorepos, use a pruned dependency context.",
            evidence: {
              path: file.path,
              line: lineOf(file.content, broadCopy[0]) ?? 1,
              excerpt: broadCopy[0],
            },
          },
        ];
      });
    },
  },
  {
    id: "docker-multistage",
    description: "Separate build tooling from the runtime image.",
    evaluate(context) {
      return dockerfiles(context.files).flatMap((file): Finding[] => {
        const fromCount = file.content.match(/^FROM\s+/gm)?.length ?? 0;
        const buildsApp = /\b(npm run build|dotnet publish|mvn package|gradle build|go build|cargo build)\b/.test(
          file.content,
        );
        if (!buildsApp || fromCount > 1) return [];
        return [
          {
            ruleId: "docker-multistage",
            title: "Use a multi-stage container build",
            severity: "medium",
            confidence: "high",
            effort: "medium",
            category: "containers",
            estimatedImpact: "Shrinks pushed layers and improves distribution and cold-start times.",
            explanation:
              "Compilation and runtime appear to share one image stage, retaining build tools and intermediate files.",
            recommendation:
              "Build in a toolchain stage and copy only runtime artifacts into a minimal final stage.",
            evidence: { path: file.path, line: 1 },
          },
        ];
      });
    },
  },
  {
    id: "ghcr-output",
    description: "Use GitHub Container Registry for organization-local images and caches.",
    evaluate(context) {
      if (dockerfiles(context.files).length === 0) return [];
      const workflows = workflowFiles(context.files);
      const pushesImage = workflows.some((file) =>
        /docker\/build-push-action@[\s\S]*push:\s*true/.test(file.content),
      );
      const usesGhcr = workflows.some((file) => /ghcr\.io\//i.test(file.content));
      if (!pushesImage || usesGhcr) return [];
      const evidence = workflows.find((file) => /docker\/build-push-action@/.test(file.content));
      if (!evidence) return [];
      return [
        {
          ruleId: "ghcr-output",
          title: "Publish organization images and cache layers to GHCR",
          severity: "medium",
          confidence: "medium",
          effort: "medium",
          category: "registries",
          estimatedImpact: "Improves image locality, access control, provenance, and cache sharing.",
          explanation:
            "The repository builds and pushes a container image but no GHCR destination was detected.",
          recommendation:
            "Publish immutable images to ghcr.io/<org>/<image> and consider a dedicated BuildKit registry-cache tag shared by related builds.",
          evidence: {
            path: evidence.path,
            line: lineOf(evidence.content, "docker/build-push-action@") ?? 1,
          },
          documentationUrl:
            "https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry",
        },
      ];
    },
  },
];
