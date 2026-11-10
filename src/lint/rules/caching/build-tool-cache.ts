import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import { commandsOf, defineRule } from "../helpers.js";
import { anyUses, basename, cacheCovers, commandWords, isFalse, usesAction } from "./shared.js";

type Tool = "gradle" | "maven" | "cargo" | "bazel" | "turbo" | "nx";

const TURBO_SUBCOMMANDS = new Set([
  "bin", "boundaries", "completion", "daemon", "devtools", "gen", "generate", "info", "link", "login", "logout",
  "ls", "prune", "query", "scan", "telemetry", "unlink", "watch",
]);
const CARGO_VERBS = new Set(["build", "b", "test", "t", "check", "c", "clippy", "nextest", "bench"]);
const BAZEL_VERBS = new Set(["build", "test", "coverage"]);
const BAZEL_CACHE_FLAG = /^--(remote_cache|disk_cache|remote_executor)\b/;
const HELP = new Set(["--version", "-v", "--help", "-h", "version", "help"]);

const MESSAGES: Record<Tool, { message: string; suggestion: string }> = {
  gradle: {
    message: "Gradle runs without caching dependencies or build outputs.",
    suggestion: "Add `gradle/actions/setup-gradle` before the build (caches dependencies, wrappers and the build cache), or set `cache: gradle` on actions/setup-java.",
  },
  maven: {
    message: "Maven runs without caching the local repository (~/.m2/repository).",
    suggestion: "Set `cache: maven` on actions/setup-java, or cache ~/.m2/repository with actions/cache.",
  },
  cargo: {
    message: "Cargo builds without caching ~/.cargo and target/.",
    suggestion: "Add `Swatinem/rust-cache` after installing the toolchain (or cache ~/.cargo and target/ with actions/cache).",
  },
  bazel: {
    message: "Bazel runs without a remote or disk cache.",
    suggestion:
      "Configure `--remote_cache` (or `--disk_cache` persisted with actions/cache), ideally in .bazelrc under a `ci` config; bazel-contrib/setup-bazel can persist disk and repository caches.",
  },
  turbo: {
    message: "Turborepo runs without remote caching (no TURBO_TOKEN/TURBO_TEAM) or a cached .turbo directory.",
    suggestion: "Set `TURBO_TOKEN` (from a secret) and `TURBO_TEAM` in env to use Remote Cache, or cache the `.turbo` directory with actions/cache.",
  },
  nx: {
    message: "Nx runs without a remote cache (Nx Cloud or self-hosted) or a cached .nx/cache directory.",
    suggestion: "Connect Nx Cloud (`NX_CLOUD_ACCESS_TOKEN`), configure a self-hosted remote cache, or cache `.nx/cache` with actions/cache.",
  },
};

/** Removes package-runner prefixes such as `npx`, `pnpm exec`, `yarn dlx` or `pnpm nx`. */
function normalize(words: string[]): string[] {
  let rest = words;
  for (let guard = 0; guard < 3; guard += 1) {
    const [first, second] = rest;
    if (first === "npx" || first === "bunx") {
      rest = rest.slice(1);
      while (rest[0]?.startsWith("-")) rest = rest.slice(1);
    } else if ((first === "pnpm" || first === "yarn" || first === "bun") && (second === "exec" || second === "dlx" || second === "x")) {
      rest = rest.slice(2);
    } else if (first === "npm" && second === "exec") {
      rest = rest.slice(2);
      if (rest[0] === "--") rest = rest.slice(1);
    } else if ((first === "pnpm" || first === "yarn") && (second === "nx" || second === "turbo")) {
      rest = rest.slice(1);
    } else {
      break;
    }
  }
  return rest;
}

function detect(words: string[]): Tool | undefined {
  const [first = "", second = "", ...rest] = normalize(words);
  const name = basename(first);
  const args = [second, ...rest].filter(Boolean);
  if (args.length > 0 && args.every((arg) => HELP.has(arg))) return undefined;
  if (["gradlew", "gradlew.bat", "gradle"].includes(name)) return "gradle";
  if (["mvn", "mvnw", "mvnw.cmd"].includes(name)) return "maven";
  if (name === "cargo") {
    const verb = args.find((arg) => !arg.startsWith("+"));
    return verb !== undefined && CARGO_VERBS.has(verb) ? "cargo" : undefined;
  }
  if (name === "bazel" || name === "bazelisk") {
    const verb = args.find((arg) => !arg.startsWith("-"));
    return verb !== undefined && BAZEL_VERBS.has(verb) ? "bazel" : undefined;
  }
  if (name === "turbo") return second === "run" || (second !== "" && !second.startsWith("-") && !TURBO_SUBCOMMANDS.has(second)) ? "turbo" : undefined;
  if (name === "nx") return ["affected", "run-many", "run"].includes(second) || second.startsWith("affected:") ? "nx" : undefined;
  return undefined;
}

function envNames(workflow: WorkflowModel, job: JobModel, all: StepModel[]): Set<string> {
  return new Set([workflow.env, job.env, ...all.map((step) => step.env)].flatMap((env) => Object.keys(env)));
}

function scriptsMention(all: StepModel[], pattern: RegExp): boolean {
  return all.some((step) => pattern.test(step.run?.value ?? ""));
}

