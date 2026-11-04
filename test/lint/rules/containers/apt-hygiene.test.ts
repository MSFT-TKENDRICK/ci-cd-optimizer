import rule from "../../../../src/lint/rules/containers/apt-hygiene.js";
import { ruleTester } from "../../rule-tester.js";

ruleTester(rule, {
  valid: [
    {
      name: "canonical apt pattern",
      files: {
        Dockerfile:
          "FROM debian:bookworm-slim\nRUN apt-get update && \\\n    apt-get install -y --no-install-recommends curl ca-certificates && \\\n    rm -rf /var/lib/apt/lists/*\n",
      },
    },
    {
      name: "apt cache mounts keep lists out of the layer",
      files: {
        Dockerfile:
          "# syntax=docker/dockerfile:1\nFROM ubuntu:24.04\nRUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n    --mount=type=cache,target=/var/lib/apt,sharing=locked \\\n    apt-get update && apt-get -y install --no-install-recommends git\n",
      },
    },
    {
      name: "apk add --no-cache",
      files: { Dockerfile: "FROM alpine:3.20\nRUN apk add --no-cache curl git\n" },
    },
    {
      name: "recommends disabled globally through apt.conf",
      files: {
        Dockerfile:
          "FROM debian:bookworm\nRUN echo 'APT::Install-Recommends \"0\";' > /etc/apt/apt.conf.d/99norecommends\nRUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*\n",
      },
    },
    {
      name: "update followed by an opaque install script",
      files: { Dockerfile: "FROM debian:bookworm\nRUN apt-get update && ./scripts/install-deps.sh\n" },
    },
    {
      name: "apk cache mount",
      files: { Dockerfile: "FROM alpine:3.20\nRUN --mount=type=cache,target=/var/cache/apk apk add git\n" },
    },
  ],
  invalid: [
    {
      name: "missing --no-install-recommends is fixed in place",
      files: { Dockerfile: "FROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*\n" },
      errors: [{ path: "Dockerfile", line: 2, messageIncludes: "installs recommended packages" }],
      output: {
        Dockerfile:
          "FROM debian:bookworm-slim\nRUN apt-get update && apt-get install --no-install-recommends -y curl && rm -rf /var/lib/apt/lists/*\n",
      },
    },
    {
      name: "separate update layer and an install that keeps recommends on a continuation line",
      files: {
        Dockerfile: "FROM ubuntu:24.04\nRUN apt-get update\nRUN set -eux; \\\n    apt-get -y install git; \\\n    apt-get clean\n",
      },
      errors: [
        { line: 2, messageIncludes: "without an install" },
        { line: 4, messageIncludes: "`apt-get -y install`" },
      ],
      output: { Dockerfile: "FROM ubuntu:24.04\nRUN apt-get update\nRUN set -eux; \\\n    apt-get -y install --no-install-recommends git; \\\n    apt-get clean\n" },
    },
    {
      name: "package lists left in the layer",
      files: { Dockerfile: "FROM debian:bookworm\nRUN apt-get update && apt-get install -y --no-install-recommends curl\n" },
      errors: [{ line: 2, messageIncludes: "/var/lib/apt/lists" }],
    },
    {
      name: "apk add without --no-cache",
      files: { "docker/worker.Dockerfile": "FROM alpine:3.20\nRUN apk update && apk add git\n" },
      errors: [{ path: "docker/worker.Dockerfile", line: 2, messageIncludes: "--no-cache" }],
    },
    {
      name: "install verb on a later line than the command is reported without a fix",
      files: { Dockerfile: "FROM debian:bookworm\nRUN apt-get -y \\\n    install curl && rm -rf /var/lib/apt/lists/*\n" },
      errors: [{ line: 2, messageIncludes: "installs recommended packages" }],
      output: { Dockerfile: "FROM debian:bookworm\nRUN apt-get -y \\\n    install curl && rm -rf /var/lib/apt/lists/*\n" },
    },
    {
      name: "heredoc RUN with all three apt problems",
      files: { Dockerfile: "FROM debian:bookworm\nRUN <<EOF\napt-get update\napt-get install -y curl\nEOF\n" },
      errors: [
        { line: 4, messageIncludes: "recommended" },
        { line: 4, messageIncludes: "lists" },
      ],
      output: { Dockerfile: "FROM debian:bookworm\nRUN <<EOF\napt-get update\napt-get install --no-install-recommends -y curl\nEOF\n" },
    },
  ],
});
