import rule from "../../../../src/lint/rules/toolchains/gradle-configuration-cache-disabled.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const job = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-24.04", "    steps:", "      - uses: actions/checkout@v5", ...steps);
const WORKFLOW = ".github/workflows/ci.yml";
const SETTINGS = 'rootProject.name = "demo"\n';
const wrapper = (version: string): string =>
  `distributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-bin.zip\n`;
const WRAPPER = "gradle/wrapper/gradle-wrapper.properties";

ruleTester(rule, {
  valid: [
    {
      name: "configuration cache enabled",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build"),
        "settings.gradle.kts": SETTINGS,
        "gradle.properties": "org.gradle.caching=true\norg.gradle.configuration-cache=true\n",
        [WRAPPER]: wrapper("8.10.2"),
      },
    },
    {
      name: "--configuration-cache on the command line",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build --configuration-cache"),
        "settings.gradle.kts": SETTINGS,
        "gradle.properties": "org.gradle.caching=true\n",
        [WRAPPER]: wrapper("8.10.2"),
      },
    },
    {
      name: "trap: explicitly disabled (known incompatibility)",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build"),
        "settings.gradle.kts": SETTINGS,
        "gradle.properties": "org.gradle.configuration-cache=false\n",
        [WRAPPER]: wrapper("8.10.2"),
      },
    },
    {
      name: "trap: legacy unsafe property already set",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build"),
        "settings.gradle.kts": SETTINGS,
        "gradle.properties": "org.gradle.unsafe.configuration-cache=true\n",
        [WRAPPER]: wrapper("8.10.2"),
      },
    },
    {
      name: "trap: Gradle 8.0 predates the stable configuration cache",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build"),
        "settings.gradle.kts": SETTINGS,
        "gradle.properties": "org.gradle.caching=true\n",
        [WRAPPER]: wrapper("8.0.2"),
      },
    },
    {
      name: "trap: unknown Gradle version (no wrapper, system gradle)",
      files: {
        [WORKFLOW]: job("      - run: gradle build"),
        "settings.gradle.kts": SETTINGS,
        "gradle.properties": "org.gradle.caching=true\n",
      },
    },
    {
      name: "trap: no gradle.properties to append to",
      files: { [WORKFLOW]: job("      - run: ./gradlew build"), "settings.gradle.kts": SETTINGS, [WRAPPER]: wrapper("8.10.2") },
    },
  ],
  invalid: [
    {
      name: "Gradle 8.10 build without the configuration cache",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build"),
        "settings.gradle.kts": SETTINGS,
        "gradle.properties": "org.gradle.caching=true\n",
        [WRAPPER]: wrapper("8.10.2"),
      },
      errors: [{ line: 7, path: WORKFLOW, messageIncludes: "(Gradle 8.10): `gradle.properties` does not set `org.gradle.configuration-cache`" }],
      output: null,
    },
    {
      name: "Gradle 9 build, message carries the plugin-compatibility caveat",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew test --build-cache"),
        "settings.gradle": "rootProject.name = 'demo'\n",
        "gradle.properties": "org.gradle.jvmargs=-Xmx2g",
        [WRAPPER]: wrapper("9.1.0"),
      },
      errors: [{ line: 7, messageIncludes: "The inspected configuration does not enable the configuration cache for the root Gradle build (Gradle 9.1): `gradle.properties` does not set `org.gradle.configuration-cache` and `./gradlew test --build-cache` does not pass `--configuration-cache`. Without external configuration, each invocation repeats configuration. Plugin compatibility and task isolation must be tested before opting in." }],
      output: null,
    },
    {
      name: "nested build",
      files: {
        [WORKFLOW]: job("      - run: ./gradlew build", "        working-directory: backend"),
        "backend/settings.gradle.kts": SETTINGS,
        "backend/gradle.properties": "org.gradle.caching=true\n",
        "backend/gradle/wrapper/gradle-wrapper.properties": wrapper("8.14.3"),
      },
      errors: [{ line: 7, messageIncludes: "the Gradle build in `backend/`" }],
      output: null,
    },
  ],
});
