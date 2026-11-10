import type { DockerInstruction } from "../../parsers/dockerfile.js";
import { defineRule } from "../helpers.js";
import { contextSources, fileOf, isBroadCopy, shellCommands, stageLabel } from "./docker.js";

interface StageState {
  fetched: boolean;
  broad: boolean;
  manifests: Array<{ instruction: DockerInstruction; sources: string[] }>;
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/** A pnpm workspace root at or above the Dockerfile's directory. */
function workspaceRoot(files: ReadonlyMap<string, unknown>, dockerfilePath: string): string | undefined {
  for (let dir = dirOf(dockerfilePath); ; dir = dirOf(dir)) {
    const candidate = dir ? `${dir}/pnpm-workspace.yaml` : "pnpm-workspace.yaml";
    if (files.has(candidate)) return candidate;
    if (!dir) return undefined;
  }
}

/** `packages/api/package.json`, `apps/*\/package.json`: a workspace package manifest rather than the root one. */
function nestedManifests(instruction: DockerInstruction): string[] {
  return (contextSources(instruction) ?? []).filter((source) => /^(?:\.\/)?[^/].*\/package\.json$/.test(source));
}

export default defineRule({
  meta: {
    id: "containers/pnpm-fetch-docker-layer",
    ruleset: "containers",
    description: "A pnpm-workspace Dockerfile copies every workspace package.json before `pnpm install` instead of warming the store with `pnpm fetch`.",
    rationale:
      "Copying workspace manifests before installation can invalidate the install layer on non-dependency edits. A warm pnpm store or cache mount may already avoid downloads. pnpm fetch can separate dependency fetching from manifest changes, but also depends on pnpm version, workspace configuration, patches, authentication and relevant build inputs. An offline install still performs linking and may run lifecycle scripts. Preserve frozen-lock policy and all required inputs, then benchmark.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://pnpm.io/cli/fetch",
      "https://github.com/pnpm/pnpm/blob/v10.11.0/pkg-manager/plugin-commands-installation/src/fetch.ts",
      "https://docs.docker.com/build/cache/optimize/#order-your-layers",
    ],
    impact: "medium",
    fixable: false,
    example: {
      bad: "COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./\nCOPY packages/api/package.json packages/api/\nCOPY packages/web/package.json packages/web/\nRUN pnpm install --frozen-lockfile\nCOPY . .",
      good: "COPY pnpm-lock.yaml pnpm-workspace.yaml ./\n# Also supply required patches/non-secret config; use secret mounts for authentication.\nRUN pnpm fetch --frozen-lockfile\nCOPY . .\nRUN pnpm install -r --offline --frozen-lockfile",
    },
  },
  check({ project, report }) {
    for (const model of project.dockerfiles) {
      const workspace = workspaceRoot(project.files, model.path);
      if (!workspace) continue;
      const file = fileOf(project, model);
      const states = new Map<string, StageState>();
      for (const stage of model.stages) {
        const parent = states.get(stage.image.toLowerCase());
        const state: StageState = parent
          ? { fetched: parent.fetched, broad: parent.broad, manifests: [...parent.manifests] }
          : { fetched: false, broad: false, manifests: [] };
        for (const instruction of stage.instructions) {
          if (instruction.keyword === "COPY" || instruction.keyword === "ADD") {
            if (isBroadCopy(instruction)) state.broad = true;
            const sources = nestedManifests(instruction);
            if (sources.length > 0) state.manifests.push({ instruction, sources });
            continue;
          }
          if (instruction.keyword !== "RUN") continue;
          for (const command of shellCommands(file, instruction)) {
            const [head, verb, ...rest] = command.words;
            if (head !== "pnpm" && !/\/pnpm$/.test(head ?? "")) continue;
            if (verb === "fetch") {
              state.fetched = true;
              continue;
            }
            if (verb !== "install" && verb !== "i") continue;
            if (rest.some((arg) => ["-g", "--global", "--offline"].includes(arg))) continue;
            if (state.fetched || state.broad || state.manifests.length === 0) continue;
            const sources = state.manifests.flatMap((entry) => entry.sources);
            const listed = sources.slice(0, 3).map((source) => `\`${source}\``).join(", ");
            const more = sources.length > 3 ? ` and ${sources.length - 3} more` : "";
            report({
              path: model.path,
              line: command.line,
              key: `stage:${stageLabel(stage)}:pnpm-fetch:${command.line}`,
              message: `\`${command.text.trim()}\` in stage \`${stageLabel(stage)}\` follows copies of ${sources.length} workspace manifest${sources.length > 1 ? "s" : ""} (${listed}${more}). Manifest edits can invalidate this layer; they do not necessarily re-download dependencies from a warm store. Consider measuring a separate \`pnpm fetch\` layer for workspace \`${workspace}\`.`,
              suggestion: `Consider a fetch layer supplied with the lockfile, workspace configuration and required patches/non-secret settings, followed by source copy and an offline frozen-lock install. Preserve pnpm version, original filters, production/development dependency selection and lifecycle behavior. Supply registry credentials through secret mounts, not copied .npmrc secrets. Validate all dependency inputs before reducing the layer's file set.`,
              related: state.manifests.map((entry) => ({ path: model.path, line: entry.instruction.line })),
              impact: "medium",
              confidence: "medium",
            });
            state.fetched = true;
          }
        }
        if (stage.name) states.set(stage.name.toLowerCase(), state);
      }
    }
  },
});
