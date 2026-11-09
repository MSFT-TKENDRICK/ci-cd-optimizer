import { field, toJS } from "../../parsers/yaml.js";
import { hasTrigger, trigger, type JobModel, type StepModel, type WorkflowModel } from "../../parsers/workflow.js";
import { commandWords, isFalse, isTrue, usesAction } from "../caching/shared.js";
import { commandsOf, defineRule, jobRunsOnLabels } from "../helpers.js";
import { cacheEntries, flagSet, isBuildPush, literalWith, parseBuildCommand } from "./buildx.js";

/** Triggers that run on ordinary development activity (as opposed to scheduled or manual rebuilds). */
const DEVELOPMENT_TRIGGERS = ["pull_request", "pull_request_target", "merge_group"];
const REBUILD_CONDITION = /schedule|workflow_dispatch|release|refs\/tags/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `on: push` restricted to tags (a release build, where a clean rebuild is a deliberate choice). */
function tagOnlyPush(workflow: WorkflowModel): boolean {
  const source = workflow.source;
  const on = field(source, source.doc.contents, "on")?.value;
  const push = toJS(source, field(source, on, "push")?.value ?? null);
  return isRecord(push) && ("tags" in push || "tags-ignore" in push) && !("branches" in push) && !("branches-ignore" in push);
}

function runsOnDevelopmentActivity(workflow: WorkflowModel): boolean {
  if (workflow.kind !== "workflow") return false;
  if (hasTrigger(workflow, ...DEVELOPMENT_TRIGGERS)) return true;
  return trigger(workflow, "push") !== undefined && !tagOnlyPush(workflow);
}

/** `docker compose build --no-cache` / `docker-compose build --no-cache`. */
function composeNoCache(words: string[]): boolean {
  const compose = words[0] === "docker-compose" ? 1 : words[0] === "docker" && words[1] === "compose" ? 2 : -1;
  if (compose < 0) return false;
  const end = words.findIndex((word) => /^(\||\d?>>?|<|&)/.test(word));
  const command = end < 0 ? words : words.slice(0, end);
  const build = command.indexOf("build", compose);
  return build >= 0 && command.slice(build + 1).some((word) => word === "--no-cache" || word === "--no-cache=true");
}

/**
 * A self-hosted job whose builds keep their layer cache between runs: the Docker daemon's own builder, or a
 * setup-buildx-action builder kept alive (`driver: docker`, `cleanup: false` or `keep-state: true`). GitHub-hosted jobs
 * start on a fresh VM, and setup-buildx-action removes its builder at the end of the job by default.
 */
function persistentBuilder(job: JobModel): boolean {
  if (!jobRunsOnLabels(job).some((label) => label.trim().toLowerCase() === "self-hosted")) return false;
  const setup = job.steps.find((step) => usesAction(step, "docker/setup-buildx-action"));
  if (!setup) return true;
  return (
    literalWith(setup, "driver") === "docker" ||
    isFalse(literalWith(setup, "cleanup")) ||
    isTrue(literalWith(setup, "keep-state"))
  );
}

/** The `cache-from` sources of a build-push-action step, formatted for a message (an expression is kept verbatim). */
function buildPushCacheImports(step: StepModel): string[] {
  const entry = step.with.get("cache-from");
  if (entry?.kind === "expression" && typeof entry.value === "string" && entry.value.trim() !== "") {
    return [`\`${entry.value.trim()}\``];
  }
  return cacheEntries(entry)
    .filter((item) => item.text.trim() !== "")
    .map((item) => `\`${item.text.trim()}\``);
}

/** What the flag throws away, for the message; undefined when there is no cache to lose. */
function discardedCache(imports: string[], persistent: boolean): string | undefined {
  if (imports.length > 0) return `discards the cache it imports (${imports.join(", ")})`;
  if (persistent) return "ignores the self-hosted runner's persistent layer cache";
  return undefined;
}

