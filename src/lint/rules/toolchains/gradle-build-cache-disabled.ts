import { defineRule } from "../helpers.js";
import { gradleBuilds, undecidedBuild, related } from "./gradle.js";

const PROPERTY = "org.gradle.caching";

export default defineRule({
  meta: {
    id: "toolchains/gradle-build-cache-disabled",
    ruleset: "toolchains",
    description: "Gradle builds run in CI should enable the build cache with `org.gradle.caching=true`.",
    rationale:
      "Gradle's build cache is opt-in. It can reuse eligible task outputs when matching cache entries are available; ordinary up-to-date checks and existing outputs can still avoid work without it. Reuse across ephemeral runners requires cache persistence or a remote cache. Custom tasks must declare their inputs correctly before caching is safe. This detector only sees repository configuration and workflow invocations, not user-home properties, external init scripts or runtime cache hits.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://docs.gradle.org/current/userguide/build_cache.html#sec:build_cache_enable",
      "https://docs.gradle.org/current/userguide/build_environment.html#sec:gradle_configuration_properties",
      "https://github.com/gradle/actions/blob/main/docs/setup-gradle.md#caching-build-state-between-jobs",
    ],
    impact: "high",
    fixable: false,
    example: {
      bad: "# gradle.properties\norg.gradle.jvmargs=-Xmx2g\n\n# workflow\n- run: ./gradlew build",
      good: "# gradle.properties\norg.gradle.jvmargs=-Xmx2g\norg.gradle.caching=true\n\n# workflow\n- run: ./gradlew build",
    },
  },
  check({ project, report }) {
    for (const candidate of gradleBuilds(project)) {
      const build = undecidedBuild(project, candidate, [PROPERTY], ["--build-cache", "--no-build-cache"]);
      if (!build) continue;
      if (build.settings && /[bB]uildCacheEnabled\b/.test(build.settings.content)) continue;
      const first = build.invocations[0];
      if (!first) continue;
      const where = build.root === "" ? "the root Gradle build" : `the Gradle build in \`${build.root}/\``;
      const command = first.command.command.trim();
      report({
        path: first.command.path,
        line: first.command.line,
        key: `gradle-root:${build.root}:${first.ctx.job.id}`,
        message: `The inspected configuration does not enable the Gradle build cache for ${where}: ${build.properties ? `\`${build.propertiesPath}\` does not set \`${PROPERTY}=true\`` : `there is no \`${build.propertiesPath}\` setting \`${PROPERTY}=true\``} and \`${command}\` does not pass \`--build-cache\`. On a fresh runner without external configuration, eligible task outputs cannot be reused from the build cache.`,
        suggestion: `After validating task input declarations, compare a trial with \`--build-cache\`. If it helps, consider \`${PROPERTY}=true\` in \`${build.propertiesPath}\` and an appropriate persistence policy. setup-gradle may persist the user-home cache depending on its configuration and access policy; hits are not guaranteed. Keep tasks with incomplete input declarations non-cacheable.`,
        confidence: "medium",
        related: related(build),
      });
    }
  },
});
