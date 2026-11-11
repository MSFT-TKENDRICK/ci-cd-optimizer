import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  boundJobLog, fetchJobLog, normalizeLogLines, parseCacheSpec, parseJobLog, vertexKind, type BuildInvocation,
} from "../../src/telemetry/logs.js";
import { fakeClient, httpError, repo } from "../experiments/fixtures.js";

const BASE = Date.UTC(2026, 0, 1);
const log = (entries: ReadonlyArray<readonly [number, string]>): string =>
  entries.map(([ms, text]) => `${new Date(BASE + ms).toISOString()} ${text}`).join("\n");
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const vertex = (build: BuildInvocation | undefined, id: number) => build?.vertices.find((candidate) => candidate.id === id);

describe("sanitized CI job logs", () => {
  it("explains the container smoke job: service startup, buildx boot, the BuildKit build and post-job teardown", () => {
    const evidence = parseJobLog(fixture("ci-app-job.log"));

    expect(evidence.lines).toBe(605);
    expect(evidence.setup.durationMs).toBe(13_719);
    expect(evidence.setup.services).toEqual([expect.objectContaining({
      name: "postgres", image: "postgres:17.6", pulled: true, pullMs: 9663, healthWaitMs: 2039, polls: 1,
    })]);
    expect(evidence.steps.map((step) => step.durationMs)).toEqual([1438, 581, 5795, 58_529, 7406, 26_202]);
    expect(evidence.steps.map((step) => step.kind)).toEqual(["action", "action", "action", "action", "script", "script"]);
    expect(evidence.steps[1]?.toolCache).toBe("hit");

    const boot = evidence.steps[2]?.builds;
    expect(boot).toHaveLength(1);
    expect(boot?.[0]?.vertices).toEqual([expect.objectContaining({ id: 1, kind: "builder-boot", durationMs: 500 })]);

    const step = evidence.steps[3];
    expect(step?.uses).toMatch(/^docker\/build-push-action@/);
    expect(step?.inputs["cache-to"]).toBe("type=gha,mode=max,scope=ci-smoke");
    expect(step?.builds).toHaveLength(1);
    const build = step?.builds[0];
    expect(build).toMatchObject({
      driver: "docker-container", load: true, push: false,
      cacheFrom: [{ type: "gha", scope: "ci-smoke" }],
      cacheTo: [{ type: "gha", mode: "max", scope: "ci-smoke" }],
    });
    expect(build?.vertices).toHaveLength(27);
    expect(vertex(build, 21)).toMatchObject({ kind: "run", durationMs: 9400 });
    expect(vertex(build, 15)).toMatchObject({ kind: "run", durationMs: 11_000 });
    expect(vertex(build, 13)).toMatchObject({ cached: true, durationMs: 3100 });
    expect(vertex(build, 24)).toMatchObject({
      kind: "image-export", durationMs: 7500,
      operations: [{ name: "exporting layers", durationMs: 2500 }, { name: "sending tarball", durationMs: 5000 }],
    });
    expect(vertex(build, 25)).toMatchObject({ kind: "image-load", durationMs: 4700 });
    expect(vertex(build, 26)).toMatchObject({
      kind: "cache-export", durationMs: 22_500,
      operations: [
        { name: "preparing build cache for export", durationMs: 11_200 },
        { name: "sending cache export", durationMs: 11_300 },
      ],
    });

    expect(evidence.repeatedCommands).toEqual([
      { command: "node test/service/container-smoke.mjs", steps: [4, 5], durationsMs: [7406, 26_202] },
    ]);
    expect(evidence.steps[5]?.envKeys).toEqual(["SMOKE_DATABASE_URL", "SMOKE_DATABASE_CONTAINER"]);
    expect(evidence.post.durationMs).toBe(8407);
    expect(evidence.post.subGroups).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Removing builder", durationMs: 5892 }),
      expect.objectContaining({ title: "Generating build summary", durationMs: 1352 }),
    ]));
    expect(evidence.post.cacheSaveFailures).toEqual([]);
    expect(evidence.truncated).toBe(false);
  });

  it("explains the test job: composite setup, the npm cache miss, test runner summaries and the failed cache save", () => {
    const evidence = parseJobLog(fixture("ci-test-job.log"));

    expect(evidence.lines).toBe(193);
    expect(evidence.setup).toEqual({ durationMs: 675, services: [] });
    expect(evidence.steps.map((step) => [step.title, step.durationMs])).toEqual([
      [expect.stringMatching(/^Run actions\/checkout@/), 2110],
      ["Run ./.github/actions/setup", 11_353],
      ["Run npm test", 56_812],
    ]);
    const [setupNode, install] = evidence.steps[1]?.children ?? [];
    expect(setupNode).toMatchObject({ kind: "action", durationMs: 3066, toolCache: "hit", packageCache: "miss" });
    expect(setupNode?.uses).toMatch(/^actions\/setup-node@/);
    expect(install).toMatchObject({ kind: "script", command: "npm ci --no-audit --no-fund", durationMs: 8275, installedPackages: 418 });
    expect(evidence.steps[2]?.tests).toEqual([
      { framework: "node-test", tests: 85, durationMs: 4353, phases: {} },
      {
        framework: "vitest", files: 237, tests: 3994, durationMs: 51_810,
        phases: { tests: 59, import: 25, environment: 8, transform: 6, setup: 2, worker: 1 },
      },
    ]);
    expect(evidence.post.durationMs).toBe(812);
    expect(evidence.post.subGroups).toEqual([expect.objectContaining({ title: expect.stringMatching(/^Post Run actions\/setup-node@/), durationMs: 553 })]);
    expect(evidence.post.cacheSaveFailures).toEqual([expect.stringMatching(/^Unable to reserve cache with key node-cache-Linux-x64-npm-/)]);
    expect(evidence.repeatedCommands).toEqual([]);
  });
});

