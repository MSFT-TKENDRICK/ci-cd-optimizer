import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  attributeRun, collectJobLogs, formatMs, isCoverageGap, readyQueueMs, type Bottleneck, type JobLogResult, type RunAttribution,
} from "../../src/telemetry/attribution.js";
import { parseJobLog } from "../../src/telemetry/logs.js";
import type { JobSnapshot, StepSnapshot, WorkflowSnapshot } from "../../src/telemetry/types.js";
import { fakeClient, httpError, repo } from "../experiments/fixtures.js";
import { callsTo, fakeApi } from "../service/api.js";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const APP_LOG = fixture("ci-app-job.log");
const TEST_LOG = fixture("ci-test-job.log");
const LOGS_ROUTE = "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs";

const BUILD = 129971039119;
const TEST = 129971039501;
const POSTGRES = 129971039524;
const APP = 129971039868;

/** `mm:ss` past 16:00 on 2026-11-10 UTC, the day of run 42856555439. */
const at = (time: string): string => `2026-11-10T16:${time}Z`;
const span = (start: string, end: string): number => Date.parse(at(end)) - Date.parse(at(start));

const step = (number: number, name: string, start: string, end: string): StepSnapshot => ({
  number, name, conclusion: "success", startedAt: at(start), completedAt: at(end), durationMs: span(start, end),
});

function job(id: number, key: string, start: string, end: string, extra: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id, key, name: key, conclusion: "success", startedAt: at(start), completedAt: at(end), durationMs: span(start, end),
    needs: [], ...extra,
  };
}

const CHECKOUT = "Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";

// API steps as GitHub reported them: numbers skip around composite and post steps, and the second smoke command is
// reported under its step name rather than its command.
const TEST_STEPS = [
  step(1, "Set up job", "38:30", "38:30"),
  step(2, CHECKOUT, "38:30", "38:32"),
  step(3, "Run ./.github/actions/setup", "38:32", "38:44"),
  step(4, "Run npm test", "38:44", "39:41"),
  step(6, "Post Run ./.github/actions/setup", "39:41", "39:41"),
  step(7, `Post ${CHECKOUT}`, "39:41", "39:41"),
  step(8, "Complete job", "39:41", "39:41"),
];

const APP_STEPS = [
  step(1, "Set up job", "38:29", "38:31"),
  step(2, "Initialize containers", "38:31", "38:43"),
  step(3, CHECKOUT, "38:43", "38:44"),
  step(4, "Run actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1", "38:44", "38:45"),
  step(5, "Run docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069", "38:45", "38:51"),
  step(6, "Run docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc", "38:51", "39:49"),
  step(7, "Run node test/service/container-smoke.mjs", "39:49", "39:57"),
  step(8, "Durable production image", "39:57", "40:23"),
  step(13, "Post Run docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc", "40:23", "40:25"),
  step(14, "Post Run docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069", "40:25", "40:31"),
  step(15, "Stop containers", "40:31", "40:31"),
];

function ciJobs(): JobSnapshot[] {
  return [
    job(BUILD, "build", "38:28", "39:06"),
    job(TEST, "test", "38:29", "39:45", { steps: TEST_STEPS }),
    job(POSTGRES, "postgres", "38:28", "39:03"),
    job(129971039633, "lint", "38:29", "38:55"),
    job(129971039659, "formal", "38:29", "38:57"),
    job(APP, "app", "38:29", "40:33", { steps: APP_STEPS }),
    job(129971039871, "lint-reusable", "38:28", "38:36", { name: "lint-reusable / lint" }),
  ];
}

function snapshot(jobs: JobSnapshot[] = ciJobs()): WorkflowSnapshot {
  const starts = jobs.map((entry) => Date.parse(entry.startedAt));
  const ends = jobs.map((entry) => Date.parse(entry.completedAt));
  return {
    owner: repo.owner, repo: repo.repo, workflowId: 7, workflowName: "CI", path: ".github/workflows/ci.yml",
    runId: 42856555439, runAttempt: 1, headSha: "abc123", branch: "main", event: "push", conclusion: "success",
    createdAt: at("38:27"), startedAt: new Date(Math.min(...starts)).toISOString(),
    completedAt: new Date(Math.max(...ends)).toISOString(), queueMs: 1_000,
    durationMs: Math.max(...ends) - Math.min(...starts), jobs,
  };
}

