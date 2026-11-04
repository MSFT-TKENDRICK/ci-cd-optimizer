import rule from "../../../../src/lint/rules/containers/dependency-layer.js";
import { ruleTester } from "../../rule-tester.js";

ruleTester(rule, {
  valid: [
    {
      name: "manifests copied before install",
      files: { Dockerfile: "FROM node:22-slim\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build\n" },
    },
    {
      name: "broad copy without a later install",
      files: { Dockerfile: "FROM nginx:1.27\nCOPY . /usr/share/nginx/html\n" },
    },
    {
      name: "pnpm fetch before the broad copy covers the later offline install",
      files: {
        Dockerfile:
          "FROM node:22-slim\nWORKDIR /app\nCOPY pnpm-lock.yaml ./\nRUN pnpm fetch\nCOPY . .\nRUN pnpm install --offline --frozen-lockfile\n",
      },
    },
    {
      name: "copies from another stage are not build-context copies",
      files: {
        Dockerfile:
          "FROM node:22 AS build\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build\nFROM node:22-slim\nCOPY --from=build /app .\nRUN npm ci --omit=dev\n",
      },
    },
    {
      name: "global tool installs are not dependency installs",
      files: { Dockerfile: "FROM node:22\nCOPY . .\nRUN npm install -g pnpm@10\n" },
    },
    {
      name: "stage inheriting installed dependencies from its parent stage",
      files: {
        Dockerfile:
          "FROM rust:1.82 AS deps\nCOPY Cargo.toml Cargo.lock ./\nRUN cargo fetch\nFROM deps AS build\nCOPY . .\nRUN cargo build --release\n",
      },
    },
  ],
  invalid: [
    {
      files: { Dockerfile: "FROM node:22-slim\nWORKDIR /app\nCOPY . .\nRUN npm ci\nRUN npm run build\n" },
      errors: [{ path: "Dockerfile", line: 3, messageIncludes: "npm dependency layer" }],
    },
    {
      name: "multi-line RUN with flags and continuation reports the install on its own line",
      files: {
        "services/api/Dockerfile":
          "FROM python:3.13-slim\nCOPY . /src\nRUN --mount=type=cache,target=/root/.cache/pip \\\n    pip install --upgrade pip && \\\n    pip install -r /src/requirements.txt\n",
      },
      errors: [{ path: "services/api/Dockerfile", line: 2, messageIncludes: "(line 5)" }],
    },
    {
      name: "ADD of the context and Go modules",
      files: { "Containerfile": "FROM golang:1.23\nWORKDIR /src\nADD . .\nRUN go mod download\nRUN go build ./...\n" },
      errors: [{ line: 3, messageIncludes: "go dependency layer" }],
    },
    {
      name: "pnpm suggestion mentions pnpm fetch and turbo prune in a turborepo",
      files: {
        Dockerfile: "FROM node:22\nWORKDIR /app\nCOPY ./ ./\nRUN corepack enable && pnpm install --frozen-lockfile\n",
        "turbo.json": "{}",
      },
      errors: [{ line: 3, messageIncludes: "pnpm" }],
    },
    {
      name: "a dependency installed before the copy does not hide a different ecosystem installed after it",
      files: {
        Dockerfile:
          "FROM python:3.13\nCOPY requirements.txt ./\nRUN pip install -r requirements.txt\nCOPY . .\nRUN npm ci\nRUN pip install -r requirements.txt\n",
      },
      errors: [{ line: 4, messageIncludes: "npm" }],
    },
    {
      name: "heredoc RUN and exec-form COPY",
      files: { Dockerfile: 'FROM ruby:3.3\nCOPY [".", "/app"]\nRUN <<EOF\nset -e\nbundle install\nEOF\n' },
      errors: [{ line: 2, messageIncludes: "(line 5)" }],
    },
    {
      name: "one report per broad copy in each stage",
      files: { Dockerfile: "FROM maven:3 AS build\nCOPY . .\nRUN mvn -B package\nFROM node:22 AS web\nCOPY . .\nRUN yarn install\n" },
      errors: [{ line: 2, messageIncludes: "maven" }, { line: 5, messageIncludes: "yarn" }],
    },
  ],
});
