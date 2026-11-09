import { fix } from "../../fix.js";
import { defineRule } from "../helpers.js";
import { gradleBuilds, propertyDecided, related } from "./gradle.js";
import { appendLines } from "./shared.js";

const PROPERTY = "org.gradle.caching";

export default defineRule({
  meta: {
    id: "toolchains/gradle-build-cache-disabled",
    ruleset: "toolchains",
    description: "Gradle builds run in CI should enable the build cache with `org.gradle.caching=true`.",
    rationale:
      "Gradle's build cache is off unless `org.gradle.caching=true` is set or `--build-cache` is passed. While it is off, every cacheable task (compilation, tests, code generation) executes on every run even when its inputs are unchanged. With it on, task outputs are stored in the local build cache under the Gradle user home (`caches/build-cache-1`), which gradle/actions/setup-gradle and actions/setup-java `cache: gradle` save and restore between runs, so unchanged tasks are loaded from cache instead of re-executed.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.gradle.org/current/userguide/build_cache.html#sec:build_cache_enable",
      "https://docs.gradle.org/current/userguide/build_environment.html#sec:gradle_configuration_properties",
      "https://github.com/gradle/actions/blob/main/docs/setup-gradle.md#caching-build-state-between-jobs",
    ],
    impact: "high",
    fixable: true,
    example: {
      bad: "# gradle.properties\norg.gradle.jvmargs=-Xmx2g\n\n# workflow\n- run: ./gradlew build",
      good: "# gradle.properties\norg.gradle.jvmargs=-Xmx2g\norg.gradle.caching=true\n\n# workflow\n- run: ./gradlew build",
    },
  },
  check({ project, input, report }) {
    for (const build of gradleBuilds(project)) {
      if (propertyDecided(project, build, [PROPERTY], ["--build-cache", "--no-build-cache"])) continue;
      if (build.settings && /[bB]uildCacheEnabled\b/.test(build.settings.content)) continue;
      if (!build.properties && !input.inventoryComplete) continue;
      const first = build.invocations[0];
      if (!first) continue;
      const where = build.root === "" ? "the root Gradle build" : `the Gradle build in \`${build.root}/\``;
      const command = first.command.command.trim();
      const repair = build.properties ? fix(`Add ${PROPERTY}=true to ${build.propertiesPath}`, appendLines(build.properties, [`${PROPERTY}=true`])) : undefined;
      report({
        path: first.command.path,
        line: first.command.line,
        key: `gradle-root:${build.root}`,
        message: `The Gradle build cache is off for ${where}: ${build.properties ? `\`${build.propertiesPath}\` does not set \`${PROPERTY}=true\`` : `there is no \`${build.propertiesPath}\` setting \`${PROPERTY}=true\``} and \`${command}\` does not pass \`--build-cache\`, so every cacheable task re-executes on every CI run.`,
        suggestion: `${build.properties ? `Add this line to \`${build.propertiesPath}\`` : `Create \`${build.propertiesPath}\` containing`}:\n\n${PROPERTY}=true\n\nThis enables the build cache for local and CI builds alike; gradle/actions/setup-gradle then saves the local build cache with the Gradle user home so unchanged task outputs are reused across runs. Only cacheable tasks are stored; a custom task with under-declared inputs can be marked non-cacheable (see "Marking tasks as non-cacheable by default" in the build cache guide).`,
        related: related(build),
        ...(repair ? { fix: repair } : {}),
      });
    }
  },
});