describe("normalizeLogLines", () => {
  it("accepts API and `gh run view --log` lines, strips BOM, CR and colour escapes, and drops untimestamped lines", () => {
    const lines = normalizeLogLines([
      "\uFEFF2026-01-01T00:00:01.1234567Z \u001b[32mhello\u001b[0m\r",
      "app\tBuild\t2026-01-01T00:00:02Z ^[[1mbold^[[22m",
      "continuation without a timestamp",
      "2026-01-01T00:00:03.5Z",
    ].join("\n"));
    expect(lines).toEqual([
      { ms: BASE + 1123, text: "hello" },
      { ms: BASE + 2000, text: "bold" },
      { ms: BASE + 3500, text: "" },
    ]);
  });
});

describe("boundJobLog", () => {
  it("keeps whole lines within the byte budget", () => {
    expect(boundJobLog("aaa\nbbb\nccc", 9)).toEqual({ text: "aaa\nbbb", truncated: true, bytes: 11 });
    expect(boundJobLog("abcdef", 3)).toEqual({ text: "abc", truncated: true, bytes: 6 });
    expect(boundJobLog("aaa\nbbb", 100)).toEqual({ text: "aaa\nbbb", truncated: false, bytes: 7 });
  });

  it("keeps at most the line budget", () => {
    expect(boundJobLog("a\nb\nc", 100, 2)).toEqual({ text: "a\nb", truncated: true, bytes: 5 });
    expect(boundJobLog("a\nb", 100, 2)).toEqual({ text: "a\nb", truncated: false, bytes: 3 });
  });

  it("decodes binary bodies and rejects anything that is not text", () => {
    const bytes = new TextEncoder().encode("é\nok");
    expect(boundJobLog(bytes)).toEqual({ text: "é\nok", truncated: false, bytes: 5 });
    expect(boundJobLog(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).toEqual({ text: "é\nok", truncated: false, bytes: 5 });
    expect(() => boundJobLog({ message: "not a log" })).toThrow(/not text/);
  });
});

describe("fetchJobLog", () => {
  it("requests the job's log and bounds it", async () => {
    const client = fakeClient(() => "a\nb\nc");
    await expect(fetchJobLog(client, repo, 7, { maxLines: 2 })).resolves.toEqual({ text: "a\nb", truncated: true, bytes: 5 });
    expect(client.calls).toEqual([{ route: "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", parameters: { ...repo, job_id: 7 } }]);
  });

  it("treats expired logs as absent and surfaces every other failure", async () => {
    for (const status of [404, 410]) {
      await expect(fetchJobLog(fakeClient(() => { throw httpError(status); }), repo, 7)).resolves.toBeUndefined();
    }
    await expect(fetchJobLog(fakeClient(() => { throw httpError(500); }), repo, 7)).rejects.toThrow("HTTP 500");
  });
});

describe("parseCacheSpec and vertexKind", () => {
  it("parses BuildKit cache specs without losing unrecognised keys from the raw value", () => {
    expect(parseCacheSpec(" type=registry,ref=ghcr.io/acme/app:cache=v1,mode=max ")).toEqual({
      raw: "type=registry,ref=ghcr.io/acme/app:cache=v1,mode=max", type: "registry", mode: "max",
    });
    expect(parseCacheSpec("type=gha,scope=app")).toEqual({ raw: "type=gha,scope=app", type: "gha", scope: "app" });
  });

  it.each([
    ["importing cache manifest from gha:123", "cache-import"],
    ["exporting to GitHub Actions Cache", "cache-export"],
    ["exporting cache to registry", "cache-export"],
    ["exporting to docker image format", "image-export"],
    ["exporting to image", "image-export"],
    ["importing to docker", "image-load"],
    ["pushing layers", "push"],
    ["[build 3/7] RUN npm ci", "run"],
    ["[build 4/7] COPY . .", "copy"],
    ["[runtime 1/2] FROM docker.io/library/node:22@sha256:abc", "base-image"],
    ["[internal] load build definition from Dockerfile", "internal"],
    ["resolve image config for docker-image://docker.io/docker/dockerfile:1", "internal"],
    ["booting buildkit", "builder-boot"],
    ["[build 2/7] WORKDIR /app", "other"],
  ])("classifies %s as %s", (name, kind) => {
    expect(vertexKind(name)).toBe(kind);
  });
});

describe("parseJobLog builds", () => {
  it("attributes BuildKit output to the build a script declared, ignoring reprinted vertices and RUN output", () => {
    const evidence = parseJobLog(log([
      [0, "Current runner version: '2.330.0'"],
      [100, "##[group]Run docker buildx build \\"],
      [100, "docker buildx build \\"],
      [100, "  --cache-from \"type=gha,scope=app\" \\"],
      [100, "  --cache-to=type=gha,mode=max,scope=app --load ."],
      [100, "shell: /usr/bin/bash -e {0}"],
      [100, "##[endgroup]"],
      [1000, "#0 building with \"builder\" instance using docker-container driver"],
      [1000, "#1 [internal] load build definition from Dockerfile"],
      [1100, "#1 DONE 0.1s"],
      [1200, "#2 [build 1/2] RUN npm ci"],
      [1300, "#2 0.512 compiled 1.0s done"],
      [3200, "#2 DONE 2.0s"],
      [3300, "#3 exporting to GitHub Actions Cache"],
      [3300, "#3 preparing build cache for export"],
      [3400, "#3 sha256:abc 1.2MB / 1.2MB 0.1s done"],
      [5300, "#3 preparing build cache for export 2.0s done"],
      [5300, "#3 DONE 2.0s"],
      [5400, "#2 [build 1/2] RUN npm ci"],
      [5500, "#2 DONE 2.1s"],
    ]));
    const builds = evidence.steps[0]?.builds ?? [];
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({
      startMs: BASE + 100, driver: "docker-container", load: true, push: false,
      cacheFrom: [{ type: "gha", scope: "app" }], cacheTo: [{ type: "gha", mode: "max", scope: "app" }],
    });
    expect(builds[0]?.vertices.map((item) => [item.id, item.kind, item.durationMs])).toEqual([
      [1, "internal", 100], [2, "run", 2100], [3, "cache-export", 2000],
    ]);
    expect(vertex(builds[0], 2)?.operations).toEqual([]);
    expect(vertex(builds[0], 3)?.operations).toEqual([{ name: "preparing build cache for export", durationMs: 2000 }]);
    expect(vertex(builds[0], 2)?.lastMs).toBe(BASE + 5500);
  });

  it("starts a new build on a `#0` banner or a restarted build definition, and fills declared builds in order", () => {
    const evidence = parseJobLog(log([
      [0, "##[group]Run docker buildx build --cache-to type=gha,mode=min .; docker build -o type=registry,push=true ."],
      [0, "docker buildx build --cache-to type=gha,mode=min ."],
      [0, "docker build -o type=registry,push=true ."],
      [0, "shell: /usr/bin/bash -e {0}"],
      [0, "##[endgroup]"],
      [100, "#1 [internal] load build definition from Dockerfile"],
      [200, "#2 [build 1/1] RUN make"],
      [300, "#2 ERROR: process \"/bin/sh -c make\" did not complete successfully"],
      [400, "#1 [internal] load build definition from Dockerfile"],
      [500, "#2 [build 1/1] COPY . ."],
      [600, "#2 CACHED"],
      [700, "#0 building with \"default\" instance using docker driver"],
      [800, "#1 [internal] load .dockerignore"],
      [900, "##[group]Run docker/build-push-action@v6"],
      [900, "with:"],
      [900, "  context: ."],
      [900, "##[endgroup]"],
      [1000, "##[command]/usr/bin/docker buildx build --output type=docker,dest=- --tag app ."],
      [1100, "#1 [internal] load build definition from Dockerfile"],
      [1200, "#1 DONE 0.0s"],
    ]));
    const [script, action] = evidence.steps;
    expect(script?.builds.map((build) => [build.cacheTo.map((spec) => spec.mode), build.push, build.driver, build.vertices.length])).toEqual([
      [["min"], false, undefined, 2],
      [[], true, undefined, 2],
      [[], false, "docker", 1],
    ]);
    expect(vertex(script?.builds[0], 2)).toMatchObject({ kind: "run", error: true });
    expect(vertex(script?.builds[1], 2)).toMatchObject({ kind: "copy", cached: true });
    expect(action?.builds).toEqual([expect.objectContaining({ load: true, push: false, vertices: [expect.objectContaining({ id: 1, durationMs: 0 })] })]);
  });

  it("drops builds a script declared but never ran", () => {
    const evidence = parseJobLog(log([
      [0, "##[group]Run if false; then docker build .; fi"],
      [0, "if false; then docker build .; fi"],
      [0, "shell: /usr/bin/bash -e {0}"],
      [0, "##[endgroup]"],
      [100, "done"],
    ]));
    expect(evidence.steps[0]?.builds).toEqual([]);
  });
});

describe("parseJobLog structure", () => {
  it("measures service pulls and health polling during job setup", () => {
    const evidence = parseJobLog(log([
      [0, "Current runner version: '2.330.0'"],
      [50, "##[group]Starting job container"],
      [80, "##[endgroup]"],
      [100, "##[group]Starting redis service container"],
      [100, "##[command]/usr/bin/docker pull redis:7"],
      [1100, "Status: Image is up to date for redis:7"],
      [1200, "##[endgroup]"],
      [1300, "##[group]Waiting for all services to be ready"],
      [1300, "redis service is starting, waiting 2 seconds before checking again."],
      [3300, "redis service is starting, waiting 4 seconds before checking again."],
      [7300, "redis service is healthy."],
      [7300, "##[endgroup]"],
      [7400, "##[group]Run echo ok"],
      [7400, "echo ok"],
      [7400, "shell: /usr/bin/bash -e {0}"],
      [7400, "##[endgroup]"],
      [7500, "ok"],
    ]));
    expect(evidence.setup.durationMs).toBe(7400);
    expect(evidence.setup.services).toEqual([
      { name: "job", startMs: BASE + 50, endMs: BASE + 80, polls: 0 },
      { name: "redis", image: "redis:7", startMs: BASE + 100, endMs: BASE + 1200, pulled: false, pullMs: 1000, healthWaitMs: 6000, polls: 2 },
    ]);
  });

  it("separates action inputs, environment, composite children and post-job work", () => {
    const evidence = parseJobLog(log([
      [0, "Current runner version: '2.330.0'"],
      [500, "##[group]Run actions/checkout@v4"],
      [500, "with:"],
      [500, "  repository: acme/widgets"],
      [500, "  sparse-checkout: |"],
      [500, "    src"],
      [500, "    test"],
      [500, "env:"],
      [500, "  CI: true"],
      [500, "##[endgroup]"],
      [1500, "##[group]Run ./.github/actions/setup"],
      [1500, "##[endgroup]"],
      [1500, "##[start-action display=Run actions/setup-node@v4;id=__self.__actions_setup-node]"],
      [1500, "##[group]Run actions/setup-node@v4"],
      [1500, "with:"],
      [1500, "  node-version: 22"],
      [1500, "##[endgroup]"],
      [1600, "Attempting to download 22.x..."],
      [1800, "npm cache is not found"],
      [2000, "##[end-action id=__self.__actions_setup-node;outcome=success;conclusion=success;duration_ms=420]"],
      [2000, "##[start-action display=Run npm ci;id=__self.__run]"],
      [2000, "##[group]Run npm ci"],
      [2000, "npm ci"],
      [2000, "shell: /usr/bin/bash -e {0}"],
      [2000, "##[endgroup]"],
      [2100, "Cache restored from key: npm-abc"],
      [5000, "added 12 packages, and audited 13 packages in 3s"],
      [5000, "##[end-action id=__self.__run;outcome=success;conclusion=success;duration_ms=3000]"],
      [6000, "Post job cleanup."],
      [6000, "##[start-action display=Run actions/setup-node@v4;id=__post.setup-node]"],
      [6400, "##[end-action id=__post.setup-node;outcome=success;conclusion=success;duration_ms=400]"],
      [6500, "##[group]Removing builder"],
      [7500, "##[endgroup]"],
      [7600, "Failed to save: Unable to reserve cache with key npm-abc, another job may be creating this cache."],
      [8000, "Cleaning up orphan processes"],
    ]));
    expect(evidence.setup.durationMs).toBe(500);
    const [checkout, setup] = evidence.steps;
    expect(checkout).toMatchObject({
      kind: "action", uses: "actions/checkout@v4", durationMs: 1000, envKeys: ["CI"],
      inputs: { repository: "acme/widgets", "sparse-checkout": "|\nsrc\ntest" },
    });
    expect(setup).toMatchObject({ kind: "action", uses: "./.github/actions/setup", durationMs: 4500 });
    expect(setup?.children).toEqual([
      expect.objectContaining({ index: 0, uses: "actions/setup-node@v4", inputs: { "node-version": "22" }, durationMs: 420, toolCache: "download", packageCache: "miss" }),
      expect.objectContaining({ index: 1, kind: "script", command: "npm ci", durationMs: 3000, packageCache: "hit", installedPackages: 12 }),
    ]);
    expect(evidence.post).toEqual({
      startMs: BASE + 6000, durationMs: 2000,
      subGroups: [
        { title: "Post Run actions/setup-node@v4", startMs: BASE + 6000, endMs: BASE + 6400, durationMs: 400 },
        { title: "Removing builder", startMs: BASE + 6500, endMs: BASE + 7500, durationMs: 1000 },
      ],
      cacheSaveFailures: ["Unable to reserve cache with key npm-abc, another job may be creating this cache."],
    });
  });

  it("reads Jest, node:test, pytest and Vitest summaries", () => {
    const evidence = parseJobLog(log([
      [0, "##[group]Run npm test"],
      [0, "npm test"],
      [0, "shell: /usr/bin/bash -e {0}"],
      [0, "##[endgroup]"],
      [100, "Test Suites: 1 failed, 11 passed, 12 total"],
      [100, "Tests:       2 failed, 100 passed, 102 total"],
      [100, "Time:        12.5 s"],
      [200, "ℹ tests 5"],
      [200, "ℹ duration_ms 812.4"],
      [300, "===== 10 passed, 2 failed, 1 skipped in 3.21s ====="],
      [400, " Test Files  3 passed (3)"],
      [400, "      Tests  9 passed (9)"],
      [400, "   Duration  850ms (transform 10%, tests 80%)"],
    ]));
    expect(evidence.steps[0]?.tests).toEqual([
      { framework: "jest", files: 12, tests: 102, durationMs: 12_500, phases: {} },
      { framework: "node-test", tests: 5, durationMs: 812, phases: {} },
      { framework: "pytest", tests: 13, durationMs: 3210, phases: {} },
      { framework: "vitest", files: 3, tests: 9, durationMs: 850, phases: { transform: 10, tests: 80 } },
    ]);
  });

  it("reports scripts that run the same command in more than one step", () => {
    const step = (ms: number, title: string, body: string[]): Array<[number, string]> =>
      [[ms, `##[group]Run ${title}`], ...body.map((line): [number, string] => [ms, line]), [ms, "##[endgroup]"]];
    const script = (ms: number, command: string) => step(ms, command, [command, "shell: /usr/bin/bash -e {0}"]);
    const evidence = parseJobLog(log([
      ...script(0, "npm test"),
      ...step(1000, "actions/cache@v4", ["with:", "  path: x"]),
      ...script(3000, "npm   test"),
      ...step(3500, "actions/cache@v4", ["with:", "  path: x"]),
      [4000, "Post job cleanup."],
    ]));
    expect(evidence.repeatedCommands).toEqual([{ command: "npm test", steps: [0, 2], durationsMs: [1000, 500] }]);
  });

  it("finishes open steps at the end of a truncated log and bounds free text", () => {
    const title = `Run ${"x".repeat(300)}`;
    const evidence = parseJobLog(log([
      [0, `##[group]${title}`],
      [0, "##[endgroup]"],
      [2500, "still running"],
    ]), { truncated: true });
    expect(evidence.truncated).toBe(true);
    expect(evidence.steps[0]?.durationMs).toBe(2500);
    expect(evidence.steps[0]?.title).toHaveLength(200);
    expect(evidence.steps[0]?.title.endsWith("…")).toBe(true);
    expect(evidence.post).toEqual({ durationMs: 0, subGroups: [], cacheSaveFailures: [] });
    expect(parseJobLog("")).toMatchObject({ lines: 0, steps: [], setup: { durationMs: 0, services: [] } });
  });
});