const ciLogs = (overrides: Array<[number | string, JobLogResult]> = []): Map<number | string, JobLogResult> => new Map([
  [APP, parseJobLog(APP_LOG)],
  [TEST, parseJobLog(TEST_LOG)],
  ...overrides,
]);

const one = (attribution: RunAttribution, category: Bottleneck["category"], jobKey: string): Bottleneck => {
  const found = attribution.bottlenecks.filter((entry) => entry.category === category && entry.jobKey === jobKey);
  expect(found, `${category} in ${jobKey}`).toHaveLength(1);
  return found[0] as Bottleneck;
};

describe("attributeRun on run 42856555439", () => {
  const attribution = attributeRun(snapshot(), ciLogs());

  it("reports generated-artifact rework without claiming the failed job's time is removable", () => {
    const failed = job(1, "build", "38:28", "39:06", { conclusion: "failure" });
    const log = parseJobLog(`${at("38:50")} ##[error]dist-action is stale; run npm run bundle and commit it.`);
    const found = one(attributeRun(snapshot([failed]), new Map([[1, log]])), "generated-artifact-drift", "build");
    expect(found).toMatchObject({ observedMs: 38_000, runnerSavingsBoundMs: 0, elapsedSavingsBoundMs: 0 });
    expect(found.recommendation).toContain("before pushing");
    expect(attributeRun(snapshot([{ ...failed, conclusion: "success" }]), new Map([[1, log]])).bottlenecks).toEqual([]);
  });

  it("identifies queue-contaminated trials without treating dependency waiting as runner work", () => {
    const queued = job(1, "app", "38:29", "39:44", { queuedAt: at("36:06"), queueMs: 143_000 });
    const found = one(attributeRun(snapshot([queued])), "queue-pressure", "app");
    expect(found).toMatchObject({ observedMs: 143_000, runnerSavingsBoundMs: 0, elapsedSavingsBoundMs: 0 });
    expect(found.recommendation).toContain("interleaved");
    const parent = job(2, "build", "36:06", "38:28");
    const dependent = { ...queued, needs: ["build"] };
    expect(readyQueueMs(dependent, [parent, dependent])).toBe(1000);
    expect(attributeRun(snapshot([parent, dependent])).bottlenecks).toEqual([]);
    expect(readyQueueMs(dependent, [dependent])).toBeUndefined();
  });

  it("puts the app job on the critical path with 48 s of headroom over the test job", () => {
    expect(attribution.elapsedMs).toBe(125_000);
    expect(attribution.criticalSlackMs).toBe(0);
    expect(attribution.jobs[0]).toMatchObject({ key: "app", critical: true, slackMs: 0, headroomMs: 48_000, limitedBy: "test" });
    expect(attribution.jobs.find((entry) => entry.key === "test")).toMatchObject({ critical: false, slackMs: 48_000 });
    expect(attribution.jobs.filter((entry) => entry.critical).map((entry) => entry.key)).toEqual(["app"]);
  });

  it("reports the GHA cache export with mode=max on the critical path", () => {
    const found = one(attribution, "cache-export", "app");
    expect(found).toMatchObject({ onCriticalPath: true, observedMs: 22_500, elapsedSavingsBoundMs: 22_500, runnerSavingsBoundMs: 22_500 });
    expect(found.summary).toMatch(/mode=max/);
    expect(found.recommendation).toMatch(/mode=min/);
    expect(found.recommendation).toMatch(/gha-cache-mode-min/);
    expect(attribution.bottlenecks[0]?.id).toBe(found.id);
  });

  it("counts the overlapping image export and Docker import only once", () => {
    const found = one(attribution, "image-load", "app");
    expect(found).toMatchObject({ onCriticalPath: true, observedMs: 7_500, runnerSavingsBoundMs: 7_500 });
    expect(found.elapsedSavingsBoundMs).toBeGreaterThan(0);
    expect(found.summary).toMatch(/load/);
  });

  it.each(["image-load", "cache-export"] as const)("uses non-overlapping elapsed intervals for %s findings and thresholds", (category) => {
    for (const { spans, expectedMs } of [
      { spans: [[0, 7500], [2800, 7500]], expectedMs: 7500 },
      { spans: [[0, 7000], [5000, 9000]], expectedMs: 9000 },
      { spans: [[0, 4000], [6000, 10000]], expectedMs: 8000 },
      { spans: [[0, 2000], [500, 2500]], expectedMs: 2500 },
    ] as const) {
      const evidence = parseJobLog(APP_LOG);
      const build = evidence.steps.flatMap((entry) => entry.builds).find((entry) => entry.load)!;
      const template = build.vertices[0]!;
      const start = Date.parse(at("39:00"));
      build.vertices = spans.map(([from, to], index) => ({
        ...template, id: index + 1,
        kind: category === "cache-export" ? "cache-export" : index === 0 ? "image-export" : "image-load",
        firstMs: start + from, lastMs: start + to, durationMs: to - from, cached: false, operations: [],
      }));
      const result = attributeRun(snapshot(), ciLogs([[APP, evidence]]));
      if (expectedMs < 3000) {
        expect(result.bottlenecks.filter((entry) => entry.category === category)).toEqual([]);
      } else {
        expect(one(result, category, "app")).toMatchObject({
          observedMs: expectedMs, runnerSavingsBoundMs: expectedMs, elapsedSavingsBoundMs: expectedMs,
        });
      }
    }
  });

  it("reports the npm cache miss and the post-job cache save race in the test job", () => {
    const found = one(attribution, "package-cache", "test");
    expect(found).toMatchObject({ onCriticalPath: false, elapsedSavingsBoundMs: 0, observedMs: 8_275, runnerSavingsBoundMs: 8_275 });
    expect(found.summary).toMatch(/418 packages/);
    expect(found.summary).toMatch(/race/);
    expect(found.evidence.join("\n")).toMatch(/Unable to reserve cache with key node-cache-Linux-x64-npm-/);
  });

  it.each([true, false])("does not attribute service failures to cache races (cache miss: %s)", (hasMiss) => {
    const evidence = parseJobLog(hasMiss ? TEST_LOG : APP_LOG);
    evidence.post.cacheSaveFailures = ["Request failed with status code 503"];
    const result = attributeRun(snapshot(), ciLogs([[hasMiss ? TEST : APP, evidence]]));
    const found = one(result, "package-cache", hasMiss ? "test" : "app");

    expect(found.summary).toContain("cache save failed");
    expect(found.summary).not.toMatch(/race|another job|reserving/);
    expect(found.recommendation).not.toMatch(/parallel jobs|only restore/);
    expect(found.evidence).toContain("post-job cache save: Request failed with status code 503");
  });

  it("does not recommend a cache-race fix just because a cache missed", () => {
    const evidence = parseJobLog(TEST_LOG);
    evidence.post.cacheSaveFailures = [];
    const found = one(attributeRun(snapshot(), ciLogs([[TEST, evidence]])), "package-cache", "test");

    expect(found.summary).not.toMatch(/race|another job/);
    expect(found.recommendation).not.toMatch(/parallel jobs|only restore/);
  });

  it("preserves unrelated save errors alongside a possible reservation race", () => {
    const evidence = parseJobLog(APP_LOG);
    evidence.post.cacheSaveFailures = [
      "Unable to reserve cache with key npm-abc, another job may be creating this cache.",
      "Request failed with status code 503",
    ];
    const found = one(attributeRun(snapshot(), ciLogs([[APP, evidence]])), "package-cache", "app");

    expect(found.summary).toContain("possible cache-save race");
    expect(found.summary).toContain("Other save failures");
    expect(found.evidence).toContain("post-job cache save: Request failed with status code 503");
  });

  it("reports the smoke command that runs twice in sequence", () => {
    const found = one(attribution, "repeated-command", "app");
    expect(found.summary).toMatch(/container-smoke\.mjs/);
    expect(found).toMatchObject({ onCriticalPath: true, runnerSavingsBoundMs: 7_406, elapsedSavingsBoundMs: 7_406 });
    expect(found.observedMs).toBeGreaterThan(found.runnerSavingsBoundMs);
  });

  it("reports npm test as the next critical path once the app job is shorter", () => {
    const found = one(attribution, "test-runtime", "test");
    expect(found).toMatchObject({ onCriticalPath: false, elapsedSavingsBoundMs: 0, observedMs: 56_812, runnerSavingsBoundMs: 56_812 });
    expect(found.summary).toContain("48.0 s of slack behind app");
    expect(found.summary).not.toContain("becomes critical after");
    expect(found.recommendation).toContain("Do not add shards solely");
    expect(found.recommendation).not.toContain("Before adding runners");
  });

  it("reports the other build, service and builder costs it can see in the logs", () => {
    expect(one(attribution, "layer-cache-miss", "app").summary).toMatch(/cache-from/);
    expect(one(attribution, "layer-cache-miss", "app").summary).not.toMatch(/COPY order/i);
    expect(one(attribution, "service-startup", "app").observedMs).toBe(11_702);
    expect(one(attribution, "builder-teardown", "app").recommendation).toMatch(/cleanup: false/);
    expect(one(attribution, "builder-teardown", "app").recommendation).toMatch(/DOCKER_BUILD_SUMMARY: false/);
    expect(one(attribution, "builder-setup", "app").observedMs).toBeGreaterThan(0);
  });

  it.each([true, false])("does not invent a cache-miss cause from partial restoration (restored: %s)", (restored) => {
    const log = restored ? APP_LOG.replace("#14 DONE 1.6s", "#14 CACHED") : APP_LOG;
    const found = one(attributeRun(snapshot(), ciLogs([[APP, parseJobLog(log)]])), "layer-cache-miss", "app");

    expect(found.summary).toContain(restored ? "1 other layer(s) were restored" : "No RUN or COPY layer was restored");
    expect(found.summary).toContain("The log alone does not establish the cause");
    expect(found.summary).not.toMatch(/rather than to changed inputs|these layers' inputs .* changed|cache was reachable/);
    expect(found.recommendation).toContain("resolved base-image digests");
    expect(found.recommendation).toContain("branch visibility");
    expect(found.recommendation).toContain("backend behavior");
    expect(found.observedMs).toBeGreaterThan(0);
  });

  it("describes savings only as bounds and never exceeds the observed time or the headroom", () => {
    expect(attribution.bottlenecks.length).toBeGreaterThan(0);
    for (const entry of attribution.bottlenecks) {
      expect(entry.summary).toMatch(/up to/);
      expect(entry.summary).not.toMatch(/\bwill (?:save|reduce|cut|speed)\b/i);
      expect(entry.runnerSavingsBoundMs).toBeLessThanOrEqual(entry.observedMs);
      expect(entry.elapsedSavingsBoundMs).toBeLessThanOrEqual(entry.runnerSavingsBoundMs);
      expect(entry.elapsedSavingsBoundMs).toBeLessThanOrEqual(48_000);
      if (!entry.onCriticalPath) expect(entry.elapsedSavingsBoundMs).toBe(0);
    }
  });

  it("sorts by elapsed bound, then runner bound, then id", () => {
    const sorted = [...attribution.bottlenecks].sort((a, b) => b.elapsedSavingsBoundMs - a.elapsedSavingsBoundMs
      || b.runnerSavingsBoundMs - a.runnerSavingsBoundMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(attribution.bottlenecks.map((entry) => entry.id)).toEqual(sorted.map((entry) => entry.id));
  });

  it("reports jobs it could not examine as coverage gaps, one per job", () => {
    const notFetched = attribution.gaps.filter((gap) => gap.kind === "log-not-fetched").map((gap) => gap.jobKey).sort();
    expect(notFetched).toEqual(["build", "formal", "lint", "lint-reusable", "postgres"]);
    expect(attribution.gaps.find((gap) => gap.jobKey === "postgres")).toMatchObject({ ms: 35_000 });
    expect(attribution.gaps.find((gap) => gap.jobKey === "postgres")?.detail).toMatch(/no steps either/);
    expect(attribution.gaps.filter((gap) => gap.jobKey === "app" || gap.jobKey === "test")).toEqual([]);
    expect(attribution.coverage).toMatchObject({ jobs: 7, jobsWithLogs: 2, observedMs: 335_000 });
    expect(attribution.coverage.explainedMs + attribution.coverage.unexplainedMs).toBe(attribution.coverage.observedMs);
  });

  it("is deterministic regardless of job and log order", () => {
    const again = attributeRun(snapshot(), ciLogs());
    expect(again).toEqual(attribution);
    const reversed = attributeRun(snapshot(ciJobs().reverse()), new Map([...ciLogs()].reverse()));
    expect(reversed).toEqual(attribution);
  });

  it("does not modify the snapshot or the logs it is given", () => {
    const input = snapshot();
    const logs = ciLogs([[BUILD, { kind: "log-unavailable", jobKey: "build", detail: "gone" }]]);
    const before = JSON.stringify([input, [...logs]]);
    attributeRun(input, logs);
    expect(JSON.stringify([input, [...logs]])).toBe(before);
  });
});

describe("attributeRun coverage gaps", () => {
  it("reports a missing log as log-unavailable for that job", () => {
    const result = attributeRun(snapshot(), ciLogs([[BUILD, { kind: "log-unavailable", jobKey: "build", detail: "Expired." }]]));
    expect(result.gaps.find((gap) => gap.jobKey === "build")).toMatchObject({ kind: "log-unavailable", jobName: "build", ms: 38_000 });
  });

  it("accepts logs keyed by job key as well as job id", () => {
    const byKey = attributeRun(snapshot(), new Map<number | string, JobLogResult>([["app", parseJobLog(APP_LOG)]]));
    expect(byKey.bottlenecks.some((entry) => entry.category === "cache-export")).toBe(true);
  });

  it("reports a truncated log while still using what it parsed", () => {
    const result = attributeRun(snapshot(), ciLogs([[APP, parseJobLog(APP_LOG, { truncated: true })]]));
    expect(result.gaps.find((gap) => gap.kind === "log-truncated")).toMatchObject({ jobKey: "app" });
    expect(result.bottlenecks.some((entry) => entry.category === "cache-export")).toBe(true);
  });

  it("reports time no step accounts for as unexplained", () => {
    const jobs = [job(1, "slow", "00:00", "01:40", { steps: [step(1, "Run make", "00:00", "00:10")] })];
    const result = attributeRun(snapshot(jobs), new Map<number | string, JobLogResult>([[1, { kind: "log-unavailable", jobKey: "slow", detail: "Expired." }]]));
    expect(result.gaps).toContainEqual(expect.objectContaining({ kind: "unexplained-time", jobKey: "slow", ms: 90_000 }));
    expect(result.coverage).toMatchObject({ explainedMs: 10_000, observedMs: 100_000, unexplainedMs: 90_000 });
  });

  it("does not report short unexplained time", () => {
    const jobs = [job(1, "quick", "00:00", "01:40", { steps: [step(1, "Run make", "00:00", "01:35")] })];
    const result = attributeRun(snapshot(jobs), new Map<number | string, JobLogResult>([[1, { kind: "log-unavailable", jobKey: "quick", detail: "Expired." }]]));
    expect(result.gaps.map((gap) => gap.kind)).toEqual(["log-unavailable"]);
  });

  it("reports a job with neither API steps nor log steps as no-step-data", () => {
    const jobs = [job(1, "opaque", "00:00", "00:30")];
    const result = attributeRun(snapshot(jobs), new Map<number | string, JobLogResult>([[1, parseJobLog("")]]));
    expect(result.gaps).toEqual([expect.objectContaining({ kind: "no-step-data", jobKey: "opaque", ms: 30_000 })]);
    expect(result.coverage.jobsWithLogs).toBe(1);
  });

  it("returns an empty attribution for a run without timed jobs", () => {
    const result = attributeRun({ ...snapshot(), jobs: [] });
    expect(result).toMatchObject({ elapsedMs: 0, jobs: [], bottlenecks: [], gaps: [] });
  });
});

describe("attributeRun critical path", () => {
  it("uses existing independent job slack before recommending additional test runners", () => {
    const jobs = [
      job(TEST, "test", "38:29", "39:45", { steps: TEST_STEPS }),
      job(1, "lint", "38:29", "38:55"),
      job(2, "dependent", "38:55", "39:10", { needs: ["lint"] }),
      job(3, "app", "38:29", "39:45"),
    ];
    const found = one(attributeRun(snapshot(jobs), ciLogs()), "test-runtime", "test");
    expect(found.recommendation).toContain("already-prepared compatible job with slack (lint)");
    expect(found.recommendation).toContain("drafts and failure paths");
    expect(found.recommendation).toContain("same time");
    expect(found.evidence).toContain("lint: 35.0 s of observed slack; workload compatibility is unverified");
    expect(found.evidence.some((line) => line.startsWith("dependent:"))).toBe(false);
    expect(found.elapsedSavingsBoundMs).toBe(0);
  });

  it("does not treat a near-critical job with positive slack as a source of elapsed-time savings", () => {
    const jobs = [
      job(1, "app", "38:29", "40:33"),
      job(TEST, "test", "38:29", "40:28", { steps: TEST_STEPS }),
    ];
    const result = attributeRun(snapshot(jobs), ciLogs());
    const test = result.jobs.find((entry) => entry.key === "test");
    const finding = result.bottlenecks.find((entry) => entry.category === "test-runtime");
    expect(test).toMatchObject({ critical: false, slackMs: 5_000 });
    expect(finding).toMatchObject({ onCriticalPath: false, elapsedSavingsBoundMs: 0 });
    expect(finding?.summary).toContain("no elapsed time");
    expect(finding?.summary).not.toContain("becomes critical after");
  });

  it("counts the jobs a job gates through needs", () => {
    const jobs = [
      job(1, "build", "00:00", "01:00"),
      job(2, "deploy", "01:00", "01:40", { needs: ["build"] }),
      job(3, "lint", "00:00", "00:30"),
      job(4, "docs", "00:00", "01:20"),
    ];
    const result = attributeRun(snapshot(jobs));
    const byKey = new Map(result.jobs.map((entry) => [entry.key, entry]));
    expect(byKey.get("build")).toMatchObject({ critical: true, slackMs: 0, headroomMs: 20_000, limitedBy: "docs" });
    expect(byKey.get("deploy")).toMatchObject({ critical: true, slackMs: 0, headroomMs: 20_000, limitedBy: "docs" });
    expect(byKey.get("docs")).toMatchObject({ critical: false, slackMs: 20_000 });
    expect(byKey.get("lint")).toMatchObject({ critical: false, slackMs: 70_000 });
  });

  it("gives a lone critical job the whole run as headroom", () => {
    const result = attributeRun(snapshot([job(1, "only", "00:00", "01:00")]));
    expect(result.jobs[0]).toMatchObject({ critical: true, headroomMs: 60_000 });
    expect(result.jobs[0]?.limitedBy).toBeUndefined();
  });
});

describe("attributeRun repeated setup", () => {
  const warmSetupLog = (end = "00:12") => [
    `${at("00:00")} ##[group]Run ./.github/actions/setup`,
    `${at("00:00")} ##[endgroup]`,
    `${at("00:00")} ##[start-action display=Run actions/setup-node@v7;id=setup]`,
    `${at("00:00")} ##[group]Run actions/setup-node@v7`,
    `${at("00:00")} ##[endgroup]`,
    `${at("00:03")} Cache restored from key: node-cache-Linux-x64-npm-example`,
    `${at("00:04")} ##[end-action id=setup;outcome=success;conclusion=success;duration_ms=4000]`,
    `${at("00:04")} ##[start-action display=Run npm ci;id=install]`,
    `${at("00:04")} ##[group]Run npm ci`,
    `${at("00:04")} npm ci`,
    `${at("00:04")} shell: /usr/bin/bash -e {0}`,
    `${at("00:04")} ##[endgroup]`,
    `${at("00:12")} added 250 packages in 8s`,
    `${at("00:12")} ##[end-action id=install;outcome=success;conclusion=success;duration_ms=8000]`,
    `${at(end)} Post job cleanup.`,
  ].join("\n");

  it("explains measured installation after a nested cache hit without treating the whole setup as removable", () => {
    const jobs = [job(1, "unit", "00:00", "00:12"), job(2, "lint", "00:00", "00:07")];
    const result = attributeRun(snapshot(jobs), new Map([[1, parseJobLog(warmSetupLog())]]));
    const found = one(result, "package-cache", "unit");
    expect(found).toMatchObject({ observedMs: 8_000, runnerSavingsBoundMs: 8_000, elapsedSavingsBoundMs: 5_000 });
    expect(found.summary).toContain("cache hit");
    expect(found.evidence).toContain("Run actions/setup-node@v7: setup/cache step 4.0 s");
    expect(found.evidence).toContain("npm ci: installation 8.0 s");
    expect(found.recommendation).toContain("does not prove that no network access occurred");
    expect(result.gaps.filter((gap) => gap.jobKey === "unit")).toEqual([]);
  });

  it.each([0, 2_000])("retains unexplained composite time with %i ms of overlapping measured intervals", (overlap) => {
    const evidence = parseJobLog(warmSetupLog("00:32"));
    const install = evidence.steps[0]!.children[1]!;
    install.startMs -= overlap;
    install.durationMs += overlap;
    const result = attributeRun(snapshot([job(1, "unit", "00:00", "00:32")]),
      new Map([[1, evidence]]));
    expect(one(result, "package-cache", "unit").observedMs).toBe(8_000 + overlap);
    expect(result.gaps).toContainEqual(expect.objectContaining({ kind: "unexplained-time", jobKey: "unit", ms: 20_000 }));
    expect(result.gaps[0]?.detail).toContain("20.0 s of");
  });

  it.each([
    ["unknown cache state", (log: string) => log.replace("Cache restored from key:", "Unknown cache result:")],
    ["unrelated following command", (log: string) => log.replaceAll("npm ci", "echo done")],
    ["quoted command", (log: string) => log.replaceAll("npm ci", 'echo "npm ci"')],
    ["mixed workload", (log: string) => log.replaceAll("npm ci", "npm ci && npm run build")],
  ])("does not invent warm-install evidence for %s", (_name, change) => {
    const result = attributeRun(snapshot([job(1, "unit", "00:00", "00:12")]),
      new Map([[1, parseJobLog(change(warmSetupLog()))]]));
    expect(result.bottlenecks.filter((entry) => entry.category === "package-cache")).toEqual([]);
    expect(result.gaps).toContainEqual(expect.objectContaining({ kind: "unexplained-time", ms: 12_000 }));
  });

  const setupJob = (id: number, key: string, setupEnd: string) => job(id, key, "00:00", "01:00", {
    steps: [
      step(1, "Set up job", "00:00", "00:01"),
      step(2, CHECKOUT, "00:01", "00:16"),
      step(3, "Run ./.github/actions/setup", "00:16", setupEnd),
      step(4, "Run npm run check", setupEnd, "01:00"),
    ],
  });

  it("reports the same setup step in three or more jobs as repeated setup", () => {
    const jobs = [setupJob(1, "lint", "00:28"), setupJob(2, "types", "00:30"), setupJob(3, "unit", "00:32")];
    const found = attributeRun(snapshot(jobs)).bottlenecks.filter((entry) => entry.category === "repeated-setup");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ jobKey: "lint, types, unit", observedMs: 42_000, runnerSavingsBoundMs: 26_000 });
    expect(found[0]?.summary).toMatch(/3 jobs/);
  });

  it("ignores checkout and setup that repeats too little", () => {
    const jobs = [setupJob(1, "lint", "00:20"), setupJob(2, "types", "00:20"), setupJob(3, "unit", "00:20")];
    expect(attributeRun(snapshot(jobs)).bottlenecks.filter((entry) => entry.category === "repeated-setup")).toEqual([]);
    const two = [setupJob(1, "lint", "00:40"), setupJob(2, "types", "00:40")];
    expect(attributeRun(snapshot(two)).bottlenecks.filter((entry) => entry.category === "repeated-setup")).toEqual([]);
  });

  it("distinguishes existing nested download-cache hits from repeated installation work", () => {
    const jobs = [setupJob(1, "lint", "00:28"), setupJob(2, "types", "00:30"), setupJob(3, "unit", "00:32")];
    const evidence = parseJobLog(TEST_LOG);
    const pending = [...evidence.steps];
    for (const step of pending) {
      if (step.packageCache) step.packageCache = "hit";
      pending.push(...step.children);
    }
    const logs = new Map(jobs.map((job) => [job.id, evidence]));
    const found = one(attributeRun(snapshot(jobs), logs), "repeated-setup", "lint, types, unit");
    expect(found.recommendation).toContain("3/3 jobs already show a dependency cache hit");
    expect(found.recommendation).toContain("installation, extraction and lifecycle scripts");
    expect(found.recommendation).toContain("including its upload/download cost");
  });
});