function setupJavaCaches(all: StepModel[], manager: string): boolean {
  return all.some((step) => {
    if (!usesAction(step, "actions/setup-java")) return false;
    const cache = step.with.get("cache");
    return cache !== undefined && (cache.kind !== "literal" || String(cache.value).toLowerCase() === manager);
  });
}

function covered(tool: Tool, context: { project: ProjectModel; workflow: WorkflowModel; job: JobModel; all: StepModel[]; commands: string[][] }): boolean {
  const { project, workflow, job, all, commands } = context;
  switch (tool) {
    case "gradle":
      return anyUses(all, "gradle/actions/setup-gradle", "gradle/gradle-build-action") || setupJavaCaches(all, "gradle") || cacheCovers(all, /gradle/i);
    case "maven":
      return setupJavaCaches(all, "maven") || cacheCovers(all, /\.m2|maven/i);
    case "cargo":
      return (
        anyUses(all, "swatinem/rust-cache", "mozilla-actions/sccache-action") ||
        all.some((step) => usesAction(step, "actions-rust-lang/setup-rust-toolchain", "moonrepo/setup-rust") && !isFalse(step.with.get("cache")?.value)) ||
        cacheCovers(all, /\.cargo|(^|\/)target(\/|$)/i)
      );
    case "bazel":
      return (
        commands.some((words) => words.some((word) => BAZEL_CACHE_FLAG.test(word))) ||
        [...project.files.values()].some((file) => /bazelrc/i.test(basename(file.path)) && /remote_cache|disk_cache|remote_executor/.test(file.content)) ||
        cacheCovers(all, /./) ||
        all.some(
          (step) =>
            usesAction(step, "bazel-contrib/setup-bazel") &&
            ["disk-cache", "remote-cache"].some((input) => step.with.has(input) && !isFalse(step.with.get(input)?.value)),
        )
      );
    case "turbo": {
      const env = envNames(workflow, job, all);
      return (
        ["TURBO_TOKEN", "TURBO_TEAM", "TURBO_API"].some((name) => env.has(name)) ||
        scriptsMention(all, /TURBO_(TOKEN|TEAM|API)/) ||
        commands.some((words) => words.some((word) => /^--(token|team|api)(=|$)/.test(word))) ||
        cacheCovers(all, /turbo/i) ||
        all.some((step) => step.uses?.action.kind === "remote" && /turbo/i.test(step.uses.action.name ?? ""))
      );
    }
    case "nx": {
      const env = envNames(workflow, job, all);
      return (
        ["NX_CLOUD_ACCESS_TOKEN", "NX_CLOUD_AUTH_TOKEN"].some((name) => env.has(name)) ||
        scriptsMention(all, /NX_CLOUD_(ACCESS|AUTH)_TOKEN|nx-cloud\s+start-ci-run/) ||
        [...project.files.values()].some(
          (file) =>
            basename(file.path) === "nx.json" &&
            /nxCloud|nx-cloud|remote[-_]?cache|s3-cache|gcs-cache|azure-cache|shared-fs-cache|accessToken/i.test(file.content),
        ) ||
        cacheCovers(all, /(^|\/)\.?nx(\/|$)|nx[-_]?cache/i)
      );
    }
  }
}

export default defineRule({
  meta: {
    id: "caching/build-tool-cache",
    ruleset: "caching",
    description: "Build tools with their own caches (Gradle, Maven, Cargo, Bazel, Turborepo, Nx) should persist them between runs.",
    rationale:
      "Gradle, Maven, Cargo, Bazel, Turborepo and Nx can reuse downloads or build outputs when compatible caches are warm. Fresh runners often lack that state, but remote caches, preinstalled dependencies and tool-specific invalidation can change the benefit. A missing visible cache is a candidate for measurement, not proof that all work is repeated or that adding a cache will be faster.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/gradle/actions/blob/main/docs/setup-gradle.md",
      "https://github.com/actions/setup-java#caching-packages-dependencies",
      "https://github.com/Swatinem/rust-cache",
      "https://bazel.build/remote/caching",
      "https://turborepo.com/docs/core-concepts/remote-caching",
      "https://nx.dev/ci/features/remote-cache",
    ],
    impact: "medium",
    example: {
      bad: "- uses: actions/checkout@v6\n- run: ./gradlew build",
      good: "- uses: actions/checkout@v6\n- uses: gradle/actions/setup-gradle@v5\n- run: ./gradlew build",
    },
  },
  check({ project, input, report }) {
    const completeInventory = input.mode === "repository" && input.inventoryComplete;
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        const all = project.expandedSteps(job);
        const commands = all.flatMap((step) => commandsOf(step).map(({ command }) => commandWords(command)));
        const found = new Map<Tool, number>();
        for (const top of job.steps) {
          for (const step of project.expandedSteps({ ...job, steps: [top] })) {
            for (const { command, line } of commandsOf(step)) {
              const tool = detect(commandWords(command));
              if (!tool || found.has(tool)) continue;
              found.set(tool, step === top ? line : (top.uses?.line ?? top.line));
            }
          }
        }
        for (const [tool, line] of found) {
          if ((tool === "bazel" || tool === "nx") && !completeInventory) continue;
          if (covered(tool, { project, workflow, job, all, commands })) continue;
          report({ path: workflow.path, line, key: `${job.key}:${tool}`, ...MESSAGES[tool] });
        }
      }
    }
  },
});
