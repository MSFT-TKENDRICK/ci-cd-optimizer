import { defineRule } from "../helpers.js";
import { gradleBuilds, invocationSets, undecidedBuild, related, buildMentions } from "./gradle.js";

const PROPERTY = "org.gradle.parallel";

function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

/** Distinct project paths passed to `include` in a settings script (literal string arguments only). */
export function includedProjects(settings: string): Set<string> {
  const content = stripComments(settings);
  const result = new Set<string>();
  const add = (args: string): void => {
    for (const match of args.matchAll(/["']([^"'\n]+)["']/g)) result.add((match[1] ?? "").replace(/^:/, ""));
  };
  for (const match of content.matchAll(/(?<![\w.])include\s*\(([^)]*)\)/g)) add(match[1] ?? "");
  for (const match of content.matchAll(/(?<![\w.])include\s+((?:["'][^"'\n]+["']\s*,\s*)*["'][^"'\n]+["'])/g)) add(match[1] ?? "");
  return result;
}

export default defineRule({
  meta: {
    id: "toolchains/gradle-parallel-disabled",
    ruleset: "toolchains",
    description: "Multi-project Gradle builds run in CI could execute independent subprojects in parallel with `org.gradle.parallel=true`.",
    rationale:
      "Enabling parallel project execution can overlap independent subproject tasks, subject to task dependencies, worker limits and shared-resource constraints. Other concurrency, including worker APIs or configuration-cache task execution, may already exist. Source-level include declarations do not establish an independent runtime task graph. Measure representative builds and validate shared mutable state before changing scheduling.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://docs.gradle.org/current/userguide/performance.html#sec:enable_parallel_execution",
      "https://docs.gradle.org/current/userguide/build_environment.html#sec:gradle_configuration_properties",
    ],
    impact: "medium",
    fixable: false,
    example: {
      bad: '# settings.gradle.kts\ninclude(":app", ":core", ":data")\n\n# gradle.properties\norg.gradle.caching=true',
      good: '# settings.gradle.kts\ninclude(":app", ":core", ":data")\n\n# gradle.properties\norg.gradle.caching=true\norg.gradle.parallel=true',
    },
  },
  check({ project, report }) {
    for (const candidate of gradleBuilds(project)) {
      const build = undecidedBuild(project, candidate, [PROPERTY], ["--parallel", "--no-parallel"]);
      if (!build) continue;
      if (!build.settings || !build.properties) continue;
      const projects = includedProjects(build.settings.content);
      if (projects.size < 2) continue;
      // The configuration cache already runs tasks in parallel, and a worker limit signals deliberate tuning.
      if (build.values.get("org.gradle.configuration-cache")?.value === "true") continue;
      build.invocations = build.invocations.filter((invocation) =>
        !invocationSets({ ...build, invocations: [invocation] }, ["--configuration-cache", "--max-workers"], ["org.gradle.configuration-cache", "org.gradle.workers.max"]) &&
        !invocation.options.some((option) => option.startsWith("--max-workers=")),
      );
      if (build.values.has("org.gradle.workers.max") || buildMentions(build, "org.gradle.workers.max")) continue;
      const first = build.invocations[0];
      if (!first) continue;
      const where = build.root === "" ? "the root Gradle build" : `the Gradle build in \`${build.root}/\``;
      const names = [...projects].slice(0, 3).map((name) => `\`${name}\``).join(", ");
      report({
        path: first.command.path,
        line: first.command.line,
        key: `gradle-root:${build.root}:${first.ctx.job.id}`,
        message: `${where[0]?.toUpperCase() ?? ""}${where.slice(1)} includes ${projects.size} subprojects (${names}${projects.size > 3 ? ", …" : ""}) but does not enable parallel project execution in the inspected configuration: \`${build.propertiesPath}\` does not set \`${PROPERTY}=true\` and \`${first.command.command.trim()}\` does not pass \`--parallel\`.`,
        suggestion: `Add this line to \`${build.propertiesPath}\`:\n\n${PROPERTY}=true\n\nTasks of independent subprojects then run concurrently. Tasks that share mutable state (for example a fixed port or output file used by two subprojects) must declare it, for instance through a shared build service, before parallel execution is safe.`,
        confidence: "medium",
        related: [{ path: build.settings.path, line: 1 }, ...related(build)],
      });
    }
  },
});