describe("collectJobLogs", () => {
  it("parses the logs it can fetch and turns failures into gaps without aborting the others", async () => {
    const api = fakeApi({ jobLogs: { [APP]: APP_LOG, [TEST]: TEST_LOG } });
    const client = fakeClient(async (route, parameters) => {
      if (route === LOGS_ROUTE && Number(parameters.job_id) === BUILD) throw httpError(500);
      if (route === LOGS_ROUTE && Number(parameters.job_id) === POSTGRES) throw new Error("socket hang up");
      return (await api.request(route, parameters)).data;
    });
    const logs = await collectJobLogs(client, repo, snapshot());
    expect(logs.size).toBe(7);
    expect(isCoverageGap(logs.get(APP))).toBe(false);
    expect(isCoverageGap(logs.get(TEST))).toBe(false);
    expect(logs.get(BUILD)).toMatchObject({ kind: "log-error", jobKey: "build" });
    expect((logs.get(BUILD) as { detail: string }).detail).toMatch(/HTTP 500/);
    expect((logs.get(POSTGRES) as { detail: string }).detail).toMatch(/socket hang up/);
    expect(logs.get(129971039633)).toMatchObject({ kind: "log-unavailable", jobKey: "lint" });

    const result = attributeRun(snapshot(), logs);
    expect(result.bottlenecks.some((entry) => entry.category === "cache-export" && entry.jobKey === "app")).toBe(true);
    expect(result.gaps.find((gap) => gap.jobKey === "build")).toMatchObject({ kind: "log-error", ms: 38_000 });
  });

  it("fetches critical and longest jobs first within the log budget", async () => {
    const client = fakeApi({ jobLogs: { [APP]: APP_LOG, [TEST]: TEST_LOG } });
    const logs = await collectJobLogs(client, repo, snapshot(), { maxJobLogs: 2 });
    expect(callsTo(client, LOGS_ROUTE).map((call) => Number(call.parameters.job_id)).sort()).toEqual([TEST, APP].sort());
    expect(isCoverageGap(logs.get(APP))).toBe(false);
    expect(isCoverageGap(logs.get(TEST))).toBe(false);
    expect(logs.get(BUILD)).toMatchObject({ kind: "log-not-fetched", jobKey: "build" });
    expect((logs.get(BUILD) as { detail: string }).detail).toMatch(/2-log budget/);
  });

  it("fetches a short failed parity job before long successful critical-path work", async () => {
    const jobs = ciJobs().map((entry) => entry.id === BUILD ? { ...entry, conclusion: "failure" } : entry);
    const client = fakeApi({ jobLogs: { [BUILD]: `${at("38:50")} ##[error]dist-action is stale; run npm run bundle and commit it.` } });
    const logs = await collectJobLogs(client, repo, snapshot(jobs), { maxJobLogs: 1 });
    expect(callsTo(client, LOGS_ROUTE).map((call) => call.parameters.job_id)).toEqual([BUILD]);
    expect(logs.get(BUILD)).toMatchObject({ generatedArtifactFailures: [{ artifact: "action-bundle" }] });
    expect(logs.get(APP)).toMatchObject({ kind: "log-not-fetched" });
  });

  it("marks logs cut at the size limit as truncated", async () => {
    const client = fakeApi({ jobLogs: { [APP]: APP_LOG } });
    const logs = await collectJobLogs(client, repo, snapshot(), { maxJobLogs: 1, maxBytes: 4_096 });
    const result = attributeRun(snapshot(), logs);
    expect(result.gaps.find((gap) => gap.kind === "log-truncated")).toMatchObject({ jobKey: "app" });
  });

  it("fetches nothing with a zero budget", async () => {
    const client = fakeApi({ jobLogs: { [APP]: APP_LOG } });
    const logs = await collectJobLogs(client, repo, snapshot(), { maxJobLogs: 0 });
    expect(callsTo(client, LOGS_ROUTE)).toEqual([]);
    expect([...logs.values()].every((entry) => isCoverageGap(entry) && entry.kind === "log-not-fetched")).toBe(true);
  });
});

describe("formatMs", () => {
  it("formats seconds and minutes", () => {
    expect(formatMs(22_500)).toBe("22.5 s");
    expect(formatMs(125_000)).toBe("2 min 5 s");
    expect(formatMs(-5)).toBe("0.0 s");
  });
});
