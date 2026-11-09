import { fix } from "../../fix.js";
import type { ProjectModel } from "../../project.js";
import { defineRule } from "../helpers.js";
import { gradleBuilds, propertyDecided, related, type GradleBuild } from "./gradle.js";
import { appendLines, inDir, parseProperties } from "./shared.js";

const PROPERTY = "org.gradle.configuration-cache";

/** Gradle version from the wrapper's `distributionUrl` (for example `gradle-8.10.2-bin.zip`). */
function wrapperVersion(project: ProjectModel, build: GradleBuild): [number, number] | undefined {
  const file = project.files.get(inDir(build.root, "gradle/wrapper/gradle-wrapper.properties"));
  if (!file) return undefined;
  const url = parseProperties(file.content).get("distributionUrl")?.value;
  const match = url ? /gradle-(\d+)\.(\d+)/.exec(url) : null;
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

export default defineRule({
  meta: {
    id: "toolchains/gradle-configuration-cache-disabled",
    ruleset: "toolchains",
    description: "Gradle 8.1+ builds run in CI could enable the configuration cache with `org.gradle.configuration-cache=true`.",
    rationale:
      "Without the configuration cache, every Gradle invocation re-runs the configuration phase, and tasks of the same project cannot run in parallel because they share the Project instance. With `org.gradle.configuration-cache=true`, Gradle serializes the configured task graph: tasks then run in parallel even within one project, and later invocations with the same tasks and inputs (for example another `./gradlew` step in the same job, or entries restored by setup-gradle) skip configuration. It defaults to false and became stable in Gradle 8.1. Builds or plugins that are not compatible report configuration cache problems, so adoption needs a trial run.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.gradle.org/current/userguide/configuration_cache.html",
      "https://docs.gradle.org/current/userguide/build_environment.html#sec:gradle_configuration_properties",
      "https://docs.gradle.org/8.1/release-notes.html",
      "https://github.com/gradle/actions/blob/main/docs/setup-gradle.md#cache-encryption-key",
    ],
    impact: "medium",
    fixable: true,
    example: {
      bad: "# gradle.properties\norg.gradle.caching=true\n\n# workflow\n- run: ./gradlew build",
      good: "# gradle.properties\norg.gradle.caching=true\norg.gradle.configuration-cache=true\n\n# workflow\n- run: ./gradlew build",
    },
  },
  check({ project, report }) {
    for (const build of gradleBuilds(project)) {
      if (!build.properties) continue;
      if (!build.invocations.every((invocation) => invocation.executable.startsWith("gradlew"))) continue;
      const version = wrapperVersion(project, build);
      if (!version || version[0] < 8 || (version[0] === 8 && version[1] < 1)) continue;
      const properties = [PROPERTY, "org.gradle.unsafe.configuration-cache"];
      if (propertyDecided(project, build, properties, ["--configuration-cache", "--no-configuration-cache"])) continue;
      const first = build.invocations[0];
      if (!first) continue;
      const where = build.root === "" ? "the root Gradle build" : `the Gradle build in \`${build.root}/\``;
      report({
        path: first.command.path,
        line: first.command.line,
        key: `gradle-root:${build.root}`,
        message: `The configuration cache is not enabled for ${where} (Gradle ${version.join(".")}): \`${build.propertiesPath}\` does not set \`${PROPERTY}\` and         \`${first.command.command.trim()}\` does not pass \`--configuration-cache\`, so tasks of the same project do not run in parallel and every invocation re-runs the configuration phase. Some plugins are not compatible yet; verify with \`./gradlew --configuration-cache <tasks>\` before enabling it.`,
                suggestion: `Run the CI tasks once with \`--configuration-cache\` and fix or report any configuration cache problems, then add this line to \`${build.propertiesPath}\`:\n\n${PROPERTY}=true\n\nDo not use \`org.gradle.configuration-cache.problems=warn\` as an adoption shortcut. Ephemeral runners start without configuration cache entries; gradle/actions/setup-gradle encrypts the entries it stores in the GitHub Actions cache with the \`cache-encryption-key\` input (\`cache-encryption-key: \${{ secrets.GRADLE_ENCRYPTION_KEY }}\`, a key from \`openssl rand -base64 16\`).`,
        confidence: "medium",
        related: related(build),
        fix: fix(`Add ${PROPERTY}=true to ${build.propertiesPath}`, appendLines(build.properties, [`${PROPERTY}=true`])),
      });
    }
  },
});
