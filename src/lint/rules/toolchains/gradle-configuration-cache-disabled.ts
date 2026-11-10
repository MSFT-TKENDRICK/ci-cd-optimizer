import type { ProjectModel } from "../../project.js";
import { defineRule } from "../helpers.js";
import { gradleBuilds, undecidedBuild, related, type GradleBuild } from "./gradle.js";
import { inDir, parseProperties } from "./shared.js";

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
      "A compatible configuration-cache entry can avoid repeating configuration for matching tasks and inputs and allow more task concurrency. Entry availability, worker limits, task dependencies and plugin compatibility determine the benefit. The cache became stable in Gradle 8.1; this detector sees repository properties and explicit invocation options, not all user-home/init-script configuration. Validate isolation, secret handling and persistence before opting in.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://docs.gradle.org/current/userguide/configuration_cache.html",
      "https://docs.gradle.org/current/userguide/build_environment.html#sec:gradle_configuration_properties",
      "https://docs.gradle.org/8.1/release-notes.html",
      "https://github.com/gradle/actions/blob/main/docs/setup-gradle.md#cache-encryption-key",
    ],
    impact: "medium",
    fixable: false,
    example: {
      bad: "# gradle.properties\norg.gradle.caching=true\n\n# workflow\n- run: ./gradlew build",
      good: "# gradle.properties\norg.gradle.caching=true\norg.gradle.configuration-cache=true\n\n# workflow\n- run: ./gradlew build",
    },
  },
  check({ project, report }) {
    for (const candidate of gradleBuilds(project)) {
      const properties = [PROPERTY, "org.gradle.unsafe.configuration-cache"];
      const build = undecidedBuild(project, candidate, properties, ["--configuration-cache", "--no-configuration-cache"]);
      if (!build) continue;
      if (!build.properties) continue;
      if (!build.invocations.every((invocation) => invocation.executable.startsWith("gradlew"))) continue;
      const version = wrapperVersion(project, build);
      if (!version || version[0] < 8 || version[0] > 9 || (version[0] === 8 && version[1] < 1)) continue;
      const first = build.invocations[0];
      if (!first) continue;
      const where = build.root === "" ? "the root Gradle build" : `the Gradle build in \`${build.root}/\``;
      report({
        path: first.command.path,
        line: first.command.line,
        key: `gradle-root:${build.root}:${first.ctx.job.id}`,
        message: `The inspected configuration does not enable the configuration cache for ${where} (Gradle ${version.join(".")}): \`${build.propertiesPath}\` does not set \`${PROPERTY}\` and \`${first.command.command.trim()}\` does not pass \`--configuration-cache\`. Without external configuration, each invocation repeats configuration. Plugin compatibility and task isolation must be tested before opting in.`,
        suggestion: `Run the CI tasks once with \`--configuration-cache\` and resolve any configuration cache problems, then consider adding this line to \`${build.propertiesPath}\`:\n\n${PROPERTY}=true\n\nDo not use \`org.gradle.configuration-cache.problems=warn\` as an adoption shortcut. Ephemeral runners start without entries; gradle/actions/setup-gradle requires a \`cache-encryption-key\` to persist them securely. This changes execution behavior and requires validation, not an unattended edit.`,
        confidence: "medium",
        related: related(build),
      });
    }
  },
});
