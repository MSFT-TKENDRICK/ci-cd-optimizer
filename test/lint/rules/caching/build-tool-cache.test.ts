import rule from "../../../../src/lint/rules/caching/build-tool-cache.js";
import { ruleTester } from "../../rule-tester.js";

const wf = (body: string, env = "") => `on: push\n${env}jobs:\n  b:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;

ruleTester(rule, {
  valid: [
    { name: "gradle with setup-gradle", files: wf("      - uses: gradle/actions/setup-gradle@v5\n      - run: ./gradlew build\n") },
    { name: "gradle with setup-java cache", files: wf("      - uses: actions/setup-java@v6\n        with:\n          cache: gradle\n      - run: ./gradlew test\n") },
    { name: "maven with setup-java cache", files: wf("      - uses: actions/setup-java@v6\n        with:\n          cache: maven\n      - run: mvn -B verify\n") },
    {
      name: "maven with ~/.m2 cache",
      files: wf("      - uses: actions/cache@v6\n        with:\n          path: ~/.m2/repository\n          key: m2-${{ hashFiles('**/pom.xml') }}\n      - run: ./mvnw verify\n"),
    },
    { name: "cargo with rust-cache", files: wf("      - uses: Swatinem/rust-cache@v2\n      - run: cargo test --locked\n") },
    { name: "cargo with setup-rust-toolchain (caches by default)", files: wf("      - uses: actions-rust-lang/setup-rust-toolchain@v1\n      - run: cargo build\n") },
    { name: "cargo fmt is not a build", files: wf("      - run: cargo fmt --check\n") },
    { name: "bazel with remote cache flag", files: wf("      - run: bazel test --remote_cache=grpcs://cache.example.com //...\n") },
    {
      name: "bazel with .bazelrc remote cache",
      files: { ".github/workflows/ci.yml": wf("      - run: bazel build --config=ci //...\n"), ".bazelrc": "build:ci --remote_cache=grpcs://cache\n" },
    },
    { name: "bazel without complete inventory is unknown", files: wf("      - run: bazel build //...\n"), inventoryComplete: false },
    { name: "turbo with workflow-level token", files: wf("      - run: npx turbo run build\n", "env:\n  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}\n  TURBO_TEAM: acme\n") },
    {
      name: "turbo with a cached .turbo directory",
      files: wf("      - uses: actions/cache@v6\n        with:\n          path: .turbo\n          key: turbo-${{ github.sha }}\n          restore-keys: turbo-\n      - run: pnpm turbo build\n"),
    },
    { name: "turbo prune is not a task run", files: wf("      - run: turbo prune web --docker\n") },
    { name: "nx with Nx Cloud token", files: wf("      - run: npx nx affected -t test\n        env:\n          NX_CLOUD_ACCESS_TOKEN: ${{ secrets.NX }}\n") },
    {
      name: "nx with nx.json cloud id",
      files: { ".github/workflows/ci.yml": wf("      - run: npx nx run-many -t build\n"), "nx.json": '{"nxCloudId":"abc"}' },
    },
    { name: "version checks are ignored", files: wf("      - run: ./gradlew --version\n") },
  ],
  invalid: [
    { name: "gradle without cache", files: wf("      - uses: actions/setup-java@v6\n      - run: ./gradlew build\n"), errors: [{ line: 7, messageIncludes: "Gradle" }] },
    {
      name: "one report per job per tool",
      files: wf("      - run: ./gradlew assemble\n      - run: |\n          gradle test\n          mvn -B verify\n"),
      errors: [
        { line: 6, messageIncludes: "Gradle" },
        { line: 9, messageIncludes: "Maven" },
      ],
    },
    { name: "cargo without cache", files: wf("      - uses: dtolnay/rust-toolchain@stable\n      - run: cargo +nightly test --workspace\n"), errors: [{ line: 7, messageIncludes: "Cargo" }] },
    { name: "bazel without remote or disk cache", files: wf("      - run: bazelisk test //...\n"), errors: [{ messageIncludes: "Bazel" }] },
    { name: "turbo without remote cache", files: wf("      - run: pnpm turbo run build test\n"), errors: [{ messageIncludes: "Turborepo" }] },
    { name: "turbo task shorthand", files: wf("      - run: npx turbo lint\n"), errors: 1 },
    { name: "nx affected without cache", files: { ".github/workflows/ci.yml": wf("      - run: npx nx affected -t lint test\n"), "nx.json": "{}" }, errors: [{ messageIncludes: "Nx" }] },
    {
      name: "commands inside a local composite action are reported on the calling step",
      files: {
        ".github/workflows/ci.yml": wf("      - uses: actions/checkout@v6\n      - uses: ./.github/actions/build\n"),
        ".github/actions/build/action.yml": "runs:\n  using: composite\n  steps:\n    - run: ./gradlew build\n      shell: bash\n",
      },
      errors: [{ path: ".github/workflows/ci.yml", line: 7 }],
    },
    {
      name: "a cache step in another job does not count",
      files:
        "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: gradle/actions/setup-gradle@v5\n  b:\n    runs-on: x\n    steps:\n      - run: ./gradlew build\n",
      errors: [{ line: 10 }],
    },
  ],
});
