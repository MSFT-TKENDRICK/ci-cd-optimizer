import type { DockerInstruction, DockerStage } from "../../parsers/dockerfile.js";
import { defineRule } from "../helpers.js";
import {
  cacheMounts,
  dependencyInstall,
  fileOf,
  hasSyntaxDirective,
  shellCommands,
  stageLabel,
  systemInstall,
  toolchainBuild,
  workdirBefore,
  type CacheMount,
  type ShellCommand,
} from "./docker.js";

interface CacheSpec {
  label: string;
  /** Cache directories needed by the tool; each must be covered by a mount. */
  needs: Array<{ pattern: RegExp; mount: (workdir: string) => string; note?: string }>;
}

const SPECS: Record<string, CacheSpec> = {
  npm: { label: "npm", needs: [{ pattern: /\.npm\/?$/, mount: () => "--mount=type=cache,target=/root/.npm" }] },
  pnpm: {
    label: "pnpm",
    needs: [{ pattern: /pnpm/, mount: () => "--mount=type=cache,id=pnpm,target=/pnpm/store", note: "Set `ENV PNPM_HOME=/pnpm` so the store lives under the mount." }],
  },
  yarn: {
    label: "Yarn",
    needs: [{ pattern: /yarn/, mount: () => "--mount=type=cache,target=/usr/local/share/.cache/yarn", note: "For Yarn Berry mount `/root/.yarn/berry/cache` instead." }],
  },
  bun: { label: "Bun", needs: [{ pattern: /\.bun/, mount: () => "--mount=type=cache,target=/root/.bun/install/cache" }] },
  pip: { label: "pip", needs: [{ pattern: /pip/, mount: () => "--mount=type=cache,target=/root/.cache/pip" }] },
  poetry: { label: "Poetry", needs: [{ pattern: /pypoetry|poetry/, mount: () => "--mount=type=cache,target=/root/.cache/pypoetry" }] },
  uv: { label: "uv", needs: [{ pattern: /(^|\/)uv\/?$|\.cache\/uv/, mount: () => "--mount=type=cache,target=/root/.cache/uv" }] },
  "go-mod": { label: "Go modules", needs: [{ pattern: /pkg\/mod/, mount: () => "--mount=type=cache,target=/go/pkg/mod" }] },
  "go-build": {
    label: "Go build",
    needs: [
      { pattern: /pkg\/mod/, mount: () => "--mount=type=cache,target=/go/pkg/mod" },
      { pattern: /go-build/, mount: () => "--mount=type=cache,target=/root/.cache/go-build" },
    ],
  },
  "cargo-fetch": {
    label: "Cargo registry",
    needs: [{ pattern: /cargo\/registry/, mount: () => "--mount=type=cache,target=/usr/local/cargo/registry" }],
  },
  "cargo-build": {
    label: "Cargo",
    needs: [
      { pattern: /cargo\/registry/, mount: () => "--mount=type=cache,target=/usr/local/cargo/registry" },
      {
        pattern: /(^|\/)target\/?$/,
        mount: (workdir) => `--mount=type=cache,target=${workdir ? `${workdir.replace(/\/$/, "")}/target` : "<workdir>/target"}`,
        note: "A cached target/ is not part of the layer: copy the built binary out of it in the same RUN.",
      },
    ],
  },
  maven: { label: "Maven", needs: [{ pattern: /\.m2/, mount: () => "--mount=type=cache,target=/root/.m2" }] },
  gradle: { label: "Gradle", needs: [{ pattern: /\.gradle/, mount: () => "--mount=type=cache,target=/root/.gradle" }] },
  dotnet: { label: "NuGet", needs: [{ pattern: /nuget/i, mount: () => "--mount=type=cache,target=/root/.nuget/packages" }] },
  apt: {
    label: "apt",
    needs: [
      { pattern: /^\/var\/cache\/apt/, mount: () => "--mount=type=cache,target=/var/cache/apt,sharing=locked" },
      { pattern: /^\/var\/lib\/apt/, mount: () => "--mount=type=cache,target=/var/lib/apt,sharing=locked" },
    ],
  },
};

const KNOWN_TARGETS = Object.values(SPECS).flatMap((spec) => spec.needs.map((need) => need.pattern));

function cacheTool(command: ShellCommand): string | undefined {
  const install = dependencyInstall(command.words);
  if (install === "go") return "go-mod";
  if (install === "cargo") return command.words[1] === "build" ? "cargo-build" : "cargo-fetch";
  if (install === "bundler" || install === "composer") return undefined;
  if (install) return install;
  const build = toolchainBuild(command.words);
  if (build === "go build") return "go-build";
  if (build === "cargo build") return "cargo-build";
  if (build === "mvn package") return "maven";
  if (build === "gradle build") return "gradle";
  if (build?.startsWith("dotnet")) return "dotnet";
  if (systemInstall(command.words)?.installer === "apt") return "apt";
  return undefined;
}

