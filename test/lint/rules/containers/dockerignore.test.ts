import rule from "../../../../src/lint/rules/containers/dockerignore.js";
import { ruleTester } from "../../rule-tester.js";

const NODE_DOCKERFILE = "FROM node:22-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\n";
const PACKAGE = '{ "name": "app", "private": true }';

ruleTester(rule, {
  valid: [
    {
      name: "context with a complete .dockerignore",
      files: { Dockerfile: NODE_DOCKERFILE, "package.json": PACKAGE, ".dockerignore": ".git\nnode_modules\ndist\n" },
    },
    {
      name: "Dockerfile-specific ignore file",
      files: { "api/Dockerfile": NODE_DOCKERFILE, "api/Dockerfile.dockerignore": "**/.git\n**/node_modules\n" },
    },
    {
      name: "allowlist style ignore file",
      files: { Dockerfile: NODE_DOCKERFILE, "package.json": PACKAGE, ".dockerignore": "*\n!package*.json\n!src/\n" },
    },
    {
      name: "no build-context copies",
      files: { Dockerfile: "FROM alpine:3.20\nRUN apk add --no-cache curl\n" },
    },
    {
      name: "nested Dockerfile with an ancestor .dockerignore and no known build command is ambiguous",
      files: { "apps/api/Dockerfile": NODE_DOCKERFILE, ".dockerignore": ".git\n" },
    },
    {
      name: "workflow builds from the root context, which has a complete ignore file",
      files: {
        ".github/workflows/ci.yml":
          "on: push\njobs:\n  image:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/build-push-action@v6\n        with:\n          context: .\n          file: apps/api/Dockerfile\n",
        "apps/api/Dockerfile": NODE_DOCKERFILE,
        "apps/api/package.json": PACKAGE,
        ".dockerignore": ".git\n**/node_modules\n",
      },
    },
    {
      name: "absence is not meaningful without a complete inventory",
      files: { Dockerfile: NODE_DOCKERFILE },
      mode: "files",
    },
  ],
  invalid: [
    {
      files: { Dockerfile: NODE_DOCKERFILE, "package.json": PACKAGE },
      errors: [{ path: "Dockerfile", line: 5, messageIncludes: "the repository root has no .dockerignore" }],
    },
    {
      name: "ignore file that misses .git and node_modules",
      files: { "web/Dockerfile": NODE_DOCKERFILE, "web/package.json": PACKAGE, "web/.dockerignore": "dist\n*.log\n" },
      errors: [{ path: "web/.dockerignore", line: 1, messageIncludes: "`.git`, `node_modules`" }],
    },
    {
      name: "negation re-includes .git",
      files: { Dockerfile: "FROM nginx:1.27\nADD . /usr/share/nginx/html\n", ".dockerignore": ".git\n!.git\n" },
      errors: [{ path: ".dockerignore", line: 1, messageIncludes: "`.git`" }],
    },
    {
      name: "build-push-action uses the root context although the ignore file sits next to the Dockerfile",
      files: {
        ".github/workflows/ci.yml":
          "on: push\njobs:\n  image:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/build-push-action@v6\n        with:\n          context: .\n          file: ./services/api/Dockerfile\n",
        "services/api/Dockerfile": "FROM golang:1.23\nCOPY . .\n",
        "services/api/.dockerignore": ".git\n",
      },
      errors: [{ path: "services/api/Dockerfile", line: 2, messageIncludes: "the repository root" }],
    },
    {
      name: "docker build from a composite action with a top-level-only node_modules pattern in a monorepo",
      files: {
        ".github/actions/image/action.yml":
          "name: image\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: docker buildx build -t api:dev -f packages/api/Dockerfile --load .\n",
        "packages/api/Dockerfile": NODE_DOCKERFILE,
        "package.json": '{ "name": "root", "private": true, "workspaces": ["packages/*"] }',
        "packages/api/package.json": PACKAGE,
        ".dockerignore": ".git\nnode_modules\n",
      },
      errors: [{ path: ".dockerignore", line: 1, messageIncludes: "`packages/api/node_modules`" }],
    },
    {
      name: "targeted copies without a .dockerignore",
      files: { "tools/Dockerfile": "FROM python:3.13-slim\nCOPY requirements.txt .\nRUN pip install -r requirements.txt\n" },
      errors: [{ path: "tools/Dockerfile", line: 2, messageIncludes: "`tools` has no .dockerignore" }],
    },
  ],
});
