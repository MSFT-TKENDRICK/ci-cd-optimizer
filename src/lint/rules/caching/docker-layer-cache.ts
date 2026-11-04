import type { Sourced, StepModel } from "../../parsers/workflow.js";
import { commandsOf, defineRule, steps } from "../helpers.js";
import { commandWords, isTrue, listOf, usesAction } from "./shared.js";

interface CacheEntry {
  type: string;
  attributes: Map<string, string>;
  line: number;
}

function cacheEntries(entry: Sourced<unknown> | undefined): CacheEntry[] {
  if (!entry || entry.kind === "expression" || typeof entry.value !== "string") return [];
  return listOf(entry.value).map((text) => {
    const attributes = new Map<string, string>();
    for (const part of text.split(",")) {
      const eq = part.indexOf("=");
      if (eq > 0) attributes.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
    }
    // A bare reference (`user/app:cache`) is shorthand for a registry cache.
    const type = attributes.get("type") ?? (text.includes("=") ? "" : "registry");
    return { type: type.toLowerCase(), attributes, line: entry.line };
  });
}

/** Index of the `build` verb in `docker build`, `docker image build` or `docker buildx build`. */
function dockerBuildIndex(words: string[]): number {
  if (words[0] !== "docker") return -1;
  if (words[1] === "build") return 1;
  if ((words[1] === "image" || words[1] === "buildx") && words[2] === "build") return 2;
  return -1;
}

function isBuildPush(step: StepModel): boolean {
  return usesAction(step, "docker/build-push-action");
}

export default defineRule({
  meta: {
    id: "caching/docker-layer-cache",
    ruleset: "caching",
    description: "Docker image builds in CI should import and export a layer cache.",
    rationale:
      "Hosted runners start with an empty BuildKit cache, so without `cache-from`/`cache-to` every layer (including dependency installs) is rebuilt on every run. The GitHub Actions cache backend defaults every build to the same `buildkit` scope, so multiple images overwrite each other's cache unless each gets a unique `scope`. Inline cache only supports `mode=min` (final-stage layers); a registry cache with `mode=max` also caches intermediate stages.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/build/ci/github-actions/cache/",
      "https://docs.docker.com/build/cache/backends/gha/",
      "https://docs.docker.com/build/cache/backends/registry/",
    ],
    impact: "high",
    example: {
      bad: "- uses: docker/build-push-action@v7\n  with:\n    push: true\n    tags: user/app:latest",
      good: "- uses: docker/build-push-action@v7\n  with:\n    push: true\n    tags: user/app:latest\n    cache-from: type=gha,scope=app\n    cache-to: type=gha,mode=max,scope=app",
    },
  },
  check({ project, report }) {
    const workflows = [...project.workflows, ...project.actions];
    const buildPushCount = [...steps(workflows)].filter(({ step }) => isBuildPush(step)).length;
    for (const { workflow, step } of steps(workflows)) {
      if (isBuildPush(step)) {
        const cacheFrom = step.with.get("cache-from");
        const cacheTo = step.with.get("cache-to");
        if (!cacheFrom && !cacheTo) {
          if (isTrue(step.with.get("no-cache")?.value)) continue;
          report({
            path: workflow.path,
            line: step.uses?.line ?? step.line,
            key: `${step.key}:no-cache`,
            message: "`docker/build-push-action` builds without a layer cache (`cache-from`/`cache-to`), so every layer is rebuilt.",
            suggestion:
              "Add `cache-from: type=gha,scope=<image>` and `cache-to: type=gha,mode=max,scope=<image>` (or a registry cache with `mode=max`).",
          });
          continue;
        }
        const entries = [...cacheEntries(cacheTo), ...cacheEntries(cacheFrom)];
        const unscoped = entries.find((entry) => entry.type === "gha" && !entry.attributes.has("scope"));
        if (unscoped && buildPushCount >= 2) {
          report({
            path: workflow.path,
            line: unscoped.line,
            key: `${step.key}:gha-scope`,
            message: `\`type=gha\` cache has no \`scope\` while the repository builds ${buildPushCount} images, so they overwrite each other's cache.`,
            suggestion: "Give each image a unique scope, e.g. `cache-from: type=gha,scope=<image>` and `cache-to: type=gha,mode=max,scope=<image>`.",
          });
        }
        const inline = entries.find((entry) => entry.type === "inline");
        if (inline) {
          report({
            path: workflow.path,
            line: inline.line,
            key: `${step.key}:inline`,
            message: "Inline cache only stores final-stage layers (`mode=min`), so multi-stage builds miss most of the cache.",
            suggestion: "Use a registry cache with `mode=max`, e.g. `cache-to: type=registry,ref=<image>:buildcache,mode=max`, or `type=gha,mode=max`.",
          });
        }
        continue;
      }
      let count = 0;
      for (const { command, line } of commandsOf(step)) {
        const words = commandWords(command);
        const index = dockerBuildIndex(words);
        if (index < 0) continue;
        const args = words.slice(index + 1);
        if (args.some((arg) => /^--(cache-from|no-cache|help)(=|$)/.test(arg) || arg === "-h")) continue;
        report({
          path: workflow.path,
          line,
          key: `${step.key}:docker-build:${count}`,
          message: `\`${words.slice(0, index + 1).join(" ")}\` runs without \`--cache-from\`, so every layer is rebuilt on a fresh runner.`,
          suggestion:
            "Use `docker/build-push-action` with `cache-from`/`cache-to`, or pass `--cache-from type=registry,ref=<image>:buildcache` (with `--cache-to ...,mode=max`) to `docker buildx build`.",
        });
        count += 1;
      }
    }
  },
});
