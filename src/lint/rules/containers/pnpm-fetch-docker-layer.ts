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
      "A COPY layer is reused only while every copied file is byte-identical, so a dependency layer keyed on all workspace package.json files is rebuilt (and every package re-downloaded) whenever any of them changes, including version bumps and script edits, and each new workspace package needs another COPY line. `pnpm fetch` reads only `pnpm-lock.yaml` to download every dependency into the store, so that layer changes only with the lockfile; after `COPY . .`, `pnpm install --offline` just links packages from the warm store.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: ["https://pnpm.io/cli/fetch", "https://docs.docker.com/build/cache/optimize/#order-your-layers"],
    impact: "medium",
    fixable: false,
    example: {
      bad: "COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./\nCOPY packages/api/package.json packages/api/\nCOPY packages/web/package.json packages/web/\nRUN pnpm install --frozen-lockfile\nCOPY . .",
      good: "COPY pnpm-lock.yaml pnpm-workspace.yaml ./\nRUN pnpm fetch\nCOPY . .\nRUN pnpm install -r --offline",
    },
  },
  check({ project, report }) {
    for (const model of project.dockerfiles) {
      const workspace = workspaceRoot(project.files, model.path);
      if (!workspace) continue;
      const file = fileOf(project, model);
      const npmrc = project.files.has(workspace.replace(/pnpm-workspace\.yaml$/, ".npmrc"));
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
              message: `\`${command.text.trim()}\` in stage \`${stageLabel(stage)}\` is keyed on ${sources.length} workspace manifest${sources.length > 1 ? "s" : ""} (${listed}${more}): any change to any of them, even a version bump or script edit, re-downloads every dependency, and each new workspace package needs another COPY line. In this pnpm workspace (\`${workspace}\`), \`pnpm fetch\` fills the store from \`pnpm-lock.yaml\` alone.`,
              suggestion: `Warm the store from the lockfile, then install offline after copying the sources:\n  COPY pnpm-lock.yaml pnpm-workspace.yaml${npmrc ? " .npmrc" : ""} ./\n  RUN pnpm fetch\n  COPY . .\n  RUN pnpm install -r --offline\n(add \`--prod\` to both for a production-only image).`,
              related: state.manifests.map((entry) => ({ path: model.path, line: entry.instruction.line })),
              impact: "medium",
              confidence: "high",
            });
            state.fetched = true;
          }
        }
        if (stage.name) states.set(stage.name.toLowerCase(), state);
      }
    }
  },
});
