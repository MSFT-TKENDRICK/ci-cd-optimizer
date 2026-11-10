import type { DockerInstruction, DockerStage } from "../../parsers/dockerfile.js";
import { cacheMounts, fileOf, hasSyntaxDirective, shellCommands, stageLabel } from "../containers/docker.js";
import { defineRule } from "../helpers.js";
import { cliConf, hasFlag, isTruthyConf, nestedInvocations, nixInvocation, type NixInvocation } from "./shared.js";

/** The official image on any registry or mirror: `nixos/nix`, `docker.io/nixos/nix`, `ghcr.io/nixos/nix`, `mirror.example:5000/nixos/nix`. */
const NIXOS_NIX_IMAGE = /^(?:[^/\s]+\/)*nixos\/nix$/;

/** nix.conf text that turns the sandbox back on (`sandbox = true` or `sandbox = relaxed`). */
const SANDBOX_ON = /\bsandbox\s*=\s*["']?(?:true|relaxed)\b/;

function realizesBuild(invocation: NixInvocation): boolean {
  if (hasFlag(invocation, "--dry-run", "--help", "-h", "--version")) return false;
  return invocation.binary === "nix-build" || (invocation.binary === "nix" && invocation.subcommand === "build");
}

function enablesSandbox(invocation: NixInvocation, path: string): boolean {
  return cliConf(invocation, path).some((setting) => setting.key === "sandbox" && (isTruthyConf(setting.value) || setting.value === "relaxed"));
}

/** An earlier instruction that sets `sandbox` via `NIX_CONFIG`/nix.conf, or copies in an unknown `/etc/nix` config. */
function configuresSandbox(instructions: DockerInstruction[]): boolean {
  return instructions.some((instruction) => {
    if (instruction.keyword === "ENV" || instruction.keyword === "RUN") return SANDBOX_ON.test(instruction.args);
    if (instruction.keyword === "COPY" || instruction.keyword === "ADD") return /(?:^|\s)\/etc\/nix\b/.test(instruction.args);
    return false;
  });
}

function display(text: string): string {
  const flat = text.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

interface NixStage {
  /** The `nixos/nix` reference the stage is (transitively) based on. */
  image: string;
  /** Instructions inherited from parent stages plus this one's, in order. */
  inherited: DockerInstruction[];
}

export default defineRule({
  meta: {
    id: "nix/nix-build-inside-docker",
    ruleset: "nix",
    description: "Review Nix sandboxing and store-cache reuse when Dockerfile RUN instructions build with a nixos/nix-named base.",
    rationale:
      "Docker's isolation boundary is not the Nix build sandbox. Some nixos/nix releases disable Nix sandboxing for container compatibility, but a name, mirror or tag does not establish the running configuration or namespace capabilities. A missed BuildKit layer can repeat Nix work, while parent layers, cache mounts and substituters may still provide reuse. Moving image construction outside Docker changes build/runtime assumptions and must be validated; it does not automatically enable sandboxing or guarantee one layer per store path.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://hub.docker.com/r/nixos/nix",
      "https://github.com/NixOS/nix/blob/master/docker.nix",
      "https://nix.dev/manual/nix/latest/command-ref/conf-file.html#conf-sandbox",
      "https://nixos.org/manual/nixpkgs/stable/#ssec-pkgs-dockerTools-streamLayeredImage",
      "https://nix.dev/tutorials/nixos/building-and-running-docker-images",
      "https://github.com/nlewo/nix2container",
      "https://docs.docker.com/reference/dockerfile/#run---mounttypecache",
    ],
    impact: "medium",
    example: {
      bad: "FROM nixos/nix:2.24.0 AS builder\nCOPY . /src\nWORKDIR /src\nRUN nix --extra-experimental-features 'nix-command flakes' build .#app",
      good: '# flake.nix\npackages.x86_64-linux.image = pkgs.dockerTools.streamLayeredImage {\n  name = "app";\n  tag = "latest";\n  contents = [ app ];\n  config.Cmd = [ "${app}/bin/app" ];\n};\n# CI: nix build .#image && ./result | docker image load',
    },
  },
  check({ project, report }) {
    for (const model of project.dockerfiles) {
      const file = fileOf(project, model);
      const syntax = hasSyntaxDirective(file) ? "" : " Cache mounts need `# syntax=docker/dockerfile:1` as the first line.";
      const nixStages = new Map<string, NixStage>();
      for (const stage of model.stages) {
        const nix = baseOf(stage, nixStages);
        if (!nix) continue;
        if (stage.name) nixStages.set(stage.name.toLowerCase(), { image: nix.image, inherited: [...nix.inherited, ...stage.instructions] });
        let ordinal = -1;
        for (const [position, instruction] of stage.instructions.entries()) {
          if (instruction.keyword !== "RUN") continue;
          ordinal += 1;
          if (cacheMounts(instruction).some((mount) => /^\/nix(?:\/|$)/.test(mount.target))) continue;
          if (configuresSandbox([...nix.inherited, ...stage.instructions.slice(0, position)])) continue;
          for (const command of shellCommands(file, instruction)) {
            const root = nixInvocation(command.text, command.line);
            if (!root) continue;
            const chain = nestedInvocations(root);
            const build = chain.find(realizesBuild);
            if (!build || chain.some((invocation) => enablesSandbox(invocation, model.path))) continue;
            const based = NIXOS_NIX_IMAGE.test(stage.image.toLowerCase()) ? "" : ` (via stage \`${stage.image}\`)`;
            report({
              path: model.path,
              line: command.line,
              key: `stage:${stageLabel(stage)}:run[${ordinal}]:nix-build`,
              message: `\`${display(command.text)}\` builds inside \`${nix.image}\`${based}. No recognized sandbox enablement or Nix cache mount is visible for this instruction. Check the actual image configuration and layer-cache behavior; the image name alone does not establish either.`,
              suggestion: `Inspect effective Nix sandbox/daemon policy and measure repeated BuildKit cache misses. Consider building a tested dockerTools/nix2container image outside Docker, preserving runtime closure, ownership and configuration. If retaining a cache mount, persist the store/database consistently and explicitly materialize required runtime outputs into the final image: cache-mount contents are not committed as layer files.${syntax} Do not enable privileged containers merely to silence this insight.`,
              confidence: "low",
            });
            break;
          }
        }
      }
    }
  },
});

/** The `nixos/nix` base of a stage: the image itself, or an earlier stage built on it. */
function baseOf(stage: DockerStage, nixStages: Map<string, NixStage>): NixStage | undefined {
  const image = stage.image.toLowerCase();
  const parent = nixStages.get(image);
  if (parent) return parent;
  if (!NIXOS_NIX_IMAGE.test(image)) return undefined;
  return { image: `${stage.image}${stage.tag ? `:${stage.tag}` : ""}`, inherited: [] };
}
