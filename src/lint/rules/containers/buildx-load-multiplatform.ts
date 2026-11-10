import type { JobModel } from "../../parsers/workflow.js";
import { isTrue, usesAction } from "../caching/shared.js";
import { defineRule, jobRunsOnLabels, stepLine } from "../helpers.js";
import { archOf, flagSet, isDynamic, jobBuilds, literalWith, parseCacheEntry, platformList, runnerArch, type BuildSite } from "./buildx.js";

/**
 * Labels historically shipping a classic store. Labels do not establish the daemon's current configuration.
 */
const CLASSIC_STORE_RUNNERS = new Set(["ubuntu-22.04", "ubuntu-24.04", "ubuntu-latest", "ubuntu-22.04-arm", "ubuntu-24.04-arm"]);

function classicStoreRunner(job: JobModel): string | undefined {
  if (!job.runsOn || job.runsOn.kind !== "literal") return undefined;
  const labels = jobRunsOnLabels(job).map((label) => label.trim().toLowerCase());
  return labels.length === 1 && CLASSIC_STORE_RUNNERS.has(labels[0] ?? "") ? labels[0] : undefined;
}

/** The job configures the daemon itself (setup-docker-action, containerd snapshotter) or runs in a container. */
function customDaemon(job: JobModel): boolean {
  if (job.containerImage || job.env.DOCKER_HOST !== undefined || job.env.DOCKER_CONTEXT !== undefined) return true;
  return job.steps.some(
    (step) => usesAction(step, "docker/setup-docker-action") ||
      step.env.DOCKER_HOST !== undefined || step.env.DOCKER_CONTEXT !== undefined ||
      /containerd-snapshotter|DOCKER_(HOST|CONTEXT)|docker\s+context\b/.test(step.run?.value ?? ""),
  );
}

/** `type=docker` exporter without `dest` (loads into the local image store). */
function loadsIntoDaemon(outputs: string[]): string | undefined {
  for (const output of outputs) {
    if (isDynamic(output)) continue;
    const entry = parseCacheEntry(output);
    if (entry.type === "docker" && !entry.attributes.has("dest")) return output;
  }
  return undefined;
}

interface Finding {
  platforms: string[];
  load: string;
  line: number;
}

function inspect(site: BuildSite): Finding | undefined {
  if (site.command) {
    const { build, line } = site.command;
    const raw = build.flags.get("platform") ?? [];
    if (raw.some(isDynamic)) return undefined;
    const platforms = [...new Set(raw.flatMap(platformList))];
    if (platforms.length < 2) return undefined;
    const output = loadsIntoDaemon(build.flags.get("output") ?? []);
    const load = flagSet(build, "load") ? "--load" : output !== undefined ? `--output ${output}` : undefined;
    return load ? { platforms, load, line } : undefined;
  }
  const { step } = site;
  const value = literalWith(step, "platforms");
  if (value === undefined) return undefined;
  const platforms = [...new Set(platformList(value))];
  if (platforms.length < 2) return undefined;
  const outputs = literalWith(step, "outputs");
  const output = outputs === undefined ? undefined : loadsIntoDaemon(outputs.split(/\r?\n/).map((output) => output.trim()));
  const loadEntry = step.with.get("load");
  const load = loadEntry && isTrue(loadEntry.value) ? "load: true" : output !== undefined ? `outputs: ${output}` : undefined;
  return load ? { platforms, load, line: step.with.get("platforms")?.line ?? stepLine(step) } : undefined;
}

export default defineRule({
  meta: {
    id: "containers/buildx-load-multiplatform",
    ruleset: "containers",
    description: "Multi-platform image builds must not be loaded into the classic Docker image store of a GitHub-hosted runner.",
    rationale:
      "The classic Docker image store cannot hold multi-platform images. Loading a multi-platform build therefore requires a compatible exporter and containerd image store, or a separate single-platform test build. Runner labels alone do not prove which store is enabled: hosted images change and workflows can address custom daemons. This is a compatibility check to verify, not a prediction that every such job fails.",
    kind: "insight",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.docker.com/reference/cli/docker/buildx/build/#load",
      "https://docs.docker.com/build/ci/github-actions/multi-platform/",
      "https://docs.docker.com/build/building/multi-platform/",
    ],
    impact: "high",
    fixable: false,
    example: {
      bad: "- uses: docker/build-push-action@v7\n  with:\n    platforms: linux/amd64,linux/arm64\n    load: true\n    tags: app:test",
      good: "- uses: docker/build-push-action@v7\n  with:\n    platforms: linux/amd64\n    load: true\n    tags: app:test",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        if (workflow.env.DOCKER_HOST !== undefined || workflow.env.DOCKER_CONTEXT !== undefined) continue;
        const runner = classicStoreRunner(job);
        if (runner === undefined || customDaemon(job)) continue;
        const native = runnerArch(job) === "arm64" ? "linux/arm64" : "linux/amd64";
        for (const site of jobBuilds(workflow, job)) {
          const finding = inspect(site);
          if (!finding) continue;
          const nativeBuild = finding.platforms.find((platform) => archOf(platform) === archOf(native)) ?? native;
          const others = finding.platforms.join(",");
          const snippet = site.command
            ? [
                `${site.command.build.invocation} --platform ${nativeBuild} --load -t app:test .`,
                `${site.command.build.invocation} --platform ${others} --push -t <registry>/<image>:<tag> .`,
              ].join("\n")
            : [
                "- uses: docker/build-push-action@v7",
                "  with:",
                `    platforms: ${nativeBuild}`,
                "    load: true",
                "    tags: app:test",
                "# ... test the image, then build and push every platform:",
                "- uses: docker/build-push-action@v7",
                "  with:",
                `    platforms: ${others}`,
                "    push: true",
              ].join("\n");
          report({
            path: workflow.path,
            line: finding.line,
            key: `${job.key}:${site.step.key}:load-multiplatform:${finding.line}`,
            message: `\`${finding.load}\` with ${finding.platforms.length} platforms (\`${others}\`) on \`${runner}\` requires a multi-platform-compatible Docker image store/exporter. If the daemon still uses the classic image store, loading fails; verify the actual daemon rather than inferring it from the runner label.`,
            suggestion: `Load only the native platform for testing and push the multi-platform image separately:\n${snippet}\nOr enable the containerd image store before building:\n- uses: docker/setup-docker-action@v5\n  with:\n    daemon-config: |\n      {"features": {"containerd-snapshotter": true}}`,
            impact: "high",
            confidence: "medium",
          });
        }
      }
    }
  },
});
