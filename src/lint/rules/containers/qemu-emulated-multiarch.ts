import type { JobModel } from "../../parsers/workflow.js";
import { commandWords } from "../caching/shared.js";
import { commandsOf, defineRule, jobRunsOnLabels, stepLine } from "../helpers.js";
import { archOf, crossCompiles, isDynamic, jobBuilds, literalWith, platformList, runnerArch, siteDockerfile, type BuildSite } from "./buildx.js";

const NATIVE_RUNNER: Record<string, string> = { amd64: "ubuntu-24.04", arm64: "ubuntu-24.04-arm" };

/** `docker/setup-qemu-action` or `docker run --privileged tonistiigi/binfmt --install ...`. */
function registersQemu(job: JobModel): string | undefined {
  for (const step of job.steps) {
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
    "      - run: mkdir -p /tmp/digests && touch \"/tmp/digests/${DIGEST#sha256:}\"",
    "        env:",
    "          DIGEST: ${{ steps.build.outputs.digest }}",
    "      - uses: actions/upload-artifact@v4",
    "        with:",
    "          name: digests-${{ strategy.job-index }}",
    "          path: /tmp/digests/*",
    "  merge:",
    "    needs: build",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      # docker/login-action as before",
    "      - uses: actions/download-artifact@v4",
    "        with:",
    "          pattern: digests-*",
    "          path: /tmp/digests",
    "          merge-multiple: true",
    "      - uses: docker/setup-buildx-action@v4",
    "      - working-directory: /tmp/digests",
    `        run: docker buildx imagetools create -t ${image}:latest $(printf '${image}@sha256:%s ' *)`,
  ].join("\n");
}

export default defineRule({
  meta: {
    id: "containers/qemu-emulated-multiarch",
    ruleset: "containers",
    description: "Multi-platform image builds should run each architecture on a native runner instead of under QEMU emulation.",
    rationale:
      "With docker/setup-qemu-action, BuildKit runs every RUN instruction of a foreign platform through QEMU user-mode emulation, which translates each guest CPU instruction in software. Docker's documentation warns that emulation can be much slower than native builds, especially for compilation and compression, and recommends native nodes or cross-compilation. GitHub offers native arm64 hosted runners (ubuntu-24.04-arm), so each platform can build natively and the per-platform digests can be merged into one manifest list.",
    kind: "practice",
    defaultSeverity: "warn",
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
        const qemu = registersQemu(job);
        const native = runnerArch(job);
        if (qemu === undefined || native === undefined) continue;
        const runner = jobRunsOnLabels(job).join(", ");
        for (const site of jobBuilds(workflow, job)) {
          const found = platformsOf(site);
          if (!found) continue;
          const emulated = found.platforms.filter((platform) => {
            const arch = archOf(platform);
            return (arch === "amd64" || arch === "arm64") && arch !== native;
          });
          if (emulated.length === 0) continue;
          const dockerfile = siteDockerfile(project, site);
          if (!dockerfile || crossCompiles(dockerfile)) continue;
          const runs = dockerfile.stages.flatMap((stage) => stage.instructions.filter((instruction) => instruction.keyword === "RUN"));
          if (runs.length === 0) continue;
          const image = imageName(site);
          report({
            path: workflow.path,
            line: found.line,
            key: `${job.key}:${site.step.key}:qemu:${found.line}`,
            message: `\`${emulated.join(",")}\` is built on \`${runner}\` (${native}) through ${qemu}: the ${runs.length} RUN instruction(s) of ${dockerfile.path} execute under QEMU user-mode emulation, which translates every ${emulated.map(archOf).join("/")} instruction in software, and ${dockerfile.path} does not cross-compile with \`FROM --platform=$BUILDPLATFORM\`.`,
            suggestion: `Build each platform on a native runner (arm64: \`ubuntu-24.04-arm\`), push by digest, then merge the digests into one manifest list:\n${matrixSnippet(image, found.platforms)}\nAlternatively use the reusable docker/github-builder/.github/workflows/build.yml@v1 workflow, or make the build stages cross-compile with \`FROM --platform=$BUILDPLATFORM\` and \`$TARGETARCH\`.`,
            impact: "high",
            confidence: "medium",
          });
        }
      }
    }
  },
});
