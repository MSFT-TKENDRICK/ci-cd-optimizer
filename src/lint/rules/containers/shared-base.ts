import type { DockerStage, DockerfileModel } from "../../parsers/dockerfile.js";
import type { SourceFile } from "../../types.js";
import { defineRule } from "../helpers.js";
import { contextSources, dependencyInstall, fileOf, isInternalBase, shellCommands, systemInstall, type ShellCommand } from "./docker.js";

const HOUSEKEEPING = /^(set|true|:|echo|rm|apt-get (update|clean|autoclean)|apt (update|clean)|apk update|ln|mkdir|chmod|chown|cd)\b/;
const TOOL_INSTALL = /^(npm (i|install) (-g|--global)|pnpm add -g|corepack (enable|prepare)|pip3? install|python3? -m pip install|gem install|go install|cargo install|curl|wget|dnf install|yum install|microdnf install|apk add|apt-get install|apt install)\b/;

function hash(text: string): string {
  let value = 5381;
  for (let index = 0; index < text.length; index += 1) value = ((value * 33) ^ text.charCodeAt(index)) >>> 0;
  return value.toString(16).padStart(8, "0");
}

function baseOf(stage: DockerStage): string {
  return `${stage.image}${stage.tag ? `:${stage.tag}` : ""}`;
}

interface Preamble {
  model: DockerfileModel;
  stage: DockerStage;
  base: string;
  steps: string[];
}

/** The normalized toolchain preamble of a stage: RUN installs between FROM and the first build-context COPY/ADD. */
function preamble(file: SourceFile | undefined, model: DockerfileModel, stage: DockerStage): Preamble | undefined {
  if (isInternalBase(model, stage)) return undefined;
  const packages = new Map<string, Set<string>>();
  const commands: string[] = [];
  let installs = 0;
  for (const instruction of stage.instructions) {
    if (contextSources(instruction) !== undefined) break;
    if (instruction.keyword !== "RUN") continue;
    for (const command of shellCommands(file, instruction)) {
      const text = command.words.join(" ");
      const system = systemInstall(command.words);
      if (system) {
        const set = packages.get(system.installer) ?? new Set<string>();
        for (const name of system.packages) set.add(name.replace(/^["']|["']$/g, ""));
        packages.set(system.installer, set);
        installs += 1;
        continue;
      }
      if (HOUSEKEEPING.test(text) || isDependencyInstall(command)) continue;
      if (TOOL_INSTALL.test(text)) installs += 1;
      commands.push(text);
    }
  }
  if (installs === 0) return undefined;
  const steps = [
    ...[...packages].sort(([a], [b]) => a.localeCompare(b)).map(([installer, names]) => `${installer}: ${[...names].sort().join(" ")}`),
    ...commands,
  ];
  return { model, stage, base: baseOf(stage), steps };
}

/** Project dependency installs depend on per-service manifests, so they are not part of a shared preamble. */
function isDependencyInstall(command: ShellCommand): boolean {
  return dependencyInstall(command.words) !== undefined;
}

function summarize(steps: string[]): string {
  const text = steps.map((step) => `\`${step.length > 50 ? `${step.slice(0, 47)}...` : step}\``).slice(0, 3).join(", ");
  return steps.length > 3 ? `${text} and ${steps.length - 3} more` : text;
}

function imageName(base: string): string {
  const name = base.split("@")[0]?.split(":")[0]?.split("/").pop() ?? "app";
  return name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

export default defineRule({
  meta: {
    id: "containers/shared-base",
    ruleset: "containers",
    description: "Dockerfiles that repeat the same base image and toolchain preamble should share a base image published to GHCR.",
    rationale:
      "When several services start from the same image and install the same toolchain, every service build and every runner repeats that work and stores its own copy of the layer. Publishing the preamble once as a shared base image (referenced by digest) builds it once, lets every service and agent sandbox pull the identical cached layer, and turns toolchain upgrades into a single reviewed digest bump.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["insights"],
    requires: ["complete-inventory"],
    defaultOptions: { minDockerfiles: 3 },
    validateOptions: (value) =>
      value.minDockerfiles !== undefined && (!Number.isInteger(value.minDockerfiles) || (value.minDockerfiles as number) < 2)
        ? ["minDockerfiles must be an integer >= 2"]
        : [],
    references: [
      "https://docs.docker.com/build/building/base-images/",
      "https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry",
      "https://docs.docker.com/build/building/best-practices/#pin-base-image-versions",
    ],
    impact: "medium",
    example: {
      bad: "# services/a/Dockerfile, services/b/Dockerfile, services/c/Dockerfile\nFROM node:22-slim\nRUN apt-get update && apt-get install -y --no-install-recommends git python3 make",
      good: "# each service\nFROM ghcr.io/acme/node-base@sha256:<digest>",
    },
  },
  check({ project, report, options }) {
    const groups = new Map<string, Preamble[]>();
    for (const model of [...project.dockerfiles].sort((a, b) => a.path.localeCompare(b.path))) {
      const file = fileOf(project, model);
      const signatures = new Set<string>();
      for (const stage of model.stages) {
        const entry = preamble(file, model, stage);
        if (!entry) continue;
        const signature = `${entry.base}\n${entry.steps.join("\n")}`;
        if (signatures.has(signature)) continue;
        signatures.add(signature);
        groups.set(signature, [...(groups.get(signature) ?? []), entry]);
      }
    }
    for (const [signature, entries] of groups) {
      if (entries.length < options.minDockerfiles) continue;
      const [first, ...others] = entries;
      if (!first) continue;
      report({
        path: first.model.path,
        line: first.stage.line,
        key: `base:${first.base}:${hash(signature)}`,
        confidence: "medium",
        message: `${entries.length} Dockerfiles start from \`${first.base}\` and repeat the same toolchain preamble (${summarize(first.steps)}).`,
        suggestion: `Move \`FROM ${first.base}\` and the shared install steps into one base Dockerfile, publish it from CI to \`ghcr.io/<org>/${imageName(first.base)}-base\`, and start each of these Dockerfiles with \`FROM ghcr.io/<org>/${imageName(first.base)}-base@sha256:<digest>\` (Dependabot can bump the digest). The layer is then built once and shared across the monorepo.`,
        related: others.map((entry) => ({ path: entry.model.path, line: entry.stage.line })),
      });
    }
  },
});
