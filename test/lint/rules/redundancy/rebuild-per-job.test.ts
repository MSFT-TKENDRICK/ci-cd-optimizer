import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/redundancy/rebuild-per-job.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const job = (id: string, steps: string, extra = "") => `  ${id}:
    runs-on: ubuntu-24.04
${extra}    steps:
      - uses: actions/checkout@v4
${steps}`;

const workflow = (...jobs: string[]) => `on: push
jobs:
${jobs.join("")}`;

ruleTester(rule, {
  valid: [
    { name: "single build", files: workflow(job("test", "      - run: npm run build\n"), job("lint", "      - run: npm run lint\n")) },
    {
      name: "artifact handoff",
      files: workflow(
        job("build", "      - run: npm run build\n      - uses: actions/upload-artifact@v4\n        with:\n          name: dist\n          path: dist\n"),
        job("e2e", "      - uses: actions/download-artifact@v4\n        with:\n          name: dist\n      - run: npm run build\n", "    needs: build\n"),
      ),
    },
    {
      name: "different runners",
      files: workflow(
        job("linux", "      - run: go build ./...\n"),
        `  windows:
    runs-on: windows-latest
    steps:
      - run: go build ./...
`,
      ),
    },
    {
      name: "matrix job",
      files: workflow(
        job("test", "      - run: cargo build\n", "    strategy:\n      matrix:\n        feature: [a, b]\n"),
        job("bench", "      - run: cargo build\n"),
      ),
    },
    {
      name: "different working directories",
      files: workflow(
        job("web", "      - run: pnpm build\n        working-directory: web\n"),
        job("api", "      - run: pnpm build\n        working-directory: api\n"),
      ),
    },
    {
      name: "different job env",
      files: workflow(
        job("dev", "      - run: npm run build\n", "    env:\n      MODE: dev\n"),
        job("prod", "      - run: npm run build\n", "    env:\n      MODE: prod\n"),
      ),
    },
    {
      name: "non-build commands",
      files: workflow(job("a", "      - run: npm test\n      - run: make test\n"), job("b", "      - run: npm test\n      - run: make test\n")),
    },
    {
      name: "different Dockerfiles across workflows",
      files: {
        ".github/workflows/ci.yml": workflow(job("app", "      - run: docker build -f app/Dockerfile .\n")),
        ".github/workflows/publish.yml": workflow(job("docs", "      - run: docker build -f docs/Dockerfile .\n")),
        "app/Dockerfile": "FROM node:22\nCOPY . .\n",
        "docs/Dockerfile": "FROM node:22\nCOPY . .\n",
      },
    },
    {
      name: "unresolved Dockerfile inputs do not establish reuse",
      files: {
        ".github/workflows/ci.yml": workflow(job("app", "      - run: docker build .\n")),
        ".github/workflows/publish.yml": workflow(job("publish", "      - uses: docker/build-push-action@v6\n        with:\n          file: ${{ inputs.dockerfile }}\n")),
        "Dockerfile": "FROM node:22\nCOPY . .\n",
      },
    },
    {
      name: "multiple container build sites in only one workflow",
      files: {
        ".github/workflows/ci.yml": workflow(job("app", "      - run: docker build .\n"), job("smoke", "      - run: docker build .\n")),
        "Dockerfile": "FROM node:22\nCOPY . .\n",
      },
    },
  ],
  invalid: [
    {
      files: workflow(
        job("test", "      - run: npm ci\n      - run: npm run build\n      - run: npm test\n"),
        job("e2e", "      - run: npm ci\n      - run: npm run build\n      - run: npm run e2e\n"),
      ),
      errors: [{ line: 8, messageIncludes: "test, e2e" }],
    },
    {
      name: "chained build commands",
      files: workflow(
        job("unit", "      - run: ./gradlew clean build --no-daemon\n"),
        job("integration", "      - run: ./gradlew clean build --no-daemon && ./gradlew integrationTest\n"),
        job("docs", "      - run: ./gradlew clean build --no-daemon\n"),
      ),
      errors: [{ messageIncludes: "3 jobs" }],
    },
    {
      name: "make and dotnet",
      files: workflow(
        job("a", "      - run: make\n      - run: dotnet build -c Release\n"),
        job("b", "      - run: make\n      - run: dotnet build -c Release\n"),
      ),
      errors: 2,
    },
  ],
});

describe("cross-workflow container reuse", () => {
  it("reports mixed action and shell build sites without claiming identical artifacts or savings", () => {
    const diagnostics = runRule(rule, {
      files: {
        ".github/workflows/publish.yml": workflow(job("publish", "      - uses: docker/build-push-action@v6\n        with:\n          context: .\n          push: true\n          target: production\n")),
        ".github/workflows/ci.yml": workflow(job("app", "      - run: docker build --target smoke .\n      - run: docker build --target production .\n")),
        "Dockerfile": "FROM node:22 AS smoke\nCOPY . .\nFROM smoke AS production\n",
      },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      path: ".github/workflows/ci.yml",
      line: 7,
      confidence: "low",
      related: [{ path: ".github/workflows/publish.yml", line: 7 }],
    });
    expect(diagnostics[0]?.message).toContain("`Dockerfile` is declared as a build input in 2 workflows");
    expect(diagnostics[0]?.suggestion).toContain("commit, context, target, platform, build arguments");
    expect(diagnostics[0]?.suggestion).toContain("No savings have been measured");
  });
});
