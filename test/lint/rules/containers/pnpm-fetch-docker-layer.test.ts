import rule from "../../../../src/lint/rules/containers/pnpm-fetch-docker-layer.js";
import { ruleTester } from "../../rule-tester.js";

const lines = (...text: string[]): string => `${text.join("\n")}\n`;

const WORKSPACE = "packages:\n  - packages/*\n  - apps/*\n";

const MANIFEST_FIRST = lines(
  "FROM node:22-slim",
  "RUN corepack enable",
  "WORKDIR /app",
  "COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./",
  "COPY packages/api/package.json packages/api/",
  "COPY packages/web/package.json packages/web/",
  "RUN pnpm install --frozen-lockfile",
  "COPY . .",
  "RUN pnpm -r build",
);

ruleTester(rule, {
  valid: [
    {
      name: "not a pnpm workspace",
      files: { Dockerfile: MANIFEST_FIRST, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" },
    },
    {
      name: "workspace file outside the Dockerfile's directory tree",
      files: { Dockerfile: MANIFEST_FIRST, "tools/pnpm-workspace.yaml": WORKSPACE },
    },
    {
      name: "store already warmed with pnpm fetch",
      files: {
        "pnpm-workspace.yaml": WORKSPACE,
        Dockerfile: lines(
          "FROM node:22-slim",
          "WORKDIR /app",
          "COPY pnpm-lock.yaml pnpm-workspace.yaml ./",
          "RUN pnpm fetch",
          "COPY packages/api/package.json packages/api/",
          "RUN pnpm install --frozen-lockfile",
        ),
      },
    },
    {
      name: "broad copy before install is containers/dependency-layer's concern",
      files: {
        "pnpm-workspace.yaml": WORKSPACE,
        Dockerfile: lines("FROM node:22-slim", "WORKDIR /app", "COPY . .", "RUN pnpm install --frozen-lockfile"),
      },
    },
    {
      name: "only the root manifest is copied",
      files: {
        "pnpm-workspace.yaml": WORKSPACE,
        Dockerfile: lines("FROM node:22-slim", "WORKDIR /app", "COPY package.json pnpm-lock.yaml ./", "RUN pnpm install --frozen-lockfile"),
      },
    },
    {
      name: "global and offline installs",
      files: {
        "pnpm-workspace.yaml": WORKSPACE,
        Dockerfile: lines(
          "FROM node:22-slim",
          "COPY packages/api/package.json packages/api/",
          "RUN pnpm install -g turbo",
          "RUN pnpm install --offline",
        ),
      },
    },
  ],
  invalid: [
    {
      name: "every workspace manifest copied before install",
      files: { "pnpm-workspace.yaml": WORKSPACE, Dockerfile: MANIFEST_FIRST },
      errors: [
        {
          line: 7,
          messageIncludes:
            "`pnpm install --frozen-lockfile` in stage `0` follows copies of 2 workspace manifests (`packages/api/package.json`, `packages/web/package.json`). Manifest edits can invalidate this layer; they do not necessarily re-download dependencies from a warm store. Consider measuring a separate `pnpm fetch` layer for workspace `pnpm-workspace.yaml`.",
        },
      ],
    },
    {
      name: "manifest inherited from a named base stage, install behind a cache mount",
      files: {
        "pnpm-workspace.yaml": WORKSPACE,
        ".npmrc": "auto-install-peers=true\n",
        "apps/api/Dockerfile": lines(
          "FROM node:22-slim AS base",
          "WORKDIR /app",
          "COPY pnpm-lock.yaml pnpm-workspace.yaml ./",
          "COPY apps/api/package.json apps/api/",
          "FROM base AS deps",
          "RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm i --frozen-lockfile",
        ),
      },
      errors: [
        {
          path: "apps/api/Dockerfile",
          line: 6,
          messageIncludes: "`pnpm i --frozen-lockfile` in stage `deps` follows copies of 1 workspace manifest (`apps/api/package.json`). Manifest edits can invalidate this layer; they do not necessarily re-download dependencies from a warm store. Consider measuring a separate `pnpm fetch` layer for workspace `pnpm-workspace.yaml`.",
        },
      ],
    },
    {
      name: "long manifest list is summarised",
      files: {
        "pnpm-workspace.yaml": WORKSPACE,
        Dockerfile: lines(
          "FROM node:22-slim AS deps",
          "COPY pnpm-lock.yaml ./",
          "COPY packages/a/package.json packages/a/",
          "COPY packages/b/package.json packages/b/",
          "COPY packages/c/package.json packages/c/",
          "COPY apps/web/package.json apps/web/",
          "RUN pnpm install",
        ),
      },
      errors: [{ line: 7, messageIncludes: "`pnpm install` in stage `deps` follows copies of 4 workspace manifests (`packages/a/package.json`, `packages/b/package.json`, `packages/c/package.json` and 1 more). Manifest edits can invalidate this layer; they do not necessarily re-download dependencies from a warm store. Consider measuring a separate `pnpm fetch` layer for workspace `pnpm-workspace.yaml`." }],
    },
  ],
});
