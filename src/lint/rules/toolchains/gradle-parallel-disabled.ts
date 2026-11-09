import { fix } from "../../fix.js";
import { defineRule } from "../helpers.js";
import { gradleBuilds, invocationSets, propertyDecided, related, workflowsMention } from "./gradle.js";
import { appendLines } from "./shared.js";

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
      "By default Gradle runs only one task at a time, even when the build has independent subprojects. `org.gradle.parallel=true` (or `--parallel`) lets Gradle execute tasks of different subprojects in parallel, up to `org.gradle.workers.max` workers, which defaults to the number of processors. The gain depends on how independent the subprojects are: a build dominated by one subproject or a long dependency chain gains little.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.gradle.org/current/userguide/performance.html#sec:enable_parallel_execution",
      "https://docs.gradle.org/current/userguide/build_environment.html#sec:gradle_configuration_properties",
    ],
    impact: "medium",
    fixable: true,
    example: {
      bad: '# settings.gradle.kts\ninclude(":app", ":core", ":data")\n\n# gradle.properties\norg.gradle.caching=true',
      good: '# settings.gradle.kts\ninclude(":app", ":core", ":data")\n\n# gradle.properties\norg.gradle.caching=true\norg.gradle.parallel=true',
    },
  },
  check({ project, report }) {
    for (const build of gradleBuilds(project)) {
      if (!build.settings || !build.properties) continue;
      const projects = includedProjects(build.settings.content);
      if (projects.size < 2) continue;
      if (propertyDecided(project, build, [PROPERTY], ["--parallel", "--no-parallel"])) continue;
      // The configuration cache already runs tasks in parallel, and a worker limit signals deliberate tuning.
      if (build.values.get("org.gradle.configuration-cache")?.value === "true") continue;
      if (invocationSets(build, ["--configuration-cache", "--max-workers"], ["org.gradle.configuration-cache", "org.gradle.workers.max"])) continue;
      if (build.invocations.some((invocation) => invocation.options.some((option) => option.startsWith("--max-workers=")))) continue;
      if (build.values.has("org.gradle.workers.max") || workflowsMention(project, "org.gradle.workers.max")) continue;
      const first = build.invocations[0];
      if (!first) continue;
      const where = build.root === "" ? "the root Gradle build" : `the Gradle build in \`${build.root}/\``;
      const names = [...projects].slice(0, 3).map((name) => `\`${name}\``).join(", ");
      report({
        path: first.command.path,
        line: first.command.line,
        key: `gradle-root:${build.root}`,
        message: `${where[0]?.toUpperCase() ?? ""}${where.slice(1)} includes ${projects.size} subprojects (${names}${projects.size > 3 ? ", …" : ""}) but runs one task at a time: \`${build.propertiesPath}\` does not set \`${PROPERTY}=true\` and \`${first.command.command.trim()}\` does not pass \`--parallel\`.`,
        suggestion: `Add this line to \`${build.propertiesPath}\`:\n\n${PROPERTY}=true\n\nTasks of independent subprojects then run concurrently. Tasks that share mutable state (for example a fixed port or output file used by two subprojects) must declare it, for instance through a shared build service, before parallel execution is safe.`,
        confidence: "medium",
        related: [{ path: build.settings.path, line: 1 }, ...related(build)],
        fix: fix(`Add ${PROPERTY}=true to ${build.propertiesPath}`, appendLines(build.properties, [`${PROPERTY}=true`])),
      });
    }
  },
});
