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
  ],
  invalid: [
    {
      name: "arm64 emulated on an x64 runner",
      files: { ".github/workflows/ci.yml": emulatedBuild("ubuntu-24.04", "linux/amd64,linux/arm64"), Dockerfile: NATIVE_DOCKERFILE },
      errors: [{ line: 11, messageIncludes: "`linux/arm64` is built on `ubuntu-24.04` (amd64) through docker/setup-qemu-action" }],
    },
    {
      name: "amd64 emulated on an arm64 runner",
      files: { ".github/workflows/ci.yml": emulatedBuild("ubuntu-24.04-arm", "linux/arm64,linux/amd64"), Dockerfile: NATIVE_DOCKERFILE },
      errors: [{ line: 11, messageIncludes: "the 2 RUN instruction(s) of Dockerfile execute under QEMU user-mode emulation" }],
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
      errors: [{ line: 7, messageIncludes: "through tonistiigi/binfmt --install" }],
    },
    {
      name: "only the cross-compile-free stages matter",
      files: {
        ".github/workflows/ci.yml": emulatedBuild("ubuntu-22.04", "linux/arm64"),
        Dockerfile: "FROM rust:1.82 AS build\nCOPY . .\nRUN cargo build --release\nFROM debian:bookworm-slim\nCOPY --from=build /target/release/app /app\n",
      },
      errors: [{ line: 11, messageIncludes: "does not cross-compile with `FROM --platform=$BUILDPLATFORM`" }],
    },
  ],
});
