import { fix } from "../../fix.js";
import type { DockerfileModel, DockerStage } from "../../parsers/dockerfile.js";
import { defineRule } from "../helpers.js";
import {
  isDynamic,
  jobBuilds,
  replaceFlagValue,
  replaceWithEntry,
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
    description: "A multi-stage build exports its layer cache with `mode=min`, so builder stages are never cached.",
    rationale:
      "BuildKit cache exporters default to `mode=min`, which caches only the layers exported into the resulting image. In a multi-stage build the expensive work (dependency install, compilation) usually happens in builder stages whose layers are copied from but never exported, so with `mode=min` those steps miss the cache on every run. `mode=max` caches the layers of intermediate stages too.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: ["https://docs.docker.com/build/cache/backends/#cache-mode", "https://docs.docker.com/build/cache/backends/gha/"],
    impact: "medium",
    fixable: true,
    example: {
      bad: "# Dockerfile: FROM golang AS build ... RUN go build ... FROM scratch COPY --from=build ...\n- uses: docker/build-push-action@v7\n  with:\n    cache-from: type=gha\n    cache-to: type=gha",
      good: "- uses: docker/build-push-action@v7\n  with:\n    cache-from: type=gha\n    cache-to: type=gha,mode=max",
    },
  },
  check({ project, report }) {
    for (const workflow of [...project.workflows, ...project.actions]) {
      const file = project.files.get(workflow.path);
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
            const edit = site.command
              ? replaceFlagValue(file, site.command.line, "cache-to", entry.text, replacement)
              : (() => {
                  const sourced = site.step.with.get("cache-to");
                  return sourced ? replaceWithEntry(file, sourced, entry.text, replacement) : undefined;
                })();
            const flag = site.command ? "--cache-to" : "cache-to";
            report({
              path: workflow.path,
              line: siteCacheLine(project, site, "cache-to", entry),
              key: `${site.step.key}:cache-mode:${site.command?.line ?? 0}:${index}`,
              message: `\`${flag}\` entry \`${entry.text}\` uses ${entry.attributes.has("mode") ? "`mode=min`" : "the default `mode=min`"}, which caches only layers exported into the resulting image, but ${model.path}${target.value ? ` (target \`${target.value}\`)` : ""} builds intermediate stage(s) ${stages} with ${runs} RUN instruction(s) whose layers are not part of the image, so those steps are never cached and re-run on every fresh runner.`,
              suggestion: site.command ? `--cache-to ${replacement}` : `cache-to: ${replacement}`,
              impact: "medium",
              confidence: "high",
              ...(edit ? { fix: fix("Export the cache with mode=max", edit) } : {}),
            });
          }
        }
      }
    }
  },
});
