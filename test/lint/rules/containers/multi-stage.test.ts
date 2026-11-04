import rule from "../../../../src/lint/rules/containers/multi-stage.js";
import { ruleTester } from "../../rule-tester.js";

ruleTester(rule, {
  valid: [
    {
      name: "multi-stage build",
      files: {
        Dockerfile:
          "FROM golang:1.23 AS build\nWORKDIR /src\nCOPY . .\nRUN go build -o /app .\nFROM gcr.io/distroless/static-debian12\nCOPY --from=build /app /app\n",
      },
    },
    {
      name: "production-only npm install",
      files: { Dockerfile: "FROM node:22-slim\nCOPY package*.json ./\nRUN npm ci --omit=dev\nCOPY . .\nCMD [\"node\", \"server.js\"]\n" },
    },
    {
      name: "NODE_ENV=production makes npm skip devDependencies",
      files: { Dockerfile: "FROM node:22-slim\nENV NODE_ENV=production\nRUN npm ci\n" },
    },
    {
      name: "toolchain purged in the same layer",
      files: {
        Dockerfile:
          "FROM python:3.13-alpine\nRUN apk add --no-cache --virtual .build gcc musl-dev && pip install -r requirements.txt && apk del .build\n",
      },
    },
    {
      name: "runtime packages only",
      files: { Dockerfile: "FROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*\n" },
    },
    {
      name: "devcontainer images are meant to carry toolchains",
      files: { ".devcontainer/Dockerfile": "FROM mcr.microsoft.com/devcontainers/base:bookworm\nRUN apt-get update && apt-get install -y build-essential git\n" },
    },
  ],
  invalid: [
    {
      files: { Dockerfile: "FROM golang:1.23\nWORKDIR /src\nCOPY . .\nRUN go build -o /app ./cmd/server\nCMD [\"/app\"]\n" },
      errors: [{ path: "Dockerfile", line: 1, messageIncludes: "`go build` compiles in the final image (line 4)" }],
    },
    {
      name: "npm ci without --omit=dev",
      files: { "apps/web/Dockerfile": "FROM node:22\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\nCMD [\"npm\", \"start\"]\n" },
      errors: [{ path: "apps/web/Dockerfile", line: 1, messageIncludes: "`npm ci` installs devDependencies" }],
    },
    {
      name: "apt build toolchain with version pins on a continuation line",
      files: {
        Dockerfile:
          "# syntax=docker/dockerfile:1\nFROM python:3.13-slim\nRUN apt-get update && \\\n    apt-get install -y gcc=4:12.2.0-3 make git && \\\n    rm -rf /var/lib/apt/lists/*\nRUN pip install -r requirements.txt\n",
      },
      errors: [{ line: 2, messageIncludes: "`gcc`, `make`, `git` (line 4)" }],
    },
    {
      name: "several kinds of evidence are summarized",
      files: {
        Dockerfile:
          "FROM maven:3-eclipse-temurin-21\nRUN apt-get update && apt-get install -y git\nCOPY . .\nRUN mvn -B package\nRUN yarn install\nRUN dotnet publish\n",
      },
      errors: [{ line: 1, messageIncludes: "and 1 more" }],
    },
  ],
});
