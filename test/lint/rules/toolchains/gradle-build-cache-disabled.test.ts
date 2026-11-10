import rule from "../../../../src/lint/rules/toolchains/gradle-build-cache-disabled.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const job = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", "      - uses: actions/checkout@v5", ...steps);
const WORKFLOW = ".github/workflows/ci.yml";
const SETTINGS = 'rootProject.name = "demo"\n';

ruleTester(rule, {
  valid: [
    {
      name: "build cache enabled in gradle.properties",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build"),
        "settings.gradle.kts": SETTINGS,
        "gradle.properties": "org.gradle.jvmargs=-Xmx2g\norg.gradle.caching=true\n",
      },
    },
    {
      name: "--build-cache passed on the command line",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build --build-cache"),
        "settings.gradle.kts": SETTINGS,
        "gradle.properties": "org.gradle.jvmargs=-Xmx2g\n",
      },
    },
    {
      name: "trap: explicitly disabled build cache is a deliberate choice",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build"),
        "settings.gradle.kts": SETTINGS,
        "gradle.properties": "org.gradle.caching=false\n",
      },
    },
    {
      name: "trap: help-only invocations do not run tasks",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew --version", "      - run: ./gradlew dependencies"),
        "settings.gradle.kts": SETTINGS,
        "gradle.properties": "org.gradle.jvmargs=-Xmx2g\n",
      },
    },
    {
      name: "trap: property set through GRADLE_OPTS in the workflow",
      files: {
        [WORKFLOW]: yml(
          "on: push",
          "env:",
          "  GRADLE_OPTS: -Dorg.gradle.caching=true",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - run: ./gradlew build",
        ),
        "settings.gradle.kts": SETTINGS,
        "gradle.properties": "org.gradle.jvmargs=-Xmx2g\n",
      },
    },
    {
      name: "trap: no Gradle build files in the repository",
      files: { [WORKFLOW]: job("      - run: ./gradlew build") },
    },
    {
      name: "trap: missing gradle.properties with an incomplete inventory",
      files: { [WORKFLOW]: job("      - run: ./gradlew build"), "settings.gradle.kts": SETTINGS },
      inventoryComplete: false,
    },
  ],
  invalid: [
    {
      name: "gradle.properties without org.gradle.caching",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build"),
        "settings.gradle.kts": SETTINGS,
        "gradle.properties": "org.gradle.jvmargs=-Xmx2g\n",
      },
      errors: [{ line: 7, path: WORKFLOW, messageIncludes: "`gradle.properties` does not set `org.gradle.caching=true`" }],
      output: null,
    },
    {
      name: "gradle.properties without a trailing newline",
      files: {
        [WORKFLOW]: job("      - run: gradle test"),
        "build.gradle": "plugins { id 'java' }\n",
        "gradle.properties": "org.gradle.jvmargs=-Xmx2g",
      },
      errors: [{ line: 7, messageIncludes: "`gradle test` does not pass `--build-cache`" }],
      output: null,
    },
    {
      name: "no gradle.properties at all (suggestion only)",
      files: { [WORKFLOW]: job("      - run: ./gradlew build"), "settings.gradle": "rootProject.name = 'demo'\n" },
      errors: [{ line: 7, messageIncludes: "there is no `gradle.properties` setting `org.gradle.caching=true`" }],
    },
    {
      name: "nested build run through working-directory",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew assembleDebug", "        working-directory: android"),
        "android/settings.gradle.kts": SETTINGS,
        "android/gradle.properties": "android.useAndroidX=true\n",
      },
      errors: [{ line: 7, messageIncludes: "the Gradle build in `android/`" }],
      output: null,
    },
    {
      name: "one report per build even with several invocations",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew assemble", "      - run: ./gradlew check"),
        "settings.gradle.kts": SETTINGS,
        "gradle.properties": "org.gradle.jvmargs=-Xmx2g\n",
      },
      errors: [{ line: 7, messageIncludes: "`./gradlew assemble`" }],
    },
  ],
});
