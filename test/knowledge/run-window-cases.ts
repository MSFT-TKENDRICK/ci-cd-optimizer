import { expect, it } from "vitest";
import { createRunObservation } from "../../src/knowledge/run-observation.js";
import { MAX_RUN_OBSERVATIONS, MAX_RUN_OBSERVATION_BYTES } from "../../src/knowledge/run-window.js";
import type { KnowledgeStore } from "../../src/knowledge/types.js";
import type { WorkflowSnapshot } from "../../src/telemetry/types.js";
import { snapshot as workflow } from "../alerts/fixtures.js";
import { now, repository, revision } from "./fixtures.js";

export const observation = (id: number, seconds = 10, overrides: Partial<WorkflowSnapshot> = {}, scope = repository, offset = id) =>
  createRunObservation(scope, { ...workflow(id, seconds, [["build", seconds]]), path: ".github/workflows/ci.yml", headSha: revision, ...overrides },
    { status: "unavailable", reason: "revision-unavailable" }, new Date(now.getTime() + offset * 1000));
export const windowQuery = { ...repository, workflowId: 7, branch: "main", referenceRunId: 10, limit: 100 };

export function runWindowCases(getStore: () => KnowledgeStore): void {
  it("pins the reference and limits logical runs, retaining corrections that changed the selected workflow or branch", async () => {
    const store = getStore();
    const first = observation(1);
    const correction = observation(1, 30, { workflowId: 8, branch: "elsewhere" }, repository, 11);
    for (const item of [observation(10, 10, {}, repository, 0), first, correction, observation(2)]) await store.saveRunObservation(item);
    const result = await store.readRunWindow({ ...windowQuery, limit: 2 });
    expect(result.complete).toBe(false);
    expect(result.groups.map((group) => group.runId)).toEqual([10, 1]);
    expect(result.groups[1]?.complete).toBe(true);
    expect(result.groups[1]?.observations.map((item) => item.id)).toEqual([correction.id, first.id]);
    result.groups[1]!.observations[0]!.run.durationMs = 1;
    expect((await store.loadRunObservation(repository, correction.id))?.run.durationMs).toBe(30_000);
  });

  it("returns no partial samples when a logical run exceeds the correction budget", async () => {
    const store = getStore();
    for (let i = 0; i <= MAX_RUN_OBSERVATIONS; i++) await store.saveRunObservation(observation(1, i + 1, {}, repository, i));
    await store.saveRunObservation(observation(10));
    const result = await store.readRunWindow(windowQuery);
    expect(result.complete).toBe(true);
    expect(result.groups.find((group) => group.runId === 1)).toEqual({ runId: 1, complete: false, observations: [] });
  });

  it("marks oversized evidence incomplete without returning its payload", async () => {
    const store = getStore();
    await store.saveRunObservation(observation(10, 10, { htmlUrl: "x".repeat(MAX_RUN_OBSERVATION_BYTES * 2) }));
    expect((await store.readRunWindow(windowQuery)).groups).toEqual([{ runId: 10, complete: false, observations: [] }]);
  });

  it("isolates stable host/repository scopes and handles null branches", async () => {
    const store = getStore();
    const first = observation(10, 10, { branch: null });
    await store.saveRunObservation(first);
    await store.saveRunObservation(observation(10, 20, { runAttempt: 2 }, { ...repository, repositoryId: "43" }));
    await store.saveRunObservation(observation(10, 30, {}, { ...repository, host: "https://github.example.com" }));
    await store.saveRunObservation(observation(2));
    const result = await store.readRunWindow({ ...windowQuery, branch: null });
    expect(result.groups).toEqual([{ runId: 10, complete: true, observations: [first] }]);
  });

  it("validates bounds and snapshots the caller's query before asynchronous I/O", async () => {
    const store = getStore();
    await store.saveRunObservation(observation(10));
    const query = { ...windowQuery };
    const reading = store.readRunWindow(query);
    query.repositoryId = "43";
    expect((await reading).groups).toHaveLength(1);
    expect(await store.readRunWindow({ ...windowQuery, limit: 0 })).toEqual({ complete: false, groups: [] });
    for (const invalid of [{ limit: 101 }, { limit: -1 }, { workflowId: 0 }, { referenceRunId: 0 }, { branch: "" }]) {
      await expect(store.readRunWindow({ ...windowQuery, ...invalid })).rejects.toThrow();
    }
  });
}
