import rule from "../../../../src/lint/rules/containers/docker-no-cache-build.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const job = (runsOn: string, on: string[], ...steps: string[]): string =>
  yml(...on, "jobs:", "  image:", `    runs-on: ${runsOn}`, "    steps:", ...steps);

const workflow = (on: string[], ...steps: string[]): string => job("ubuntu-24.04", on, ...steps);

ruleTester(rule, {
  valid: [
    {
      name: "scheduled clean rebuild that imports a cache",
      files: workflow(
        ["on:", "  schedule:", '    - cron: "0 4 * * 1"'],
        "      - run: docker build --pull --no-cache --cache-from type=gha -t app .",
      ),
    },
    {
      name: "manually dispatched rebuild",
      files: workflow(["on: workflow_dispatch"], "      - run: docker buildx build --no-cache --cache-from type=gha -t app ."),
    },
    {
      name: "release build on tag pushes",
      files: workflow(["on:", "  push:", "    tags: ['v*']"], "      - run: docker build --no-cache --cache-from myorg/app:cache -t app ."),
    },
    {
      name: "--no-cache-filter rebuilds one stage only",
      files: workflow(["on: pull_request"], "      - run: docker buildx build --no-cache-filter deps --cache-from type=gha -t app ."),
    },
    {
      name: "no-cache step guarded by a schedule condition",
      files: workflow(
        ["on:", "  push:", "  schedule:", '    - cron: "0 4 * * 1"'],
        "      - if: github.event_name == 'schedule'",
        "        uses: docker/build-push-action@v7",
        "        with:",
        "          cache-from: type=gha",
        "          no-cache: true",
      ),
    },
    {
      name: "build-push-action with no-cache false",
      files: workflow(
        ["on: pull_request"],
        "      - uses: docker/build-push-action@v7",
        "        with:",
        "          cache-from: type=gha",
        "          no-cache: false",
      ),
    },
    {
      name: "--no-cache of another tool",
      files: workflow(["on: pull_request"], "      - run: pip install --no-cache-dir -r requirements.txt", "      - run: apk add --no-cache curl"),
    },
    {
      name: "hosted runner with an ephemeral buildx builder and no cache import: nothing to discard",
      files: workflow(
        ["on: [push, pull_request]"],
        "      - uses: docker/setup-buildx-action@v4",
        "      - uses: docker/build-push-action@v7",
        "        with:",
        "          push: false",
        "          no-cache: true",
      ),
    },
    {
      name: "hosted docker build --no-cache without --cache-from: fresh VM, empty cache",
      files: workflow(["on: pull_request"], "      - run: docker build --no-cache -t app ."),
    },
    {
      name: "self-hosted job whose setup-buildx builder is removed at job end",
      files: job(
        "[self-hosted, linux]",
        ["on: pull_request"],
        "      - uses: docker/setup-buildx-action@v4",
        "      - uses: docker/build-push-action@v7",
        "        with:",
        "          no-cache: true",
      ),
    },
  ],
  invalid: [
    {
      name: "build-push-action no-cache that discards its gha cache import",
      files: workflow(
        ["on: pull_request"],
        "      - uses: docker/setup-buildx-action@v4",
        "      - uses: docker/build-push-action@v7",
        "        with:",
        "          push: false",
        "          cache-from: type=gha",
        "          cache-to: type=gha,mode=max",
        "          no-cache: true",
      ),
      errors: [
        {
          line: 12,
          messageIncludes:
            "`no-cache: true` on docker/build-push-action in a workflow triggered by pull_request discards the cache it imports (`type=gha`)",
        },
      ],
    },
    {
      name: "docker build --no-cache --cache-from on branch pushes",
      files: workflow(["on:", "  push:", "    branches: [main]"], "      - run: docker build --no-cache --cache-from myorg/app:cache -t app ."),
      errors: [
        {
          line: 8,
          messageIncludes: "`docker build --no-cache` in a workflow triggered by push discards the cache it imports (`myorg/app:cache`)",
        },
      ],
    },
    {
      name: "docker buildx build --no-cache with a registry cache in a multi-line script",
      files: workflow(
        ["on: [push, pull_request]"],
        "      - run: |",
        "          docker buildx build \\",
        "            --no-cache \\",
        "            --cache-from type=registry,ref=ghcr.io/o/app:cache \\",
        "            -t app .",
      ),
      errors: [
        {
          line: 7,
          messageIncludes:
            "`docker buildx build --no-cache` in a workflow triggered by push/pull_request discards the cache it imports (`type=registry,ref=ghcr.io/o/app:cache`)",
        },
      ],
    },
    {
      name: "docker compose build --no-cache on a self-hosted runner",
      files: job("[self-hosted, linux]", ["on: merge_group"], "      - run: docker compose build --no-cache api"),
      errors: [{ line: 6, messageIncludes: "`docker compose build --no-cache` in a workflow triggered by merge_group ignores the self-hosted runner's persistent layer cache" }],
    },
    {
      name: "self-hosted setup-buildx builder kept between jobs",
      files: job(
        "self-hosted",
        ["on: push"],
        "      - uses: docker/setup-buildx-action@v4",
        "        with:",
        "          keep-state: true",
        "      - uses: docker/build-push-action@v7",
        "        with:",
        "          no-cache: true",
      ),
      errors: [{ line: 11, messageIncludes: "ignores the self-hosted runner's persistent layer cache" }],
    },
  ],
});
