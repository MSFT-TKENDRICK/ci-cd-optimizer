import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresTelemetryStore } from "../../src/telemetry/postgres-store.js";
import type { WorkflowSnapshot } from "../../src/telemetry/types.js";
import { snapshot } from "../alerts/fixtures.js";

const databaseUrl = process.env.DATABASE_URL;

// CI runs this against a Postgres service container (the `postgres` job); locally, set DATABASE_URL to opt in.
describe.skipIf(!databaseUrl)("PostgresTelemetryStore", () => {
  const owner = `test-${randomUUID()}`;
  const baseRunId = randomInt(1, 2 ** 40) * 100;
  let store: PostgresTelemetryStore;

  function run(offset: number, branch: string | null, minute: number, conclusion = "success"): WorkflowSnapshot {
    const at = new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString();
    const base = snapshot(baseRunId + offset, 60 + offset, [["build", 30], ["test", 20, conclusion]], conclusion);
    return { ...base, owner, branch, createdAt: at, startedAt: at, completedAt: at };
  }

  beforeAll(async () => {
    store = new PostgresTelemetryStore(databaseUrl!);
    await store.initialize();
    await store.initialize();
  });

  afterAll(async () => {
    await store?.close();
  });

  it("round-trips snapshots and returns history oldest first per branch", async () => {
    const runs = [run(1, "main", 1), run(2, "feature", 2), run(3, null, 3), run(4, "main", 4), run(5, "main", 5)];
    runs[3]!.jobs[0]!.steps = [{ number: 1, name: "Checkout", conclusion: "success", startedAt: runs[3]!.startedAt, completedAt: runs[3]!.completedAt, durationMs: 1500 }];
    for (const item of [runs[4]!, runs[0]!, runs[2]!, runs[3]!, runs[1]!]) await store.save(item);

    const query = { owner, repo: "widgets", workflowId: 7, limit: 10 };
    expect(await store.history({ ...query, branch: "main" })).toEqual([runs[0], runs[3], runs[4]]);
    expect((await store.history({ ...query, branch: "main", limit: 2 })).map((item) => item.runId)).toEqual([runs[3]!.runId, runs[4]!.runId]);
    expect(await store.history({ ...query, branch: null })).toEqual([runs[2]]);
    expect((await store.history(query)).map((item) => item.runId)).toEqual(runs.map((item) => item.runId));
    expect(await store.history({ ...query, workflowId: 8 })).toEqual([]);
  });

  it("upserts a re-run attempt by run id", async () => {
    const first = run(10, "main", 10, "failure");
    const retried = { ...run(10, "main", 20), runAttempt: 2 };
    await store.save(first);
    await store.save(retried);

    const history = await store.history({ owner, repo: "widgets", workflowId: 7, branch: "main", limit: 50 });
    expect(history.filter((item) => item.runId === first.runId)).toEqual([retried]);
  });
});
