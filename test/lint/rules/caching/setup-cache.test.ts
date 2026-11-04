import rule from "../../../../src/lint/rules/caching/setup-cache.js";
import { ruleTester } from "../../rule-tester.js";

const HEAD = "on: push\njobs:\n  b:\n    runs-on: ubuntu-24.04\n    steps:\n";
const wf = (body: string) => HEAD + body;
const NPM = { "package-lock.json": "{}", "package.json": '{"name":"x"}' };
const NODE = "      - uses: actions/setup-node@v7\n        with:\n          node-version: 22\n";
const SHA = "1d0ff469b7ec7b3cb9d8673fde0c81c44821de2a";

ruleTester(rule, {
  valid: [
    { name: "npm cache enabled", files: { ".github/workflows/ci.yml": wf(NODE.replace("node-version", "cache: npm\n          node-version")), ...NPM } },
    { name: "no lockfile", files: wf(NODE) },
    {
      name: "setup-node v6+ auto-caches npm when packageManager names npm",
      files: { ".github/workflows/ci.yml": wf(NODE), "package-lock.json": "{}", "package.json": '{"packageManager":"npm@11.2.0"}' },
    },
    {
      name: "devEngines.packageManager also enables auto-caching",
      files: { ".github/workflows/ci.yml": wf(NODE), "package-lock.json": "{}", "package.json": '{"devEngines":{"packageManager":{"name":"npm"}}}' },
    },
    {
      name: "SHA-pinned v6 with version comment auto-caches npm",
      files: {
        ".github/workflows/ci.yml": wf(`      - uses: actions/setup-node@${SHA} # v6.0.0\n`),
        "package-lock.json": "{}",
        "package.json": '{"packageManager":"npm@11.2.0"}',
      },
    },
    {
      name: "an actions/cache step already caches ~/.npm",
      files: {
        ".github/workflows/ci.yml": wf(`${NODE}      - uses: actions/cache@v6\n        with:\n          path: ~/.npm\n          key: npm-\${{ hashFiles('package-lock.json') }}\n`),
        ...NPM,
      },
    },
    {
      name: "package-manager-cache: false is a deliberate opt-out",
      files: { ".github/workflows/ci.yml": wf(`${NODE}          package-manager-cache: false\n`), ...NPM },
    },
    { name: "setup-go caches by default", files: { ".github/workflows/ci.yml": wf("      - uses: actions/setup-go@v7\n"), "go.mod": "module x\n" } },
    { name: "setup-python without dependency files", files: wf("      - uses: actions/setup-python@v7\n        with:\n          python-version: '3.13'\n") },
    {
      name: "uv projects using setup-uv",
      files: {
        ".github/workflows/ci.yml": wf("      - uses: astral-sh/setup-uv@v7\n      - uses: actions/setup-python@v7\n"),
        "uv.lock": "",
      },
    },
    {
      name: "gradle cached by setup-gradle",
      files: {
        ".github/workflows/ci.yml": wf("      - uses: actions/setup-java@v6\n        with:\n          distribution: temurin\n      - uses: gradle/actions/setup-gradle@v5\n"),
        "build.gradle.kts": "",
      },
    },
    { name: "maven cache set", files: { ".github/workflows/ci.yml": wf("      - uses: actions/setup-java@v6\n        with:\n          cache: maven\n"), "pom.xml": "" } },
    { name: "dotnet without lock files", files: { ".github/workflows/ci.yml": wf("      - uses: actions/setup-dotnet@v6\n"), "app.csproj": "" } },
  ],
  invalid: [
    {
      name: "setup-node without cache gets cache: npm",
      files: { ".github/workflows/ci.yml": wf(NODE), ...NPM },
      errors: [{ line: 6, messageIncludes: "does not cache npm dependencies" }],
      output: wf("      - uses: actions/setup-node@v7\n        with:\n          cache: npm\n          node-version: 22\n"),
    },
    {
      name: "setup-node v4 does not auto-cache even with packageManager npm",
      files: { ".github/workflows/ci.yml": wf(NODE.replace("@v7", "@v4")), "package-lock.json": "{}", "package.json": '{"packageManager":"npm@11.2.0"}' },
      errors: 1,
    },
    {
      name: "SHA-pinned v4 (comment) is flagged",
      files: {
        ".github/workflows/ci.yml": wf(`      - uses: actions/setup-node@${SHA} # v4.4.0\n`),
        "package-lock.json": "{}",
        "package.json": '{"packageManager":"npm@11.2.0"}',
      },
      errors: [{ line: 6 }],
    },
    {
      name: "pnpm installed first is fixable",
      files: {
        ".github/workflows/ci.yml": wf(`      - uses: pnpm/action-setup@v4\n${NODE}`),
        "pnpm-lock.yaml": "",
      },
      errors: [{ line: 7, messageIncludes: "pnpm" }],
      output: wf("      - uses: pnpm/action-setup@v4\n      - uses: actions/setup-node@v7\n        with:\n          cache: pnpm\n          node-version: 22\n"),
    },
    {
      name: "pnpm installed after setup-node is not fixable",
      files: { ".github/workflows/ci.yml": wf(`${NODE}      - uses: pnpm/action-setup@v4\n`), "pnpm-lock.yaml": "" },
      errors: [{ line: 6, messageIncludes: "pnpm" }],
      output: wf(`${NODE}      - uses: pnpm/action-setup@v4\n`),
    },
    {
      name: "yarn classic",
      files: { ".github/workflows/ci.yml": wf(NODE), "yarn.lock": "# yarn lockfile v1\n" },
      errors: [{ messageIncludes: "Yarn" }],
      output: wf("      - uses: actions/setup-node@v7\n        with:\n          cache: yarn\n          node-version: 22\n"),
    },
    {
      name: "no with mapping: report without fix",
      files: { ".github/workflows/ci.yml": wf("      - uses: actions/setup-node@v7\n"), ...NPM },
      errors: [{ line: 6 }],
      output: wf("      - uses: actions/setup-node@v7\n"),
    },
    {
      name: "aliased with mapping is not edited",
      files: {
        ".github/workflows/ci.yml": `x-node: &node\n  node-version: 22\n${HEAD}      - uses: actions/setup-node@v7\n        with: *node\n`,
        ...NPM,
      },
      errors: [{ line: 8 }],
      output: `x-node: &node\n  node-version: 22\n${HEAD}      - uses: actions/setup-node@v7\n        with: *node\n`,
    },
    {
      name: "anchored with mapping is not edited",
      files: { ".github/workflows/ci.yml": wf("      - uses: actions/setup-node@v7\n        with: &node\n          node-version: 22\n"), ...NPM },
      errors: 1,
      output: wf("      - uses: actions/setup-node@v7\n        with: &node\n          node-version: 22\n"),
    },
    {
      name: "flow-style with is not edited",
      files: { ".github/workflows/ci.yml": wf("      - uses: actions/setup-node@v7\n        with: { node-version: 22 }\n"), ...NPM },
      errors: 1,
      output: wf("      - uses: actions/setup-node@v7\n        with: { node-version: 22 }\n"),
    },
    {
      name: "lockfile only in a subdirectory needs cache-dependency-path",
      files: { ".github/workflows/ci.yml": wf(NODE), "web/package-lock.json": "{}" },
      errors: [{ messageIncludes: "npm" }],
      output: wf(NODE),
    },
    {
      name: "setup-python with requirements.txt",
      files: { ".github/workflows/ci.yml": wf("      - uses: actions/setup-python@v7\n        with:\n          python-version: '3.13'\n"), "requirements.txt": "" },
      errors: [{ line: 6, messageIncludes: "pip" }],
      output: wf("      - uses: actions/setup-python@v7\n        with:\n          cache: pip\n          python-version: '3.13'\n"),
    },
    {
      name: "poetry is fixable only when installed before setup-python",
      files: {
        ".github/workflows/ci.yml": wf("      - run: pipx install poetry\n      - uses: actions/setup-python@v7\n        with:\n          python-version: '3.13'\n"),
        "poetry.lock": "",
      },
      errors: [{ line: 7, messageIncludes: "Poetry" }],
      output: wf("      - run: pipx install poetry\n      - uses: actions/setup-python@v7\n        with:\n          cache: poetry\n          python-version: '3.13'\n"),
    },
    {
      name: "poetry not installed first: no fix",
      files: { ".github/workflows/ci.yml": wf("      - uses: actions/setup-python@v7\n        with:\n          python-version: '3.13'\n"), "poetry.lock": "" },
      errors: 1,
      output: wf("      - uses: actions/setup-python@v7\n        with:\n          python-version: '3.13'\n"),
    },
    {
      name: "uv.lock without setup-uv",
      files: { ".github/workflows/ci.yml": wf("      - uses: actions/setup-python@v7\n"), "uv.lock": "" },
      errors: [{ messageIncludes: "uv.lock" }],
    },
    {
      name: "setup-java with pom.xml",
      files: { ".github/workflows/ci.yml": wf("      - uses: actions/setup-java@v6\n        with:\n          distribution: temurin\n          java-version: 21\n"), "pom.xml": "" },
      errors: [{ messageIncludes: "Maven" }],
      output: wf("      - uses: actions/setup-java@v6\n        with:\n          cache: maven\n          distribution: temurin\n          java-version: 21\n"),
    },
    {
      name: "setup-java with gradle",
      files: { ".github/workflows/ci.yml": wf("      - uses: actions/setup-java@v6\n        with:\n          distribution: temurin\n"), "app/build.gradle": "" },
      errors: [{ messageIncludes: "Gradle" }],
      output: wf("      - uses: actions/setup-java@v6\n        with:\n          cache: gradle\n          distribution: temurin\n"),
    },
    {
      name: "setup-go cache: false is reported on the cache line",
      files: { ".github/workflows/ci.yml": wf("      - uses: actions/setup-go@v7\n        with:\n          go-version: '1.25'\n          cache: false\n"), "go.mod": "" },
      errors: [{ line: 9, messageIncludes: "cache: false" }],
    },
    {
      name: "setup-dotnet with packages.lock.json",
      files: { ".github/workflows/ci.yml": wf("      - uses: actions/setup-dotnet@v6\n        with:\n          dotnet-version: 9.x\n"), "src/App/packages.lock.json": "{}" },
      errors: [{ messageIncludes: "NuGet" }],
    },
    {
      name: "composite actions are checked",
      files: {
        "action.yml": "name: setup\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v7\n      with:\n        node-version: 22\n",
        ...NPM,
      },
      errors: [{ path: "action.yml", line: 5 }],
      output: { "action.yml": "name: setup\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v7\n      with:\n        cache: npm\n        node-version: 22\n" },
    },
  ],
});
