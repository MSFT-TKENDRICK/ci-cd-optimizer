import rule from "../../../../src/lint/rules/containers/qemu-emulated-multiarch.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const NATIVE_DOCKERFILE = "FROM node:22-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build\n";

const emulatedBuild = (runsOn: string, platforms: string, qemu = true): string =>
  yml(
    "on: push",
    "jobs:",
    "  image:",
    `    runs-on: ${runsOn}`,
    "    steps:",
    "      - uses: actions/checkout@v6",
    ...(qemu ? ["      - uses: docker/setup-qemu-action@v4"] : []),
    "      - uses: docker/setup-buildx-action@v4",
    "      - uses: docker/build-push-action@v7",
    "        with:",
    `          platforms: ${platforms}`,
    "          push: true",
    "          tags: ghcr.io/octo/app:latest",
  );

ruleTester(rule, {
  valid: [
    {
      name: "Dockerfile cross-compiles from the build platform",
      files: {
        ".github/workflows/ci.yml": emulatedBuild("ubuntu-24.04", "linux/amd64,linux/arm64"),
        Dockerfile:
          "FROM --platform=$BUILDPLATFORM golang:1.24 AS build\nARG TARGETOS TARGETARCH\nRUN GOOS=$TARGETOS GOARCH=$TARGETARCH go build -o /app .\nFROM gcr.io/distroless/static\nCOPY --from=build /app /app\n",
      },
    },
    {
      name: "Dockerfile without RUN instructions executes nothing under emulation",
      files: {
        ".github/workflows/ci.yml": emulatedBuild("ubuntu-24.04", "linux/amd64,linux/arm64"),
        Dockerfile: "FROM nginx:1.27\nCOPY site /usr/share/nginx/html\n",
      },
    },
    {
      name: "no QEMU registration",
      files: {
        ".github/workflows/ci.yml": emulatedBuild("ubuntu-24.04", "linux/amd64,linux/arm64", false),
        Dockerfile: NATIVE_DOCKERFILE,
      },
    },
    {
      name: "only the native platform is built",
      files: { ".github/workflows/ci.yml": emulatedBuild("ubuntu-24.04", "linux/amd64"), Dockerfile: NATIVE_DOCKERFILE },
    },
    {
      name: "arm64 runner building arm64 only",
      files: { ".github/workflows/ci.yml": emulatedBuild("ubuntu-24.04-arm", "linux/arm64"), Dockerfile: NATIVE_DOCKERFILE },
    },
    {
      name: "runner from a matrix expression has an unknown architecture",
      files: { ".github/workflows/ci.yml": emulatedBuild("${{ matrix.runner }}", "linux/amd64,linux/arm64"), Dockerfile: NATIVE_DOCKERFILE },
    },
    {
      name: "other emulated architectures are not covered by native hosted runners",
      files: { ".github/workflows/ci.yml": emulatedBuild("ubuntu-24.04", "linux/amd64,linux/s390x"), Dockerfile: NATIVE_DOCKERFILE },
    },
    {
      name: "Dockerfile that cannot be resolved",
      files: emulatedBuild("ubuntu-24.04", "linux/amd64,linux/arm64"),
    },
    ...[
      "docker/setup-qemu-action@v4\n        if: false",
      "docker/setup-qemu-action@v4\n        with:\n          platforms: amd64",
      "docker/setup-qemu-action@v4\n        with:\n          platforms: ${{ inputs.platforms }}",
    ].map((action) => ({
      name: `QEMU setup is conditional or does not visibly register the foreign platform: ${action}`,
      files: {
        ".github/workflows/ci.yml": emulatedBuild("ubuntu-24.04", "linux/arm64").replace("docker/setup-qemu-action@v4", action),
        Dockerfile: NATIVE_DOCKERFILE,
      },
    })),
    {
      name: "QEMU setup after the build does not affect that build",
      files: {
        ".github/workflows/ci.yml": `${emulatedBuild("ubuntu-24.04", "linux/arm64", false)}      - uses: docker/setup-qemu-action@v4\n`,
        Dockerfile: NATIVE_DOCKERFILE,
      },
    },
    {
      name: "fixed-native stages do not establish emulated execution",
      files: {
        ".github/workflows/ci.yml": emulatedBuild("ubuntu-24.04", "linux/arm64"),
        Dockerfile: "FROM --platform=linux/amd64 alpine AS build\nRUN echo native\nFROM scratch\nCOPY --from=build /out /out\n",
      },
    },
    ...[
      "echo tonistiigi/binfmt --install arm64",
      "docker run --help --privileged tonistiigi/binfmt --install arm64",
      "docker run --rm tonistiigi/binfmt --install arm64",
      "docker run --privileged --rm tonistiigi/binfmt --install amd64",
      "docker run --privileged tonistiigi/binfmt-lookalike --install arm64",
    ].map((command) => ({
      name: `text, query modes, unrelated images or platform choices do not establish registration: ${command}`,
      files: {
        ".github/workflows/ci.yml": emulatedBuild("ubuntu-24.04", "linux/arm64")
          .replace("uses: docker/setup-qemu-action@v4", `run: ${command}`),
        Dockerfile: NATIVE_DOCKERFILE,
      },
    })),
    ...["--builder remote", "--builder=remote"].map((option) => ({
      name: `a global builder selection is not assumed to be the local runner: ${option}`,
      files: {
        ".github/workflows/ci.yml": yml(
          "on: push", "jobs:", "  image:", "    runs-on: ubuntu-24.04", "    steps:",
          "      - uses: docker/setup-qemu-action@v4",
          `      - run: docker buildx ${option} build --platform linux/arm64 .`,
        ),
        Dockerfile: NATIVE_DOCKERFILE,
      },
    })),
    {
      name: "a remote Buildx endpoint may supply native nodes",
      files: {
        ".github/workflows/ci.yml": emulatedBuild("ubuntu-24.04", "linux/arm64")
          .replace("uses: docker/setup-buildx-action@v4", "uses: docker/setup-buildx-action@v4\n        with:\n          endpoint: ssh://builder.example"),
        Dockerfile: NATIVE_DOCKERFILE,
      },
    },
  ],
  invalid: [
    {
      name: "arm64 emulated on an x64 runner",
      files: { ".github/workflows/ci.yml": emulatedBuild("ubuntu-24.04", "linux/amd64,linux/arm64"), Dockerfile: NATIVE_DOCKERFILE },
      errors: [{ line: 11, messageIncludes: "`linux/arm64` is requested on `ubuntu-24.04` (amd64) after docker/setup-qemu-action, and Dockerfile contains 2 potentially relevant RUN instruction(s) without a recognized cross-compilation pattern. This can involve QEMU, but cached/pruned stages or native builder nodes can avoid emulation; inspect build logs and timings." }],
    },
    {
      name: "amd64 emulated on an arm64 runner",
      files: { ".github/workflows/ci.yml": emulatedBuild("ubuntu-24.04-arm", "linux/arm64,linux/amd64"), Dockerfile: NATIVE_DOCKERFILE },
      errors: [{ line: 11, messageIncludes: "`linux/amd64` is requested on `ubuntu-24.04-arm` (arm64) after docker/setup-qemu-action, and Dockerfile contains 2 potentially relevant RUN instruction(s) without a recognized cross-compilation pattern. This can involve QEMU, but cached/pruned stages or native builder nodes can avoid emulation; inspect build logs and timings." }],
    },
    {
      name: "docker buildx build CLI with binfmt registration",
      files: {
        ".github/workflows/ci.yml": yml(
          "on: push",
          "jobs:",
          "  image:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: docker run --privileged --rm tonistiigi/binfmt --install arm64",
          "      - run: docker buildx build --platform linux/amd64,linux/arm64 -f docker/app.Dockerfile --push -t ghcr.io/octo/app .",
        ),
        "docker/app.Dockerfile": NATIVE_DOCKERFILE,
      },
      errors: [{ line: 7, messageIncludes: "`linux/arm64` is requested on `ubuntu-latest` (amd64) after tonistiigi/binfmt --install, and docker/app.Dockerfile contains 2 potentially relevant RUN instruction(s) without a recognized cross-compilation pattern. This can involve QEMU, but cached/pruned stages or native builder nodes can avoid emulation; inspect build logs and timings." }],
    },
    {
      name: "only the cross-compile-free stages matter",
      files: {
        ".github/workflows/ci.yml": emulatedBuild("ubuntu-22.04", "linux/arm64"),
        Dockerfile: "FROM rust:1.82 AS build\nCOPY . .\nRUN cargo build --release\nFROM debian:bookworm-slim\nCOPY --from=build /target/release/app /app\n",
      },
      errors: [{ line: 11, messageIncludes: "`linux/arm64` is requested on `ubuntu-22.04` (amd64) after docker/setup-qemu-action, and Dockerfile contains 1 potentially relevant RUN instruction(s) without a recognized cross-compilation pattern. This can involve QEMU, but cached/pruned stages or native builder nodes can avoid emulation; inspect build logs and timings." }],
    },
  ],
});
