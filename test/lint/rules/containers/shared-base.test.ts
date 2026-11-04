import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/containers/shared-base.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const preamble = (packages: string) =>
  `FROM node:22-slim\nRUN apt-get update && apt-get install -y --no-install-recommends ${packages} && rm -rf /var/lib/apt/lists/*\nRUN npm install -g pnpm@10\nWORKDIR /app\nCOPY . .\nRUN pnpm install --frozen-lockfile\n`;

ruleTester(rule, {
  valid: [
    {
      name: "only two Dockerfiles share the preamble",
      files: { "a/Dockerfile": preamble("git python3"), "b/Dockerfile": preamble("git python3") },
    },
    {
      name: "same base image but different toolchains",
      files: {
        "a/Dockerfile": preamble("git"),
        "b/Dockerfile": preamble("python3"),
        "c/Dockerfile": preamble("make"),
      },
    },
    {
      name: "services already use a shared base without a preamble",
      files: {
        "a/Dockerfile": "FROM ghcr.io/acme/node-base@sha256:abc\nCOPY . .\n",
        "b/Dockerfile": "FROM ghcr.io/acme/node-base@sha256:abc\nCOPY . .\n",
        "c/Dockerfile": "FROM ghcr.io/acme/node-base@sha256:abc\nCOPY . .\n",
      },
    },
    {
      name: "minDockerfiles option raises the threshold",
      files: { "a/Dockerfile": preamble("git"), "b/Dockerfile": preamble("git"), "c/Dockerfile": preamble("git") },
      options: { minDockerfiles: 4 },
    },
    {
      name: "only project dependency installs are repeated",
      files: {
        "a/Dockerfile": "FROM node:22\nCOPY package.json ./\nRUN npm ci\n",
        "b/Dockerfile": "FROM node:22\nCOPY package.json ./\nRUN npm ci\n",
        "c/Dockerfile": "FROM node:22\nCOPY package.json ./\nRUN npm ci\n",
      },
    },
    {
      name: "requires a complete inventory",
      files: { "a/Dockerfile": preamble("git"), "b/Dockerfile": preamble("git"), "c/Dockerfile": preamble("git") },
      mode: "files",
    },
  ],
  invalid: [
    {
      name: "three services with an equivalent preamble in different spelling",
      files: {
        "services/c/Dockerfile": preamble("python3 git"),
        "services/a/Dockerfile": preamble("git python3"),
        "services/b/Dockerfile":
          "FROM node:22-slim\nRUN apt-get update \\\n && apt-get install -y --no-install-recommends python3 git \\\n && rm -rf /var/lib/apt/lists/*\nRUN npm install -g pnpm@10\nCOPY . .\n",
      },
      errors: [{ path: "services/a/Dockerfile", line: 1, messageIncludes: "3 Dockerfiles start from `node:22-slim`" }],
    },
    {
      name: "minDockerfiles: 2",
      files: { "a/Dockerfile": "FROM python:3.13\nRUN pip install poetry==1.8.3\n", "b/Dockerfile": "FROM python:3.13\nRUN pip install poetry==1.8.3\n" },
      options: { minDockerfiles: 2 },
      errors: [{ path: "a/Dockerfile", line: 1, messageIncludes: "`pip install poetry==1.8.3`" }],
    },
    {
      name: "shared builder stage preamble in multi-stage Dockerfiles",
      files: {
        "x/Dockerfile": "FROM golang:1.23 AS build\nRUN apk add --no-cache git\nCOPY . .\nFROM scratch\nCOPY --from=build /out /\n",
        "y/Dockerfile": "FROM golang:1.23 AS build\nRUN apk add --no-cache git\nCOPY . .\nFROM scratch\nCOPY --from=build /out /\n",
        "z/Dockerfile": "# syntax=docker/dockerfile:1\nFROM golang:1.23 AS build\nRUN apk add git --no-cache\n",
      },
      errors: [{ path: "x/Dockerfile", line: 1, messageIncludes: "`apk: git`" }],
    },
  ],
});

describe("containers/shared-base details", () => {
  it("points at the other Dockerfiles and suggests a GHCR base by digest", () => {
    const [diagnostic] = runRule(rule, {
      files: { "a/Dockerfile": preamble("git"), "b/Dockerfile": preamble("git"), "c/Dockerfile": preamble("git") },
    });
    expect(diagnostic?.related).toEqual([
      { path: "b/Dockerfile", line: 1 },
      { path: "c/Dockerfile", line: 1 },
    ]);
    expect(diagnostic?.suggestion).toContain("ghcr.io/<org>/node-base@sha256:<digest>");
    expect(diagnostic?.confidence).toBe("medium");
  });
});
