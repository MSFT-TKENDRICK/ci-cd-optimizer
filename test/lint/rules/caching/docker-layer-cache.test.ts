import rule from "../../../../src/lint/rules/caching/docker-layer-cache.js";
import { ruleTester } from "../../rule-tester.js";

const wf = (body: string) => `on: push\njobs:\n  b:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;
const build = (withBody: string) => `      - uses: docker/build-push-action@v7\n        with:\n          push: true\n${withBody}`;
const GHA = "          cache-from: type=gha\n          cache-to: type=gha,mode=max\n";

ruleTester(rule, {
  valid: [
    { name: "single image with gha cache (default scope is fine)", files: wf(build(GHA)) },
    {
      name: "two images with distinct scopes",
      files: wf(
        build("          cache-from: type=gha,scope=api\n          cache-to: type=gha,mode=max,scope=api\n") +
          build("          cache-from: type=gha,scope=web\n          cache-to: type=gha,mode=max,scope=web\n"),
      ),
    },
    {
      name: "registry cache",
      files: wf(build("          cache-from: type=registry,ref=ghcr.io/o/app:buildcache\n          cache-to: type=registry,ref=ghcr.io/o/app:buildcache,mode=max\n")),
    },
    { name: "explicit no-cache", files: wf(build("          no-cache: true\n")) },
    { name: "docker build with --cache-from", files: wf("      - run: docker buildx build --cache-from type=registry,ref=o/app:cache -t o/app .\n") },
    { name: "docker build --no-cache is deliberate", files: wf("      - run: docker build --no-cache -t o/app .\n") },
    { name: "unrelated docker commands", files: wf("      - run: docker push o/app && docker buildx bake\n") },
  ],
  invalid: [
    {
      name: "no cache inputs",
      files: wf("      - uses: docker/build-push-action@v7\n        with:\n          push: true\n          tags: o/app:latest\n"),
      errors: [{ line: 6, messageIncludes: "without a layer cache" }],
    },
    {
      name: "no with at all",
      files: wf("      - uses: docker/build-push-action@v7\n"),
      errors: [{ line: 6 }],
    },
    {
      name: "two images sharing the default gha scope",
      files: wf(build(GHA) + build("          cache-from: type=gha,scope=web\n          cache-to: type=gha,mode=max,scope=web\n")),
      errors: [{ line: 10, messageIncludes: "scope" }],
    },
    {
      name: "gha scope collisions across workflows",
      files: {
        ".github/workflows/api.yml": wf(build(GHA)),
        ".github/workflows/web.yml": wf(build(GHA)),
      },
      errors: [
        { path: ".github/workflows/api.yml", line: 10 },
        { path: ".github/workflows/web.yml", line: 10 },
      ],
    },
    {
      name: "inline cache",
      files: wf(build("          cache-from: o/app:latest\n          cache-to: type=inline\n")),
      errors: [{ line: 10, messageIncludes: "Inline cache" }],
    },
    {
      name: "docker build without cache",
      files: wf("      - run: |\n          docker build -t o/app .\n          sudo docker buildx build --push -t o/web web\n"),
      errors: [
        { line: 7, messageIncludes: "`docker build`" },
        { line: 8, messageIncludes: "`docker buildx build`" },
      ],
    },
    {
      name: "docker image build in a composite action",
      files: { "action.yml": "runs:\n  using: composite\n  steps:\n    - run: DOCKER_BUILDKIT=1 docker image build .\n      shell: bash\n" },
      errors: [{ path: "action.yml", line: 4 }],
    },
  ],
});
