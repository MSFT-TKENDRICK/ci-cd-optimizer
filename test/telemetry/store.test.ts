import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSeries } from "../../src/alerts/anomaly.js";
import { computeBaseline } from "../../src/telemetry/baseline.js";
import { FileTelemetryStore, MemoryTelemetryStore, type TelemetryStore } from "../../src/telemetry/store.js";
import { snapshot } from "../alerts/fixtures.js";

const query = { owner: "acme", repo: "widgets", workflowId: 7, limit: 100 };
const first = snapshot(1001, 600, [["build", 500]], "failure");
const retry = { ...snapshot(1001, 60, [["build", 50]]), runAttempt: 2 };

describe.each(["memory", "file"] as const)("%s attempt history", (kind) => {
  let store: TelemetryStore;
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "telemetry-attempts-"));
    store = kind === "memory" ? new MemoryTelemetryStore() : new FileTelemetryStore(join(root, "snapshots.jsonl"));
    await store.initialize();
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("retains failed attempts, selects by attempt rather than arrival/time, and corrects one identity", async () => {
    const late = { ...first, completedAt: "2027-01-01T00:00:00Z" };
    await store.save(retry);
    await store.save(late);
    await store.save(late);
    expect(await store.history(query)).toEqual([retry]);
    expect(await store.history({ ...query, attempts: "all" })).toEqual([retry, late]);
    const corrected = { ...retry, headSha: "corrected", durationMs: 70_000 };
    await store.save(corrected);
    expect(await store.history(query)).toEqual([corrected]);
    expect(await store.history({ ...query, attempts: "all" })).toEqual([corrected, late]);
  });

  it("does not collide across owners or repositories", async () => {
    const others = [{ ...first, owner: "another" }, { ...first, repo: "another" }];
    for (const item of [retry, ...others]) await store.save(item);
    expect(await store.history(query)).toEqual([retry]);
    for (const item of others) {
      expect(await store.history({ ...query, owner: item.owner, repo: item.repo })).toEqual([item]);
    }
  });

  it("selects the latest attempt before applying workflow and branch filters", async () => {
    const changed = { ...retry, workflowId: 8, branch: "release" };
    await store.save(first);
    await store.save(changed);
    expect(await store.history(query)).toEqual([]);
    expect(await store.history({ ...query, attempts: "all" })).toEqual([first]);
    expect(await store.history({ ...query, workflowId: 8, branch: "release" })).toEqual([changed]);
    expect(await store.history({ ...query, workflowId: 8, branch: "main" })).toEqual([]);
  });

  it("limits logical runs by default and individual attempts explicitly, with deterministic ties", async () => {
    const next = snapshot(1002, 80, [["build", 70]]);
    for (const item of [retry, next, first]) await store.save(item);
    expect(await store.history({ ...query, limit: 2 })).toEqual([retry, next]);
    expect(await store.history({ ...query, attempts: "all", limit: 2 })).toEqual([retry, next]);
    expect(await store.history({ ...query, attempts: "all", limit: 3 })).toEqual([first, retry, next]);
    expect(await store.history({ ...query, runId: first.runId, limit: 1 })).toEqual([retry]);
    expect(await store.history({ ...query, runId: first.runId, attempts: "all" })).toEqual([first, retry]);
    expect(await store.history({ ...query, limit: 0 })).toEqual([]);
    await expect(store.history({ ...query, limit: -1 })).rejects.toThrow("History limit");
    await expect(store.save({ ...first, runAttempt: 0 })).rejects.toThrow("Run attempt");
  });

  it("orders absolute completion time and keeps null and empty branches distinct", async () => {
    const earlier = { ...first, branch: null, completedAt: "2026-10-01T01:00:00+02:00" };
    const later = { ...retry, runId: 1002, branch: "", completedAt: "2026-10-01T00:00:00Z" };
    await store.save(later);
    await store.save(earlier);
    expect(await store.history(query)).toEqual([earlier, later]);
    expect(await store.history({ ...query, branch: null })).toEqual([earlier]);
    expect(await store.history({ ...query, branch: "" })).toEqual([later]);
  });
});

it("retains whole runs and all their attempts across file reopen and eviction", async () => {
  const root = await mkdtemp(join(tmpdir(), "telemetry-retention-"));
  try {
    const path = join(root, "snapshots.jsonl");
    const store = new FileTelemetryStore(path, 1);
    await store.save(retry);
    await store.save(first);
    const reopened = new FileTelemetryStore(path, 1);
    expect(await reopened.history({ ...query, attempts: "all" })).toEqual([first, retry]);
    const next = snapshot(1002, 80, [["build", 70]]);
    await reopened.save(next);
    await reopened.save(first);
    const nullBranch = { ...snapshot(1003, 80, []), branch: null };
    const emptyBranch = { ...snapshot(1004, 80, []), branch: "" };
    await reopened.save(nullBranch);
    await reopened.save(emptyBranch);
    expect(await new FileTelemetryStore(path, 1).history({ ...query, attempts: "all" })).toEqual([next, nullBranch, emptyBranch]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not overweight retries or resurrect successes in baselines and alert series", () => {
  const oldSuccess = { ...first, conclusion: "success" };
  const latestFailure = { ...snapshot(1002, 999, [["build", 999]]), runAttempt: 2, conclusion: "failure" };
  const ordinary = snapshot(1003, 100, [["build", 90]]);
  const history = [retry, oldSuccess, latestFailure, snapshot(1002, 1, [["build", 1]]), ordinary, retry];
  const current = snapshot(2000, 200, []);
  expect(computeBaseline(history, current)).toMatchObject({ sampleCount: 2, medianDurationMs: 80_000, jobs: { build: 70_000 } });
  expect(buildSeries(history).find((series) => !series.jobKey)?.points.map((point) => point.runId)).toEqual([1001, 1003]);
});
