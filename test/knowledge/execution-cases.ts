import { expect, it } from "vitest";
import { createExecutionObservation, parseExecutionReport } from "../../src/knowledge/execution.js";
import { createRunObservation } from "../../src/knowledge/run-observation.js";
import type { KnowledgeStore } from "../../src/knowledge/types.js";
import { snapshot as workflow } from "../alerts/fixtures.js";
import { now, repository, revision, snapshot } from "./fixtures.js";

export function executionFixture() {
  const topology = snapshot();
  const startedAt = "2026-10-20T00:00:00.000Z";
  const completedAt = "2026-10-20T00:01:00.000Z";
  const base = workflow(1, 60, [["build", 60]]);
  const observation = createRunObservation(repository, {
    ...base, headSha: revision, createdAt: startedAt, startedAt, completedAt,
    jobs: base.jobs.map((job) => ({ ...job, startedAt, completedAt })),
    provenance: { ...base.provenance!, collectedAt: completedAt },
  }, { status: "linked", snapshotId: topology.id }, now);
  const report = parseExecutionReport({
    version: 1, repository, runId: 1, runAttempt: 1, headSha: revision, checkoutSha: revision,
    jobKey: "build", projectPath: "packages/a", task: "build",
    startedAt: "2026-10-20T00:00:01.000Z", completedAt: "2026-10-20T00:00:11.000Z", durationMs: 10000,
    exitCode: 0, signal: null, coverage: "single-command",
    tools: [{ name: "node", version: "v22.21.1", basis: "recorder-runtime" }, { name: "turborepo", version: "2.5.0", basis: "workflow-report" }],
    caches: [{ tool: "turborepo", result: "hit", basis: "workflow-report" }],
  });
  return { topology, observation, report, execution: createExecutionObservation(report, observation.id, 10, now) };
}

export function executionCases(getStore: () => KnowledgeStore): void {
  it("persists immutable operator-supplied reports tied to one exact run observation and job", async () => {
    const store = getStore();
    const { topology, observation, report, execution } = executionFixture();
    await store.saveRunObservation(observation, topology);
    await store.saveExecutionObservation(execution);
    const repeated = createExecutionObservation(report, observation.id, 10, new Date(now.getTime() + 1000));
    expect(repeated.id).toBe(execution.id);
    await store.saveExecutionObservation(repeated);
    expect(await store.listExecutionObservations(repository, observation.id, 10)).toEqual([execution]);
    expect(await store.listExecutionObservations({ ...repository, repositoryId: "43" }, observation.id, 10)).toEqual([]);
    await expect(store.listExecutionObservations(repository, observation.id, 101)).rejects.toThrow("limit");
    const changed = createExecutionObservation({ ...report, caches: [{ tool: "turborepo", result: "miss", basis: "workflow-report" }] }, observation.id, 10, now);
    await store.saveExecutionObservation(changed);
    expect(await store.listExecutionObservations(repository, observation.id, 10)).toHaveLength(2);
  });

  it("rejects missing evidence and cross-attempt, job and scope associations", async () => {
    const store = getStore();
    const { topology, observation, report, execution } = executionFixture();
    await expect(store.saveExecutionObservation(execution)).rejects.toThrow("unavailable run evidence");
    await store.saveRunObservation(observation, topology);
    for (const invalid of [
      createExecutionObservation({ ...report, runAttempt: 2 }, observation.id, 10, now),
      createExecutionObservation(report, observation.id, 11, now),
      createExecutionObservation({ ...report, repository: { ...report.repository, repositoryId: "99" } }, observation.id, 10, now),
      createExecutionObservation({ ...report, startedAt: "2026-10-20T00:02:01.000Z", completedAt: "2026-10-20T00:02:11.000Z" }, observation.id, 10, now),
    ]) await expect(store.saveExecutionObservation(invalid)).rejects.toThrow();
    expect(await store.listExecutionObservations(repository, observation.id, 10)).toEqual([]);
  });

  it("includes runtime reports in preview digests and erases them atomically with eligible runs", async () => {
    const store = getStore();
    const { topology, observation, execution } = executionFixture();
    await store.saveRunObservation(observation, topology);
    const request = { ...repository, mode: "prune" as const, before: "2026-11-02T00:00:00.000Z" };
    const old = await store.maintain(request);
    await store.saveExecutionObservation(execution);
    await expect(store.maintain({ ...request, confirmation: old.digest })).rejects.toThrow("plan changed");
    const plan = await store.maintain(request);
    expect(plan.counts).toMatchObject({ runs: 1, executions: 1, snapshots: 1 });
    await store.maintain({ ...request, confirmation: plan.digest });
    expect(await store.listExecutionObservations(repository, observation.id, 10)).toEqual([]);
    expect(await store.loadRunObservation(repository, observation.id)).toBeUndefined();
  });

  it("allowlists data and keeps unsupported versions, unsafe paths and impossible timings out", () => {
    const { report } = executionFixture();
    const sanitized = parseExecutionReport({ ...report, environment: { secret: "do-not-store" }, command: "untrusted command" });
    expect(sanitized).toEqual(report);
    expect(() => parseExecutionReport({ ...report, projectPath: "../private" })).toThrow("relative");
    expect(() => parseExecutionReport({ ...report, projectPath: "packages/a\n" })).toThrow("invalid");
    expect(() => parseExecutionReport({ ...report, durationMs: -1 })).toThrow("duration");
    expect(() => parseExecutionReport({ ...report, durationMs: 99999 })).toThrow("duration");
    expect(() => parseExecutionReport({ ...report, tools: [{ name: "node", version: "https://private/token", basis: "workflow-report" }] })).toThrow("version");
    expect(() => parseExecutionReport({ ...report, caches: [{ tool: "turborepo", result: "success" }] })).toThrow("result");
  });
}
