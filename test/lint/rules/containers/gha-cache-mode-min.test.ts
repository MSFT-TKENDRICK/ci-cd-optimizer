import rule from "../../../../src/lint/rules/containers/gha-cache-mode-min.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const buildPush = (...with_: string[]): string =>
  yml(
    "on: push",
    "jobs:",
    "  image:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - uses: docker/build-push-action@v7",
    "        with:",
    ...with_.map((line) => `          ${line}`),
  );

const MULTI_STAGE = [
  "FROM golang:1.23 AS build",
  "WORKDIR /src",
  "COPY go.mod go.sum ./",
  "RUN go mod download",
  "COPY . .",
  "RUN go build -o /out/app .",
  "FROM gcr.io/distroless/static",
  "COPY --from=build /out/app /app",
  "",
].join("\n");

ruleTester(rule, {
  valid: [
    {
      name: "mode=max already exports builder stages",
      files: { ".github/workflows/ci.yml": buildPush("cache-from: type=gha", "cache-to: type=gha,mode=max"), Dockerfile: MULTI_STAGE },
    },
    {
      name: "single-stage Dockerfile: mode=min caches everything",
      files: {
        ".github/workflows/ci.yml": buildPush("cache-from: type=gha", "cache-to: type=gha"),
        Dockerfile: "FROM node:22-slim\nCOPY . .\nRUN npm ci\n",
      },
    },
    {
      name: "inline cache only supports min and is another rule's concern",
      files: { ".github/workflows/ci.yml": buildPush("cache-to: type=inline"), Dockerfile: MULTI_STAGE },
    },
    {
      name: "copied-from stage runs nothing",
      files: {
        ".github/workflows/ci.yml": buildPush("cache-to: type=gha"),
        Dockerfile: "FROM alpine AS assets\nCOPY assets /assets\nFROM nginx:1.27\nCOPY --from=assets /assets /usr/share/nginx/html\n",
      },
    },
    {
      name: "target is the builder stage itself",
      files: { ".github/workflows/ci.yml": buildPush("target: build", "cache-to: type=gha"), Dockerfile: MULTI_STAGE },
    },
    {
      name: "FROM-ancestor stages are part of the image",
      files: {
        ".github/workflows/ci.yml": buildPush("cache-to: type=gha"),
        Dockerfile: "FROM node:22-slim AS deps\nRUN npm ci\nFROM deps\nCOPY . .\nCMD [\"node\", \"index.js\"]\n",
      },
    },
    {
      name: "computed target is unknown",
      files: { ".github/workflows/ci.yml": buildPush("target: ${{ inputs.target }}", "cache-to: type=gha"), Dockerfile: MULTI_STAGE },
    },
    {
      name: "Dockerfile not in the repository",
      files: buildPush("context: https://github.com/o/r.git", "cache-to: type=gha"),
    },
  ],
  invalid: [
    {
      name: "default mode on a multi-stage build",
      files: { ".github/workflows/ci.yml": buildPush("cache-from: type=gha", "cache-to: type=gha"), Dockerfile: MULTI_STAGE },
      errors: [{ line: 9, messageIncludes: "`cache-to` entry `type=gha` uses the default `mode=min`" }],
      output: { ".github/workflows/ci.yml": buildPush("cache-from: type=gha", "cache-to: type=gha,mode=max") },
    },
    {
      name: "explicit mode=min with a target",
      files: {
        ".github/workflows/ci.yml": buildPush("target: runtime", "cache-to: type=gha,mode=min,scope=app"),
        Dockerfile: `${MULTI_STAGE}FROM gcr.io/distroless/static AS runtime\nCOPY --from=build /out/app /app\n`,
      },
      errors: [{ line: 9, messageIncludes: "uses `mode=min`, which caches only layers exported into the resulting image, but Dockerfile (target `runtime`) builds intermediate stage(s) `build` with 2 RUN" }],
      output: { ".github/workflows/ci.yml": buildPush("target: runtime", "cache-to: type=gha,mode=max,scope=app") },
    },
    {
      name: "bare registry reference is rewritten to the attribute form",
      files: { ".github/workflows/ci.yml": buildPush("cache-to: ghcr.io/o/app:buildcache"), Dockerfile: MULTI_STAGE },
      errors: [{ line: 8, messageIncludes: "entry `ghcr.io/o/app:buildcache`" }],
      output: { ".github/workflows/ci.yml": buildPush("cache-to: type=registry,ref=ghcr.io/o/app:buildcache,mode=max") },
    },
    {
      name: "CLI build in a subdirectory",
      files: {
        ".github/workflows/ci.yml": yml(
          "on: push",
          "jobs:",
          "  image:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - run: docker buildx build --cache-from type=gha --cache-to type=gha -t app svc",
        ),
        "svc/Dockerfile": MULTI_STAGE,
      },
      errors: [{ line: 6, messageIncludes: "`--cache-to` entry `type=gha` uses the default `mode=min`" }],
      output: {
        ".github/workflows/ci.yml": yml(
          "on: push",
          "jobs:",
          "  image:",
          "    runs-on: ubuntu-24.04",
          "    steps:",
          "      - run: docker buildx build --cache-from type=gha --cache-to type=gha,mode=max -t app svc",
        ),
      },
    },
  ],
});
