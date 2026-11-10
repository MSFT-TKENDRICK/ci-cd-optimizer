import rule from "../../../../src/lint/rules/containers/gha-cache-missing-scope.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const matrixBuild = (matrix: string[], ...with_: string[]): string =>
  yml(
    "on: push",
    "jobs:",
    "  image:",
    "    runs-on: ubuntu-24.04",
    "    strategy:",
    "      matrix:",
    ...matrix.map((line) => `        ${line}`),
    "    steps:",
    "      - uses: docker/build-push-action@v7",
    "        with:",
    ...with_.map((line) => `          ${line}`),
  );

const DOCKERFILE = "FROM node:22-slim\nCOPY . .\nRUN npm ci\n";

ruleTester(rule, {
  valid: [
    {
      name: "matrix legs scoped by the matrix value",
      files: matrixBuild(
        ["platform: [linux/amd64, linux/arm64]"],
        "platforms: ${{ matrix.platform }}",
        "cache-from: type=gha,scope=${{ matrix.platform }}",
        "cache-to: type=gha,mode=max,scope=${{ matrix.platform }}",
      ),
    },
    {
      name: "matrix dimension not used by the build",
      files: matrixBuild(["node: [20, 22]"], "push: false", "cache-from: type=gha", "cache-to: type=gha,mode=max"),
    },
    {
      name: "single-value dimension",
      files: matrixBuild(["platform: [linux/amd64]"], "platforms: ${{ matrix.platform }}", "cache-from: type=gha", "cache-to: type=gha"),
    },
    {
      name: "registry cache keyed by its ref",
      files: matrixBuild(
        ["platform: [linux/amd64, linux/arm64]"],
        "platforms: ${{ matrix.platform }}",
        "cache-to: type=registry,ref=ghcr.io/o/app:cache,mode=max",
      ),
    },
    {
      name: "one image without a matrix",
      files: {
        ".github/workflows/ci.yml": yml(
          "on: push",
          "jobs:",
          "  image:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - uses: docker/build-push-action@v7",
          "        with:",
          "          cache-from: type=gha",
          "          cache-to: type=gha,mode=max",
        ),
        Dockerfile: DOCKERFILE,
      },
    },
    {
      name: "two build-push-action images are left to caching/docker-layer-cache",
      files: {
        ".github/workflows/ci.yml": yml(
          "on: push",
          "jobs:",
          "  api:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - uses: docker/build-push-action@v7",
          "        with:",
          "          context: api",
          "          cache-to: type=gha",
          "  web:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - uses: docker/build-push-action@v7",
          "        with:",
          "          context: web",
          "          cache-to: type=gha",
        ),
        "api/Dockerfile": DOCKERFILE,
        "web/Dockerfile": DOCKERFILE,
      },
    },
    {
      name: "the same image built twice",
      files: {
        ".github/workflows/ci.yml": yml(
          "on: push",
          "jobs:",
          "  a:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - run: docker buildx build --cache-to type=gha --cache-from type=gha .",
          "  b:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - run: docker buildx build --cache-to type=gha --cache-from type=gha .",
        ),
        Dockerfile: DOCKERFILE,
      },
    },
  ],
  invalid: [
    {
      name: "matrix platforms share the default scope",
      files: matrixBuild(
        ["platform: [linux/amd64, linux/arm64]"],
        "platforms: ${{ matrix.platform }}",
        "cache-from: type=gha",
        "cache-to: type=gha,mode=max",
      ),
      errors: [{ line: 13, messageIncludes: "`cache-to` entry `type=gha,mode=max` has no `scope` in matrix job `image`" }],
      output: null,
    },
    {
      name: "matrix include legs share a fixed scope",
      files: matrixBuild(
        ["include:", "  - image: api", "  - image: web"],
        "context: ${{ matrix.image }}",
        "tags: ghcr.io/o/${{ matrix.image }}",
        "cache-from: type=gha,scope=app",
        "cache-to: type=gha,scope=app,mode=max",
      ),
      errors: [{ line: 16, messageIncludes: "`cache-to` entry `type=gha,scope=app,mode=max` uses scope `app` in matrix job `image`, but does not visibly distinguish `matrix.image` used by the build. Variants may replace the same cache index if they share a repository/branch namespace; correlated dimensions or other cache sources may avoid a collision." }],
      output: null,
    },
    {
      name: "CLI build expanding a matrix value through the step environment",
      files: yml(
        "on: push",
        "jobs:",
        "  image:",
        "    runs-on: ubuntu-24.04",
        "    strategy:",
        "      matrix:",
        "        platform: [linux/amd64, linux/arm64]",
        "    steps:",
        '      - run: docker buildx build --platform "$PLATFORM" --cache-from type=gha --cache-to type=gha,mode=max .',
        "        env:",
        "          PLATFORM: ${{ matrix.platform }}",
      ),
      errors: [{ line: 9, messageIncludes: "`--cache-to` entry `type=gha,mode=max` has no `scope`" }],
    },
    {
      name: "different images export to the default scope",
      files: {
        ".github/workflows/ci.yml": yml(
          "on: push",
          "jobs:",
          "  api:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - uses: docker/build-push-action@v7",
          "        with:",
          "          context: api",
          "          cache-from: type=gha",
          "          cache-to: type=gha,mode=max",
          "  web:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - run: docker buildx build --cache-from type=gha --cache-to type=gha,mode=max -f web/Dockerfile web",
        ),
        "api/Dockerfile": DOCKERFILE,
        "web/Dockerfile": DOCKERFILE,
      },
      errors: [
        { line: 10, messageIncludes: "(building api/Dockerfile) has no `scope`, and 1 build(s) of a different image (web/Dockerfile)" },
        { line: 14, messageIncludes: "(building web/Dockerfile) has no `scope`, and 1 build(s) of a different image (api/Dockerfile)" },
      ],
      output: null,
    },
  ],
});
