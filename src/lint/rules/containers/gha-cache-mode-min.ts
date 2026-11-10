import type { DockerfileModel, DockerStage } from "../../parsers/dockerfile.js";
import { defineRule } from "../helpers.js";
import {
  isDynamic,
  jobBuilds,
  siteCacheEntries,
  siteCacheLine,
  siteDockerfile,
  stageAncestry,
  stageByReference,
  stageDependencies,
  type BuildSite,
  type CacheEntry,
} from "./buildx.js";

/** Exporters whose `mode` defaults to `min` (inline cache only supports `min` and is handled by `caching/docker-layer-cache`). */
const MODE_EXPORTERS = new Set(["gha", "registry", "local", "s3", "azblob"]);

function targetOf(site: BuildSite): { value: string | undefined; dynamic: boolean } {
  const raw = site.command ? site.command.build.flags.get("target")?.at(-1) : site.step.with.get("target")?.value;
  if (raw === undefined || raw === null || raw === "") return { value: undefined, dynamic: false };
  const value = String(raw);
  return { value, dynamic: isDynamic(value) };
}

/** Stages built for `final` that do not end up in its image: stages it copies or mounts from, transitively. */
function intermediateStages(model: DockerfileModel, final: DockerStage): DockerStage[] {
  const inImage = new Set(stageAncestry(model, final));
  const needed = new Set<DockerStage>();
  const queue = [...inImage];
  while (queue.length > 0) {
    const stage = queue.shift();
    if (!stage || needed.has(stage)) continue;
    needed.add(stage);
    for (const dependency of stageDependencies(model, stage)) for (const ancestor of stageAncestry(model, dependency)) queue.push(ancestor);
  }
  return [...needed].filter((stage) => !inImage.has(stage)).sort((a, b) => a.index - b.index);
}

function runCount(stage: DockerStage): number {
  return stage.instructions.filter((instruction) => instruction.keyword === "RUN").length;
}

function stageName(stage: DockerStage): string {
  return stage.name ? `\`${stage.name}\`` : `#${stage.index}`;
}

function withMaxMode(entry: CacheEntry): string {
  // A bare `<ref>` is registry shorthand; buildx only accepts attributes in the `type=registry,ref=<ref>` form.
  if (!entry.text.includes("=")) return `type=registry,ref=${entry.text},mode=max`;
  return /(^|,)\s*mode=min\b/i.test(entry.text) ? entry.text.replace(/((?:^|,)\s*mode=)min\b/i, "$1max") : `${entry.text},mode=max`;
}

export default defineRule({
  meta: {
    id: "containers/gha-cache-mode-min",
    ruleset: "containers",
    description: "A multi-stage build exports a minimal cache that omits intermediate-stage layers.",
    rationale:
      "BuildKit's mode=min export includes layers in the resulting image, not all intermediate-stage layers. A fresh builder relying only on that export may repeat intermediate work; local caches and other exporters can still avoid it. mode=max exports intermediate layers too, which can increase transfer/storage and disclose source or sensitive files intentionally omitted from the final image. Review cache access, secret handling and measured benefit before opting in; this is not a safe automatic edit.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: ["https://docs.docker.com/build/cache/backends/#cache-mode", "https://docs.docker.com/build/cache/backends/gha/"],
    impact: "medium",
    fixable: false,
    example: {
      bad: "# Dockerfile: FROM golang AS build ... RUN go build ... FROM scratch COPY --from=build ...\n- uses: docker/build-push-action@v7\n  with:\n    cache-from: type=gha\n    cache-to: type=gha",
      good: "- uses: docker/build-push-action@v7\n  with:\n    cache-from: type=gha\n    cache-to: type=gha,mode=max",
    },
  },
  check({ project, report }) {
    for (const workflow of [...project.workflows, ...project.actions]) {
      for (const job of workflow.jobs) {
        for (const site of jobBuilds(workflow, job)) {
          const entries = siteCacheEntries(site, "cache-to");
          const minimal = entries.filter((entry) => {
            if (!MODE_EXPORTERS.has(entry.type)) return false;
            const mode = entry.attributes.get("mode")?.toLowerCase();
            return mode === undefined || mode === "min";
          });
          if (minimal.length === 0) continue;
          const model = siteDockerfile(project, site);
          if (!model || model.stages.length < 2) continue;
          const target = targetOf(site);
          if (target.dynamic) continue;
          const final = target.value === undefined ? model.stages.at(-1) : stageByReference(model, target.value, model.stages.length);
          if (!final) continue;
          const uncached = intermediateStages(model, final).filter((stage) => runCount(stage) > 0);
          if (uncached.length === 0) continue;
          const runs = uncached.reduce((sum, stage) => sum + runCount(stage), 0);
          const stages = uncached.map(stageName).join(", ");
          for (const [index, entry] of minimal.entries()) {
            const replacement = withMaxMode(entry);
            const flag = site.command ? "--cache-to" : "cache-to";
            report({
              path: workflow.path,
              line: siteCacheLine(project, site, "cache-to", entry),
              key: `${site.step.key}:cache-mode:${site.command?.line ?? 0}:${index}`,
              message: `\`${flag}\` entry \`${entry.text}\` uses ${entry.attributes.has("mode") ? "`mode=min`" : "the default `mode=min`"}. ${model.path}${target.value ? ` (target \`${target.value}\`)` : ""} builds intermediate stage(s) ${stages} with ${runs} RUN instruction(s) omitted from this export; a fresh builder relying on it may repeat that work.`,
              suggestion: `If intermediate layers are safe to share with every cache reader, consider ${site.command ? `--cache-to ${replacement}` : `cache-to: ${replacement}`}. Review sensitive files, cache access and storage/transfer costs first, then measure cache hits.`,
              impact: "medium",
              confidence: "high",
            });
          }
        }
      }
    }
  },
});
