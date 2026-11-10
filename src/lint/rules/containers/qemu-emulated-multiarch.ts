import type { JobModel } from "../../parsers/workflow.js";
import { commandWords } from "../caching/shared.js";
import { commandsOf, defineRule, jobRunsOnLabels, stepLine } from "../helpers.js";
import { archOf, crossCompiles, isDynamic, jobBuilds, literalWith, platformList, runnerArch, siteDockerfile, type BuildSite } from "./buildx.js";

const NATIVE_RUNNER: Record<string, string> = { amd64: "ubuntu-24.04", arm64: "ubuntu-24.04-arm" };

/** `docker/setup-qemu-action` or `docker run --privileged tonistiigi/binfmt --install ...`. */
function registersQemu(job: JobModel, site: BuildSite): string | undefined {
  for (const step of job.steps.slice(0, job.steps.indexOf(site.step))) {
    if (step.if) continue;
    if (step.uses?.action.name === "docker/setup-qemu-action") return "docker/setup-qemu-action";
    for (const { command } of commandsOf(step)) {
      const words = commandWords(command);
      if (words.some((word) => word.startsWith("tonistiigi/binfmt")) && words.includes("--install")) return "tonistiigi/binfmt --install";
    }
  }
  return undefined;
}

function platformsOf(site: BuildSite): { platforms: string[]; line: number } | undefined {
  if (site.command) {
    const raw = site.command.build.flags.get("platform") ?? [];
    if (raw.length === 0 || raw.some(isDynamic)) return undefined;
    return { platforms: [...new Set(raw.flatMap(platformList))], line: site.command.line };
  }
  const value = literalWith(site.step, "platforms");
  if (value === undefined) return undefined;
  return { platforms: [...new Set(platformList(value))], line: site.step.with.get("platforms")?.line ?? stepLine(site.step) };
}

function imageName(site: BuildSite): string {
  const tags = site.command ? (site.command.build.flags.get("tag") ?? []).join("\n") : (literalWith(site.step, "tags") ?? "");
  const first = platformList(tags)[0];
  if (first === undefined || isDynamic(first)) return "ghcr.io/OWNER/IMAGE";
  return first.replace(/@.*$/, "").replace(/:[^/:]+$/, "");
}

function matrixSnippet(image: string, platforms: string[]): string {
  if (platforms.some((platform) => !NATIVE_RUNNER[archOf(platform) ?? ""])) {
    return "Select a verified native/remote builder for every requested platform. Retain architectures without a mapped hosted-runner label; do not silently drop them.";
  }
  const legs = platforms.flatMap((platform) => {
    const arch = archOf(platform) ?? "";
    return [`          - platform: ${platform}`, `            runner: ${NATIVE_RUNNER[arch] ?? "ubuntu-24.04"}`];
  });
  return [
    "jobs:",
    "  build:",
    "    strategy:",
    "      matrix:",
    "        include:",
    ...legs,
    "    runs-on: ${{ matrix.runner }}",
    "    steps:",
    "      # checkout + docker/login-action as before, no setup-qemu-action",
    "      - uses: docker/setup-buildx-action@v4",
    "      - id: build",
    "        uses: docker/build-push-action@v7",
    "        with:",
    "          platforms: ${{ matrix.platform }}",
    `          outputs: type=image,name=${image},push-by-digest=true,name-canonical=true,push=true`,
    "      - run: mkdir -p .ci-digests && touch \".ci-digests/${DIGEST#sha256:}\"",
    "        env:",
    "          DIGEST: ${{ steps.build.outputs.digest }}",
    "      - uses: actions/upload-artifact@v4",
    "        with:",
    "          name: digests-${{ strategy.job-index }}",
    "          path: .ci-digests/*",
    "  merge:",
    "    needs: build",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      # docker/login-action as before",
    "      - uses: actions/download-artifact@v4",
    "        with:",
    "          pattern: digests-*",
    "          path: .ci-digests",
    "          merge-multiple: true",
    "      - uses: docker/setup-buildx-action@v4",
    "      - working-directory: .ci-digests",
    `        run: docker buildx imagetools create -t ${image}:<original-tag> $(printf '${image}@sha256:%s ' *)`,
  ].join("\n");
}

