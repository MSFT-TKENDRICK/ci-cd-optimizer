import rule from "../../../../src/lint/rules/toolchains/gradle-parallel-disabled.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const job = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", "      - uses: actions/checkout@v5", ...steps);
const WORKFLOW = ".github/workflows/ci.yml";
const MULTI = 'rootProject.name = "demo"\ninclude(":app", ":core", ":data")\n';

ruleTester(rule, {
  valid: [
    {
      name: "parallel enabled",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build"),
        "settings.gradle.kts": MULTI,
        "gradle.properties": "org.gradle.caching=true\norg.gradle.parallel=true\n",
      },
    },
    {
      name: "--parallel on the command line",
      files: { [WORKFLOW]: job("      - run: ./gradlew build --parallel"), "settings.gradle.kts": MULTI, "gradle.properties": "org.gradle.caching=true\n" },
    },
    {
      name: "trap: single-project build",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build"),
        "settings.gradle.kts": 'rootProject.name = "demo"\ninclude(":app")\n',
        "gradle.properties": "org.gradle.caching=true\n",
      },
    },
    {
      name: "trap: commented-out includes do not count",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build"),
        "settings.gradle.kts": 'include(":app")\n// include(":legacy")\n/* include(":old") */\n',
        "gradle.properties": "org.gradle.caching=true\n",
      },
    },
    {
      name: "trap: configuration cache already runs tasks in parallel",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build"),
        "settings.gradle.kts": MULTI,
        "gradle.properties": "org.gradle.configuration-cache=true\n",
      },
    },
    {
      name: "trap: deliberate worker limit",
      files: { [WORKFLOW]: job("      - run: ./gradlew build --max-workers=2"), "settings.gradle.kts": MULTI, "gradle.properties": "org.gradle.caching=true\n" },
    },
    {
      name: "trap: explicitly disabled",
      files: { [WORKFLOW]: job("      - run: ./gradlew build"), "settings.gradle.kts": MULTI, "gradle.properties": "org.gradle.parallel=false\n" },
    },
  ],
  invalid: [
    {
      name: "Kotlin DSL multi-project build",
      files: { [WORKFLOW]: job("      - run: ./gradlew build"), "settings.gradle.kts": MULTI, "gradle.properties": "org.gradle.caching=true\n" },
      errors: [{ line: 7, path: WORKFLOW, messageIncludes: "The root Gradle build includes 3 subprojects (`app`, `core`, `data`)" }],
      output: null,
    },
    {
      name: "Groovy DSL include without parentheses",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew check"),
        "settings.gradle": "rootProject.name = 'demo'\ninclude ':api', ':impl'\n",
        "gradle.properties": "org.gradle.jvmargs=-Xmx2g",
      },
      errors: [{ line: 7, messageIncludes: "does not set `org.gradle.parallel=true` and `./gradlew check` does not pass `--parallel`" }],
      output: null,
    },
    {
      name: "separate include statements",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew test"),
        "settings.gradle.kts": 'include(":a")\ninclude(":b")\n',
        "gradle.properties": "org.gradle.caching=true\n",
      },
      errors: [{ line: 7, messageIncludes: "includes 2 subprojects" }],
      output: null,
    },
  ],
});