function runsAsNonRoot(stage: DockerStage, instruction: DockerInstruction): boolean {
  let user: string | undefined;
  for (const candidate of stage.instructions) {
    if (candidate === instruction) break;
    if (candidate.keyword === "USER") user = candidate.args.trim();
  }
  return user !== undefined && !/^(root|0)(:|$)/.test(user);
}

function missingMounts(spec: CacheSpec, mounts: CacheMount[]): CacheSpec["needs"] {
  return spec.needs.filter((need) => !mounts.some((mount) => need.pattern.test(mount.target)));
}

export default defineRule({
  meta: {
    id: "containers/cache-mount",
    ruleset: "containers",
    description: "Dependency installs and compiles in Dockerfiles should use BuildKit cache mounts for package-manager and compiler caches.",
    rationale:
      "When a dependency layer is invalidated, a cache mount (`RUN --mount=type=cache`) lets the package manager reuse previously downloaded packages and compiler output instead of fetching everything again, and keeps those caches out of the image. Cache mounts live in the builder, so on ephemeral hosted runners pair them with a persistent builder or export them (for example with buildkit-cache-dance) to benefit across CI runs.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/build/cache/optimize/#use-cache-mounts",
      "https://docs.docker.com/reference/dockerfile/#run---mounttypecache",
      "https://docs.docker.com/build/ci/github-actions/cache/#cache-mounts",
      "https://pnpm.io/docker",
    ],
    impact: "medium",
    example: {
      bad: "FROM node:22-slim\nCOPY package.json package-lock.json ./\nRUN npm ci",
      good: "# syntax=docker/dockerfile:1\nFROM node:22-slim\nCOPY package.json package-lock.json ./\nRUN --mount=type=cache,target=/root/.npm npm ci",
    },
  },
  check({ project, report }) {
    for (const model of project.dockerfiles) {
      const file = fileOf(project, model);
      const syntax = hasSyntaxDirective(file)
        ? ""
        : " Cache mounts need the Dockerfile frontend 1.2+; add `# syntax=docker/dockerfile:1` as the first line.";
      for (const stage of model.stages) {
        if (/windows|nanoserver|servercore/i.test(`${stage.image}:${stage.tag ?? ""}`)) continue;
        let ordinal = -1;
        for (const instruction of stage.instructions) {
          if (instruction.keyword !== "RUN") continue;
          ordinal += 1;
          const mounts = cacheMounts(instruction);
          // A cache mount on an unrecognized path may be a custom cache directory for this tool.
          if (mounts.some((mount) => !KNOWN_TARGETS.some((pattern) => pattern.test(mount.target)))) continue;
          const seen = new Set<string>();
          for (const command of shellCommands(file, instruction)) {
            const tool = cacheTool(command);
            if (!tool || seen.has(tool)) continue;
            seen.add(tool);
            const spec = SPECS[tool];
            if (!spec) continue;
            const missing = missingMounts(spec, mounts);
            if (missing.length === 0) continue;
            const workdir = workdirBefore(stage, instruction) ?? "";
            const nonRoot = runsAsNonRoot(stage, instruction)
              ? " This stage runs as a non-root USER: point the target at that user's home and add `uid=`/`gid=` to the mount."
              : "";
            const apt =
              tool === "apt"
                ? " Also remove `/etc/apt/apt.conf.d/docker-clean` first so downloaded .deb files stay in the cache."
                : "";
            const noCache = command.words.includes("--no-cache-dir") ? " Drop `--no-cache-dir` once the cache is mounted." : "";
            report({
              path: model.path,
              line: command.line,
              key: `stage:${stageLabel(stage)}:run[${ordinal}]:${tool}`,
              message: `\`${command.words.slice(0, 3).join(" ")}\` runs without a BuildKit cache mount, so every rebuild of this layer downloads ${tool === "apt" ? "packages" : "dependencies"} from scratch instead of reusing the ${spec.label} cache.`,
              suggestion: `Use \`RUN ${missing.map((need) => need.mount(workdir)).join(" ")} ${command.words.slice(0, 3).join(" ")} ...\`.${missing.map((need) => (need.note ? ` ${need.note}` : "")).join("")}${apt}${noCache}${nonRoot}${syntax}`,
            });
          }
        }
      }
    }
  },
});
