import rule from "../../../../src/lint/rules/containers/buildx-load-multiplatform.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const buildPush = (runsOn: string, ...with_: string[]): string =>
  yml(
    "on: pull_request",
    "jobs:",
    "  image:",
    `    runs-on: ${runsOn}`,
    "    steps:",
    "      - uses: docker/setup-buildx-action@v4",
    "      - uses: docker/build-push-action@v7",
    "        with:",
    ...with_.map((line) => `          ${line}`),
  );

ruleTester(rule, {
  valid: [
    {
      name: "single platform loaded for testing",
      files: buildPush("ubuntu-24.04", "platforms: linux/amd64", "load: true", "tags: app:test"),
    },
    {
      name: "multi-platform build pushed instead of loaded",
      files: buildPush("ubuntu-24.04", "platforms: linux/amd64,linux/arm64", "push: true", "tags: ghcr.io/o/app:1"),
    },
    {
      name: "load without platforms builds only the native platform",
      files: buildPush("ubuntu-latest", "load: true", "tags: app:test"),
    },
    {
      name: "platforms from an expression cannot be counted",
      files: buildPush("ubuntu-24.04", "platforms: ${{ matrix.platforms }}", "load: true"),
    },
    {
      name: "runner image with the containerd image store",
      files: buildPush("ubuntu-26.04", "platforms: linux/amd64,linux/arm64", "load: true"),
    },
    {
      name: "containerd image store enabled with setup-docker-action",
      files: yml(
        "on: push",
        "jobs:",
        "  image:",
        "    runs-on: ubuntu-24.04",
        "    steps:",
        "      - uses: docker/setup-docker-action@v5",
        "        with:",
        "          daemon-config: |",
        '            {"features": {"containerd-snapshotter": true}}',
        "      - uses: docker/build-push-action@v7",
        "        with:",
        "          platforms: linux/amd64,linux/arm64",
        "          load: true",
      ),
    },
    {
      name: "self-hosted runner daemon is unknown",
      files: buildPush("[self-hosted, linux]", "platforms: linux/amd64,linux/arm64", "load: true"),
    },
    {
      name: "docker exporter writing a tarball does not load",
      files: yml(
        "on: push",
        "jobs:",
        "  image:",
        "    runs-on: ubuntu-24.04",
        "    steps:",
        "      - run: docker buildx build --platform linux/amd64,linux/arm64 --output type=oci,dest=app.tar .",
      ),
    },
  ],
  invalid: [
    {
      name: "build-push-action loads two platforms",
      files: buildPush("ubuntu-24.04", "platforms: linux/amd64,linux/arm64", "load: true", "tags: app:test"),
      errors: [{ line: 9, messageIncludes: "`load: true` with 2 platforms (`linux/amd64,linux/arm64`) on `ubuntu-24.04`" }],
    },
    {
      name: "docker buildx build --load with a platform list",
      files: yml(
        "on: push",
        "jobs:",
        "  image:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: docker/setup-buildx-action@v4",
        "      - run: |",
        "          echo building",
        "          docker buildx build --platform linux/amd64,linux/arm64 --load -t app:test .",
      ),
      errors: [{ line: 9, messageIncludes: '"does not support loading multi-platform images"' }],
    },
    {
      name: "repeated --platform flags with --output type=docker",
      files: yml(
        "on: push",
        "jobs:",
        "  image:",
        "    runs-on: ubuntu-24.04-arm",
        "    steps:",
        "      - run: docker buildx build --platform linux/arm64 --platform linux/amd64 --output type=docker -t app .",
      ),
      errors: [{ line: 6, messageIncludes: "`--output type=docker` with 2 platforms" }],
    },
    {
      name: "multi-line platforms input with docker outputs",
      files: buildPush("ubuntu-22.04", "platforms: |", "  linux/amd64", "  linux/arm64", "outputs: type=docker"),
      errors: [{ line: 9, messageIncludes: "`outputs: type=docker` with 2 platforms" }],
    },
  ],
});