export default defineRule({
  meta: {
    id: "containers/qemu-emulated-multiarch",
    ruleset: "containers",
    description: "Multi-platform image builds should run each architecture on a native runner instead of under QEMU emulation.",
    rationale:
      "Registering QEMU and requesting a foreign platform does not establish that build steps execute under emulation: native remote nodes, fixed-platform stages, cross-compilation, pruning and cache hits may avoid it. Where measurements show emulated compilation/compression, native nodes or cross-compilation can help. Compare full build and publication costs, verify hosted-runner availability, and preserve every platform, tag, artifact and test requirement.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/build/building/multi-platform/",
      "https://docs.docker.com/build/ci/github-actions/multi-platform/",
      "https://docs.github.com/en/actions/reference/runners/github-hosted-runners",
      "https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/",
    ],
    impact: "high",
    fixable: false,
    example: {
      bad: "runs-on: ubuntu-24.04\nsteps:\n  - uses: docker/setup-qemu-action@v4\n  - uses: docker/setup-buildx-action@v4\n  - uses: docker/build-push-action@v7\n    with:\n      platforms: linux/amd64,linux/arm64\n      push: true",
      good: "strategy:\n  matrix:\n    include:\n      - { platform: linux/amd64, runner: ubuntu-24.04 }\n      - { platform: linux/arm64, runner: ubuntu-24.04-arm }\nruns-on: ${{ matrix.runner }}\nsteps:\n  - uses: docker/build-push-action@v7\n    with:\n      platforms: ${{ matrix.platform }}\n      outputs: type=image,push-by-digest=true,name-canonical=true,push=true\n# merge job: docker buildx imagetools create -t <image>:<tag> <image>@sha256:<amd64> <image>@sha256:<arm64>",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        const native = runnerArch(job);
        if (native === undefined) continue;
        const runner = jobRunsOnLabels(job).join(", ");
        for (const site of jobBuilds(workflow, job)) {
          const qemu = registersQemu(job, site);
          if (!qemu) continue;
          if ([workflow.env, job.env, site.step.env].some((env) =>
            ["DOCKER_HOST", "DOCKER_CONTEXT", "BUILDX_BUILDER"].some((key) => key in env))) continue;
          if (site.step.with.has("builder") || site.command?.build.flags.has("builder")) continue;
          const preceding = job.steps.slice(0, job.steps.indexOf(site.step));
          if (preceding.some((step) =>
            (step.uses?.action.name === "docker/setup-buildx-action" &&
              (step.with.has("endpoint") || step.with.has("append") ||
                ["remote", "cloud", "kubernetes"].includes(literalWith(step, "driver") ?? ""))) ||
            commandsOf(step).some(({ command }) => /\bdocker\s+buildx\s+(?:create|use)\b/.test(command)))) continue;
          const found = platformsOf(site);
          if (!found) continue;
          const emulated = found.platforms.filter((platform) => {
            const arch = archOf(platform);
            return (arch === "amd64" || arch === "arm64") && arch !== native;
          });
          if (emulated.length === 0) continue;
          const dockerfile = siteDockerfile(project, site);
          if (!dockerfile || crossCompiles(dockerfile)) continue;
          const runs = dockerfile.stages.flatMap((stage) => {
            const platform = dockerfile.instructions.find((instruction) => instruction.keyword === "FROM" && instruction.line === stage.line)?.flags.get("platform")?.at(-1);
            if (platform && archOf(platform) === native) return [];
            return stage.instructions.filter((instruction) => instruction.keyword === "RUN");
          });
          if (runs.length === 0) continue;
          const image = imageName(site);
          report({
            path: workflow.path,
            line: found.line,
            key: `${job.key}:${site.step.key}:qemu:${found.line}`,
            message: `\`${emulated.join(",")}\` is requested on \`${runner}\` (${native}) after ${qemu}, and ${dockerfile.path} contains ${runs.length} potentially relevant RUN instruction(s) without a recognized cross-compilation pattern. This can involve QEMU, but cached/pruned stages or native builder nodes can avoid emulation; inspect build logs and timings.`,
            suggestion: `If emulation is the bottleneck, compare verified native runners/nodes or cross-compilation. The illustrative platform split below is not a drop-in workflow: preserve all existing dimensions, inputs, tests, tags, permissions, cache settings and publication metadata, and pin/review added actions.\n${matrixSnippet(image, found.platforms)}\nCross-compilation with \`FROM --platform=$BUILDPLATFORM\` and \`$TARGETARCH\` also requires a toolchain and dependency setup supporting the target.`,
            impact: "high",
            confidence: "medium",
          });
        }
      }
    }
  },
});