export default defineRule({
  meta: {
    id: "containers/docker-no-cache-build",
    ruleset: "containers",
    description:
      "Push and pull-request image builds should not pass --no-cache when they import a cache (cache-from) or run on a persistent self-hosted builder.",
    rationale:
      "`--no-cache` makes BuildKit ignore every cached layer, so each run re-executes all RUN instructions (package installs, dependency downloads, compiles) even when their inputs are unchanged. A GitHub-hosted job starts on a fresh VM with an empty builder, so the flag only costs time when the build imports a cache (`cache-from`) or runs on a persistent self-hosted builder; only those builds are reported. The usual motive, picking up fresh base images and security updates, is served by `--pull` (always re-resolve the base image) plus a scheduled no-cache rebuild, as Docker's best-practices guide recommends; `--no-cache-filter` rebuilds only the stages that must be fresh.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/build/building/best-practices/#rebuild-your-images-often",
      "https://docs.docker.com/reference/cli/docker/buildx/build/#no-cache-filter",
      "https://github.com/docker/build-push-action#inputs",
      "https://docs.github.com/en/actions/concepts/runners/github-hosted-runners",
    ],
    impact: "high",
    fixable: false,
    example: {
      bad: "on: pull_request\njobs:\n  image:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: docker buildx build --no-cache --cache-from type=gha --cache-to type=gha,mode=max -t app .",
      good: "on: pull_request\njobs:\n  image:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: docker buildx build --pull --cache-from type=gha --cache-to type=gha,mode=max -t app .\n# plus a weekly `on: schedule` workflow running `docker buildx build --pull --no-cache -t app .`",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (!runsOnDevelopmentActivity(workflow)) continue;
      const triggeredBy = workflow.triggers.map((item) => item.event).join("/");
      for (const job of workflow.jobs) {
        if (REBUILD_CONDITION.test(job.if ?? "")) continue;
        const persistent = persistentBuilder(job);
        for (const step of job.steps) {
          if (REBUILD_CONDITION.test(step.if ?? "")) continue;
          if (isBuildPush(step)) {
            const entry = step.with.get("no-cache");
            if (!entry || !isTrue(entry.value)) continue;
            const imports = buildPushCacheImports(step);
            const discarded = discardedCache(imports, persistent);
            if (!discarded) continue;
            report({
              path: workflow.path,
              line: entry.line,
              key: `${job.key}:${step.key}:no-cache`,
              message: `\`no-cache: true\` on docker/build-push-action in a workflow triggered by ${triggeredBy} ${discarded}: every run re-executes every RUN instruction, even when nothing it depends on changed.`,
              suggestion:
                "Keep the cache and refresh the base image instead:\n  with:\n    pull: true\nand rebuild from scratch on a schedule in a separate workflow:\non:\n  schedule:\n    - cron: \"0 4 * * 1\"\n...\n  with:\n    pull: true\n    no-cache: true\nTo force only one stage to rebuild, use `no-cache-filters: <stage>` instead of `no-cache: true`.",
              impact: "high",
              confidence: imports.length > 0 && step.with.get("cache-from")?.kind !== "expression" ? "high" : "medium",
            });
            continue;
          }
          for (const { command, line } of commandsOf(step)) {
            const build = parseBuildCommand(command);
            const words = commandWords(command);
            const noCache = build ? flagSet(build, "no-cache") : composeNoCache(words);
            if (!noCache) continue;
            const imports = (build?.flags.get("cache-from") ?? []).filter((value) => value !== "" && value !== "true").map((value) => `\`${value}\``);
            const discarded = discardedCache(imports, persistent);
            if (!discarded) continue;
            const invocation = build ? build.invocation : words[0] === "docker-compose" ? "docker-compose build" : "docker compose build";
            const pulled = command.replace(/\s--no-cache(=true)?(?=\s|$)/, /\s--pull(=true)?(?=\s|$)/.test(command) ? "" : " --pull");
            report({
              path: workflow.path,
              line,
              key: `${job.key}:${step.key}:no-cache:${line}`,
              message: `\`${invocation} --no-cache\` in a workflow triggered by ${triggeredBy} ${discarded}: every run re-executes every RUN instruction, even when nothing it depends on changed.`,
              suggestion: `Keep the cache and refresh the base image instead:\n${pulled}\nand run the full \`--no-cache\` rebuild from a scheduled workflow (\`on: schedule\`). To force only one stage to rebuild, use \`--no-cache-filter <stage>\`${build ? "" : " with `docker buildx build`"}.`,
              impact: "high",
              confidence: imports.length > 0 ? "high" : "medium",
            });
          }
        }
      }
    }
  },
});
