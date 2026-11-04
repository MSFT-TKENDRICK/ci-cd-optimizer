import type { Location } from "../../types.js";
import { defineRule } from "../helpers.js";
import { fileOf, shellCommands, systemInstall, toolchainBuild } from "./docker.js";

const BUILD_PACKAGES = new Set(["build-essential", "build-base", "gcc", "g++", "make", "git", "cmake", "clang", "musl-dev", "libc-dev"]);
const DEV_IMAGE = /(^|\/)\.devcontainer\/|(^|\/)(dev\.Dockerfile|Dockerfile\.dev(elopment)?|[^/]*\.dev\.Dockerfile)$/i;

function packageName(spec: string): string {
  return spec.split(/[=~<>]/)[0]?.toLowerCase() ?? spec;
}

function removesPackages(words: string[]): boolean {
  const [head, ...rest] = words;
  const name = head?.split("/").pop();
  if (name === "apk") return rest.includes("del");
  if (name === "apt-get" || name === "apt") return rest.some((word) => ["purge", "remove", "autoremove"].includes(word));
  return false;
}

function devInstall(words: string[]): string | undefined {
  const [head, verb, ...rest] = words;
  const name = head?.split("/").pop();
  const has = (pattern: RegExp) => rest.some((arg) => pattern.test(arg));
  if (name === "npm" && (verb === "ci" || verb === "install" || verb === "i")) {
    if (rest.some((arg) => arg === "-g" || arg === "--global")) return undefined;
    if (has(/^--(omit=dev|production|only=prod(uction)?)$/) || rest.join(" ").includes("--omit dev")) return undefined;
    return `npm ${verb}`;
  }
  if (name === "pnpm" && (verb === "install" || verb === "i")) {
    return has(/^(--prod|-P|--production)$/) ? undefined : "pnpm install";
  }
  if (name === "yarn" && (verb === undefined || verb === "install")) {
    return has(/^--production/) || rest.includes("focus") ? undefined : "yarn install";
  }
  return undefined;
}

const RUNTIME_HINTS: Array<{ pattern: RegExp; runtime: string }> = [
  { pattern: /^go build/, runtime: "`gcr.io/distroless/static-debian12` (build with `CGO_ENABLED=0`)" },
  { pattern: /^cargo/, runtime: "`gcr.io/distroless/cc-debian12` or `debian:bookworm-slim`" },
  { pattern: /^(mvn|gradle)/, runtime: "`eclipse-temurin:21-jre` or `gcr.io/distroless/java21-debian12`" },
  { pattern: /^dotnet/, runtime: "`mcr.microsoft.com/dotnet/aspnet` or `mcr.microsoft.com/dotnet/runtime-deps` (chiseled)" },
  { pattern: /^(npm|pnpm|yarn)/, runtime: "`node:<version>-slim` or `gcr.io/distroless/nodejs22-debian12`" },
];

export default defineRule({
  meta: {
    id: "containers/multi-stage",
    ruleset: "containers",
    description: "Single-stage Dockerfiles that install build toolchains or dev dependencies should use a builder stage and a minimal runtime stage.",
    rationale:
      "Compilers, git, and devDependencies are only needed to build. Shipping them makes every pull, push, and layer upload larger and slower (and widens the attack surface). A multi-stage build compiles in a builder stage and copies only artifacts into a slim or distroless runtime stage; BuildKit also builds independent stages in parallel.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/build/building/multi-stage/",
      "https://docs.docker.com/build/building/best-practices/#use-multi-stage-builds",
      "https://github.com/GoogleContainerTools/distroless",
    ],
    impact: "medium",
    example: {
      bad: "FROM golang:1.23\nWORKDIR /src\nCOPY . .\nRUN go build -o /app ./cmd/server\nCMD [\"/app\"]",
      good:
        "FROM golang:1.23 AS build\nWORKDIR /src\nCOPY go.mod go.sum ./\nRUN go mod download\nCOPY . .\nRUN CGO_ENABLED=0 go build -o /app ./cmd/server\n\nFROM gcr.io/distroless/static-debian12\nCOPY --from=build /app /app\nCMD [\"/app\"]",
    },
  },
  check({ project, report }) {
    for (const model of project.dockerfiles) {
      const [stage] = model.stages;
      if (model.stages.length !== 1 || !stage || DEV_IMAGE.test(model.path)) continue;
      const file = fileOf(project, model);
      const evidence: Array<{ label: string; line: number }> = [];
      let productionEnv = false;
      for (const instruction of stage.instructions) {
        if ((instruction.keyword === "ENV" || instruction.keyword === "ARG") && /\bNODE_ENV[= ]+["']?production\b/.test(instruction.args)) {
          productionEnv = true;
        }
        if (instruction.keyword !== "RUN") continue;
        const commands = shellCommands(file, instruction);
        const purges = commands.some((command) => removesPackages(command.words));
        const inlineProduction = /\bNODE_ENV=["']?production\b/.test(instruction.args);
        const prunes = commands.some((command) => /^(npm|pnpm) prune\b/.test(command.words.join(" ")));
        for (const command of commands) {
          const install = systemInstall(command.words);
          if (install && !purges) {
            const tools = install.packages.map(packageName).filter((name) => BUILD_PACKAGES.has(name));
            if (tools.length > 0) evidence.push({ label: `${install.installer} installs ${tools.map((tool) => `\`${tool}\``).join(", ")}`, line: command.line });
            continue;
          }
          const dev = devInstall(command.words);
          if (dev && !productionEnv && !inlineProduction && !prunes) {
            evidence.push({ label: `\`${dev}\` installs devDependencies`, line: command.line });
            continue;
          }
          const build = toolchainBuild(command.words);
          if (build) evidence.push({ label: `\`${build}\` compiles in the final image`, line: command.line });
        }
      }
      if (evidence.length === 0) continue;
      const runtime =
        RUNTIME_HINTS.find((hint) => evidence.some((entry) => hint.pattern.test(entry.label.replace(/^`/, ""))))?.runtime ??
        "a `-slim` or distroless image";
      const related: Location[] = [];
      for (const entry of evidence) {
        if (!related.some((location) => location.line === entry.line)) related.push({ path: model.path, line: entry.line });
      }
      const shown = evidence.slice(0, 3).map((entry) => `${entry.label} (line ${entry.line})`);
      report({
        path: model.path,
        line: stage.line,
        key: "single-stage",
        message: `Single-stage image ships its build toolchain: ${shown.join("; ")}${evidence.length > 3 ? `; and ${evidence.length - 3} more` : ""}.`,
        suggestion: `Split into a builder stage (\`FROM ${stage.image}${stage.tag ? `:${stage.tag}` : ""} AS build\`) that installs toolchains and dependencies and builds, and a runtime stage based on ${runtime} that only \`COPY --from=build\` the built artifacts and production dependencies.`,
        related,
      });
    }
  },
});
