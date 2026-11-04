import rule from "../../../../src/lint/rules/containers/cache-mount.js";
import { describe, expect, it } from "vitest";
import { ruleTester, runRule } from "../../rule-tester.js";

ruleTester(rule, {
  valid: [
    {
      name: "npm cache mount",
      files: { Dockerfile: "# syntax=docker/dockerfile:1\nFROM node:22-slim\nCOPY package*.json ./\nRUN --mount=type=cache,target=/root/.npm npm ci\n" },
    },
    {
      name: "go build with module and build caches",
      files: {
        Dockerfile:
          "# syntax=docker/dockerfile:1\nFROM golang:1.23\nRUN --mount=type=cache,target=/go/pkg/mod \\\n    --mount=type=cache,target=/root/.cache/go-build \\\n    go build -o /out/app ./cmd/app\n",
      },
    },
    {
      name: "apt with locked cache mounts",
      files: {
        Dockerfile:
          "# syntax=docker/dockerfile:1\nFROM debian:bookworm\nRUN --mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt,sharing=locked apt-get update && apt-get install -y --no-install-recommends git\n",
      },
    },
    {
      name: "custom cache directory mount is trusted",
      files: { Dockerfile: "FROM node:22\nRUN --mount=type=cache,target=/cache npm ci --cache /cache\n" },
    },
    {
      name: "commands that do not use a dependency cache",
      files: { Dockerfile: "FROM node:22\nRUN npm run build && npm install -g pnpm@10\nRUN pip install --upgrade pip\n" },
    },
    {
      name: "Windows images do not support cache mounts",
      files: { Dockerfile: "FROM mcr.microsoft.com/dotnet/sdk:8.0-windowsservercore-ltsc2022\nRUN dotnet restore\n" },
    },
  ],
  invalid: [
    {
      files: { Dockerfile: "FROM node:22-slim\nCOPY package*.json ./\nRUN npm ci\n" },
      errors: [{ path: "Dockerfile", line: 3, messageIncludes: "`npm ci` runs without a BuildKit cache mount" }],
    },
    {
      name: "pnpm with a syntax directive gets the store mount suggestion only",
      files: { Dockerfile: "# syntax=docker/dockerfile:1\nFROM node:22\nRUN corepack enable && pnpm install --frozen-lockfile\n" },
      errors: [{ line: 3, messageIncludes: "pnpm install" }],
    },
    {
      name: "go build with only the module cache mounted, on a continuation line",
      files: {
        Dockerfile: "FROM golang:1.23 AS build\nWORKDIR /src\nRUN --mount=type=cache,target=/go/pkg/mod go mod download && \\\n    go build ./...\n",
      },
      errors: [{ line: 4, messageIncludes: "`go build ./...`" }],
    },
    {
      name: "one report per tool and RUN",
      files: {
        "py/Dockerfile":
          "FROM python:3.13\nRUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*\nRUN pip install --no-cache-dir -r requirements.txt && pip install -r dev.txt\n",
      },
      errors: [
        { path: "py/Dockerfile", line: 2, messageIncludes: "apt" },
        { path: "py/Dockerfile", line: 3, messageIncludes: "pip" },
      ],
    },
    {
      name: "cargo and maven builds in two stages",
      files: {
        Dockerfile: "FROM rust:1.82 AS rust\nWORKDIR /app\nRUN cargo build --release\nFROM maven:3 AS java\nRUN mvn -B package\n",
      },
      errors: [
        { line: 3, messageIncludes: "Cargo" },
        { line: 5, messageIncludes: "Maven" },
      ],
    },
  ],
});

describe("containers/cache-mount suggestions", () => {
  it("suggests every missing mount for the tool and the syntax directive", () => {
    const [diagnostic] = runRule(rule, { files: { Dockerfile: "FROM golang:1.23\nRUN go build ./...\n" } });
    expect(diagnostic?.suggestion).toContain(
      "RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build go build ./...",
    );
    expect(diagnostic?.suggestion).toContain("# syntax=docker/dockerfile:1");
  });

  it("derives the cargo target mount from WORKDIR and flags non-root users", () => {
    const [diagnostic] = runRule(rule, {
      files: { Dockerfile: "# syntax=docker/dockerfile:1\nFROM rust:1.82\nWORKDIR /app\nUSER builder\nRUN cargo build --release\n" },
    });
    expect(diagnostic?.suggestion).toContain("--mount=type=cache,target=/app/target");
    expect(diagnostic?.suggestion).toContain("uid=");
    expect(diagnostic?.suggestion).not.toContain("# syntax");
  });
});