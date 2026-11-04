import rule from "../../../../src/lint/rules/hermeticity/docker-base-digest.js";
import { ruleTester } from "../../rule-tester.js";

const DIGEST = `sha256:${"c".repeat(64)}`;

ruleTester(rule, {
  valid: [
    { name: "tagged base", files: { Dockerfile: "FROM node:22-bookworm-slim\nRUN npm ci\n" } },
    { name: "scratch", files: { Dockerfile: "FROM golang:1.25 AS build\nRUN go build\nFROM scratch\nCOPY --from=build /app /app\n" } },
    { name: "earlier stage names (case-insensitive)", files: { Dockerfile: "FROM node:22 AS Base\nFROM base AS test\nFROM BASE\n" } },
    { name: "ARG-interpolated images are unknown", files: { Dockerfile: "ARG IMAGE=node\nFROM $IMAGE\nFROM ${IMAGE}:latest\n" } },
    { name: "digest pinned", files: { "docker/api.Dockerfile": `FROM --platform=$BUILDPLATFORM node@${DIGEST} AS deps\n` } },
    { name: "requireDigest accepts digests", files: { Dockerfile: `FROM node:22@${DIGEST}\n` }, options: { requireDigest: true } },
  ],
  invalid: [
    { name: "untagged", files: { Dockerfile: "FROM node\nRUN npm ci\n" }, errors: [{ path: "Dockerfile", line: 1, messageIncludes: "has no tag" }] },
    {
      name: "latest in a later stage",
      files: { Dockerfile: "FROM node:22 AS build\nRUN npm ci\nFROM nginx:latest\nCOPY --from=build /app /usr/share/nginx/html\n" },
      errors: [{ line: 3, messageIncludes: "`latest`" }],
    },
    {
      name: "platform flag and registry host",
      files: { "services/api/Dockerfile": "FROM --platform=$BUILDPLATFORM ghcr.io/o/base AS base\n" },
      errors: [{ path: "services/api/Dockerfile", line: 1 }],
    },
    {
      name: "a stage name used before it is defined is an image",
      files: { Dockerfile: "FROM app\nFROM node:22 AS app\n" },
      errors: [{ line: 1 }],
    },
    {
      name: "requireDigest flags tagged bases",
      files: { Dockerfile: "FROM node:22 AS build\nFROM build\nFROM nginx:1.29\n" },
      options: { requireDigest: true },
      errors: [
        { line: 1, messageIncludes: "sha256" },
        { line: 3, messageIncludes: "sha256" },
      ],
    },
  ],
});
