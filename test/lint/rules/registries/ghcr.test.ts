import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/registries/ghcr.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const workflow = (steps: string, permissions = "") =>
  `name: release\non: push\n${permissions}jobs:\n  image:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;

const ghcrLogin = `      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
`;

ruleTester(rule, {
  valid: [
    {
      name: "pushes to GHCR",
      files: workflow(`${ghcrLogin}      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/\${{ github.repository_owner }}/api:latest
`),
    },
    {
      name: "push is an expression",
      files: workflow(`      - uses: docker/build-push-action@v6
        with:
          push: \${{ github.event_name != 'pull_request' }}
          tags: acme/api:latest
`),
    },
    {
      name: "build only, no push",
      files: workflow(`      - uses: docker/build-push-action@v6
        with:
          push: false
          load: true
          tags: acme/api:test
      - run: docker build -t acme/api:ci .
`),
    },
    {
      name: "tags from an unknown expression",
      files: workflow(`      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: \${{ env.IMAGE }}:latest
`),
    },
    {
      name: "Docker Hub login only used for pulls in a job that pushes to GHCR",
      files: workflow(`      - uses: docker/login-action@v3
        with:
          username: \${{ secrets.DOCKERHUB_USER }}
          password: \${{ secrets.DOCKERHUB_TOKEN }}
${ghcrLogin}      - run: docker push ghcr.io/acme/api:\${{ github.sha }}
`),
    },
    {
      name: "local registry for tests",
      files: workflow(`      - run: docker push localhost:5000/api:test
`),
    },
    {
      name: "Docker Hub base images without any GHCR publishing",
      files: { "Dockerfile": "FROM node:22\n", ".github/workflows/ci.yml": workflow("      - run: npm test\n") },
    },
  ],
  invalid: [
    {
      name: "build-push-action tags on Docker Hub and ECR",
      files: workflow(`      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: |
            acme/api:latest
            ghcr.io/acme/api:latest
            123456789012.dkr.ecr.us-east-1.amazonaws.com/api:latest
`),
      errors: [
        { line: 11, messageIncludes: "`docker/build-push-action` pushes `acme/api:latest` to Docker Hub" },
        { line: 13, messageIncludes: "to `123456789012.dkr.ecr.us-east-1.amazonaws.com`" },
      ],
    },
    {
      name: "metadata-action images resolved through steps.meta.outputs.tags",
      files: workflow(`      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: |
            name=docker.io/acme/web
            name=ghcr.io/acme/web,enable=true
            name=quay.io/acme/web,enable=false
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: \${{ steps.meta.outputs.tags }}
`),
      errors: [{ line: 11, messageIncludes: "`docker/metadata-action` images pushes `docker.io/acme/web` to Docker Hub" }],
    },
    {
      name: "docker push and buildx --push commands",
      files: workflow(`      - run: |
          docker build -t acme/worker:\${{ github.sha }} .
          docker push acme/worker:\${{ github.sha }}
          docker buildx build --push --tag=registry.example.com/team/worker:1 .
`),
      errors: [
        { line: 9, messageIncludes: "`docker push` pushes `acme/worker:${{ github.sha }}` to Docker Hub" },
        { line: 10, messageIncludes: "to `registry.example.com`" },
      ],
    },
    {
      name: "login-action to Docker Hub when the pushed tags are dynamic",
      files: workflow(`      - uses: docker/login-action@v3
        with:
          username: \${{ secrets.DOCKERHUB_USER }}
          password: \${{ secrets.DOCKERHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: \${{ env.IMAGE }}
`),
      errors: [{ line: 7, messageIncludes: "Job `image` pushes images after logging in to Docker Hub" }],
    },
    {
      name: "push inside a local composite action",
      files: {
        ".github/workflows/release.yml": workflow("      - uses: actions/checkout@v5\n      - uses: ./.github/actions/publish\n"),
        ".github/actions/publish/action.yml":
          "name: publish\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: docker push docker.io/acme/cli:latest\n",
      },
      errors: [{ path: ".github/actions/publish/action.yml", line: 6, messageIncludes: "`docker.io/acme/cli:latest`" }],
    },
    {
      name: "Docker Hub base images when the repository publishes to GHCR",
      files: {
        "services/api/Dockerfile": "FROM node:22-slim AS build\nRUN npm ci\nFROM build AS test\nFROM gcr.io/distroless/nodejs22-debian12\nFROM docker.io/library/nginx:1.27\n",
        ".github/workflows/release.yml": workflow(`${ghcrLogin}      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/acme/api:latest
`),
      },
      errors: [
        { path: "services/api/Dockerfile", line: 1, messageIncludes: "Base image `node:22-slim` is pulled from Docker Hub" },
        { path: "services/api/Dockerfile", line: 5, messageIncludes: "`docker.io/library/nginx:1.27`" },
      ],
    },
  ],
});

describe("registries/ghcr suggestions", () => {
  it("suggests the GHCR name, GITHUB_TOKEN, and packages: write", () => {
    const [diagnostic] = runRule(rule, {
      files: workflow(`      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: acme/api:1.2.3
`),
    });
    expect(diagnostic?.suggestion).toContain("`ghcr.io/${{ github.repository_owner }}/api`");
    expect(diagnostic?.suggestion).toContain("secrets.GITHUB_TOKEN");
    expect(diagnostic?.suggestion).toContain("packages: write");
    expect(diagnostic?.severity).toBe("info");
  });

  it("suggests mirroring base images under the publishing owner", () => {
    const [diagnostic] = runRule(rule, {
      files: {
        Dockerfile: "FROM python:3.13-slim\n",
        ".github/workflows/release.yml": workflow("      - run: docker push ghcr.io/acme/app:latest\n"),
      },
    });
    expect(diagnostic?.suggestion).toContain("docker buildx imagetools create -t ghcr.io/acme/python:3.13-slim python:3.13-slim");
  });
});
