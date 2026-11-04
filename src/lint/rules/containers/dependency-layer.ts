import type { DockerInstruction } from "../../parsers/dockerfile.js";
import { defineRule } from "../helpers.js";
import { dependencyInstall, fileOf, isBroadCopy, shellCommands, stageLabel, type Ecosystem } from "./docker.js";

const LAYERING: Record<Ecosystem, string> = {
  npm: "`COPY package.json package-lock.json ./`, `RUN npm ci`, then `COPY . .`",
  pnpm:
    "`COPY pnpm-lock.yaml pnpm-workspace.yaml ./` and `RUN pnpm fetch` (fills the store from the lockfile alone), then `COPY . .` and `RUN pnpm install --offline --frozen-lockfile`",
  yarn: "`COPY package.json yarn.lock .yarnrc.yml ./` (plus `.yarn/releases` for Yarn Berry), `RUN yarn install --immutable` (`--frozen-lockfile` on Yarn 1), then `COPY . .`",
  bun: "`COPY package.json bun.lock ./`, `RUN bun install --frozen-lockfile`, then `COPY . .`",
  pip: "`COPY requirements*.txt ./`, `RUN pip install -r requirements.txt`, then `COPY . .`",
  poetry: "`COPY pyproject.toml poetry.lock ./`, `RUN poetry install --no-root`, then `COPY . .` and install the project",
  uv: "`COPY pyproject.toml uv.lock ./`, `RUN uv sync --frozen --no-install-project`, then `COPY . .` and `RUN uv sync --frozen`",
  go: "`COPY go.mod go.sum ./`, `RUN go mod download`, then `COPY . .` and build",
  bundler: "`COPY Gemfile Gemfile.lock ./`, `RUN bundle install`, then `COPY . .`",
  cargo: "`COPY Cargo.toml Cargo.lock ./` and `RUN cargo fetch` (or pre-build dependencies with cargo-chef), then `COPY . .` and build",
  maven: "`COPY pom.xml ./`, `RUN mvn dependency:go-offline`, then `COPY src ./src` and package",
  gradle: "`COPY build.gradle* settings.gradle* gradle.properties gradle/ ./`, `RUN gradle dependencies`, then `COPY . .` and build",
  dotnet: "`COPY *.sln *.csproj NuGet.config ./`, `RUN dotnet restore`, then `COPY . .` and `dotnet publish --no-restore`",
  composer: "`COPY composer.json composer.lock ./`, `RUN composer install --no-scripts --no-autoloader`, then `COPY . .` and `composer dump-autoload`",
};

const JS: ReadonlySet<Ecosystem> = new Set(["npm", "pnpm", "yarn", "bun"]);

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

interface PendingCopy {
  instruction: DockerInstruction;
  ordinal: number;
  installedBefore: Set<Ecosystem>;
  reported: boolean;
}

export default defineRule({
  meta: {
    id: "containers/dependency-layer",
    ruleset: "containers",
    description: "Dockerfiles should install dependencies from manifests and lockfiles before copying the rest of the source tree.",
    rationale:
      "BuildKit reuses a layer only while every input above it is unchanged. Copying the whole context before the install means each source edit (every agent iteration) re-downloads and re-installs all dependencies; copying only manifests and lockfiles first keeps the dependency layer cached until dependencies actually change.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/build/cache/optimize/#order-your-layers",
      "https://docs.docker.com/build/building/best-practices/",
      "https://pnpm.io/cli/fetch",
      "https://turborepo.com/docs/guides/tools/docker",
    ],
    impact: "high",
    example: {
      bad: "FROM node:22-slim\nWORKDIR /app\nCOPY . .\nRUN npm ci\nRUN npm run build",
      good: "FROM node:22-slim\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build",
    },
  },
  check({ project, report }) {
    const turbo = project.facts.monorepoTools.value.includes("turbo");
    for (const model of project.dockerfiles) {
      const file = fileOf(project, model);
      const installedByStage = new Map<string, Set<Ecosystem>>();
      for (const stage of model.stages) {
        const parent = installedByStage.get(stage.image.toLowerCase());
        const installed = new Set<Ecosystem>(parent ?? []);
        const pending: PendingCopy[] = [];
        let ordinal = 0;
        for (const instruction of stage.instructions) {
          if (isBroadCopy(instruction)) {
            pending.push({ instruction, ordinal, installedBefore: new Set(installed), reported: false });
            ordinal += 1;
            continue;
          }
          if (instruction.keyword !== "RUN") continue;
          for (const command of shellCommands(file, instruction)) {
            const ecosystem = dependencyInstall(command.words);
            if (!ecosystem) continue;
            for (const copy of pending) {
              if (copy.reported || copy.installedBefore.has(ecosystem)) continue;
              copy.reported = true;
              const hint =
                turbo && JS.has(ecosystem)
                  ? " In this Turborepo monorepo, `turbo prune <app> --docker` produces `out/json` (manifests) and `out/full` (sources) for exactly this split."
                  : "";
              report({
                path: model.path,
                line: copy.instruction.line,
                key: `stage:${stageLabel(stage)}:copy[${copy.ordinal}]`,
                message: `\`${excerpt(`${copy.instruction.keyword} ${copy.instruction.args}`)}\` copies the whole build context before \`${excerpt(command.text)}\` (line ${command.line}), so every source change invalidates the ${ecosystem} dependency layer.`,
                suggestion: `Copy only manifests and lockfiles first: ${LAYERING[ecosystem]}.${hint}`,
                related: [{ path: model.path, line: command.line }],
              });
            }
            installed.add(ecosystem);
          }
        }
        if (stage.name) installedByStage.set(stage.name.toLowerCase(), installed);
      }
    }
  },
});
