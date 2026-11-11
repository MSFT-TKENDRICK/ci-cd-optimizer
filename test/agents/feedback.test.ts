import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BENCHMARK_SCHEMA, encodeBenchmark, type RunBenchmark } from "../../src/telemetry/benchmark.js";
import { FEEDBACK_REPLAY_MS, FEEDBACK_WORKFLOW, feedbackInventory, findingSignature, readFeedback, significantDurationChange, type FeedbackProducer } from "../../src/agents/feedback.js";
import { createMcpServer } from "../../src/agents/mcp.js";
import { githubReader } from "../../src/agents/github.js";
import { operationAccess } from "../../src/agents/remote.js";
import { operation } from "../../src/agents/safety.js";

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); vi.restoreAllMocks(); });

function fixture() {
  const created = new Date(Date.now() - 1000).toISOString();
  const since = new Date(Date.now() - 60000).toISOString();
  const producer: FeedbackProducer = {
    id: 3000, run_attempt: 1, workflow_id: 8, head_sha: "b".repeat(40), head_branch: "main",
    event: "workflow_run", status: "completed", conclusion: "success", created_at: created, path: FEEDBACK_WORKFLOW,
  };
  const benchmark: RunBenchmark = {
    schema: BENCHMARK_SCHEMA, repository: "acme/widgets", repositoryId: 42, runId: 2000, runAttempt: 1,
    headSha: "a".repeat(40), workflowId: 7, workflowPath: ".github/workflows/ci.yml", conclusion: "success",
    collectedAt: created, analysisStatus: "complete",
    metrics: { elapsedMs: 20000, initialQueueMs: 0, queueInclusiveMs: 20000, runnerMs: 18000, observedRunnerMs: 18000 },
    previous: null, jobs: [{ id: 1, key: "test", name: "test", durationMs: 18000, observedRunnerSharePct: 100, readyQueueMs: 2000 }], omittedJobs: 0,
    findings: [{
      id: "test:package-cache", category: "package-cache", jobKey: "test", jobName: "test",
      observedMs: 5000, elapsedSavingsBoundMs: 5000, runnerSavingsBoundMs: 5000,
      summary: "Dependency installation ran without a download cache.",
      recommendation: "Use a lockfile-keyed download cache while preserving installation and integrity checks.",
      evidence: ["npm ci took 5 seconds; no package cache was restored."], omittedEvidence: 0,
    }],
    omittedFindings: 0, gaps: [], omittedGaps: 0,
    rework: { observedAttempts: 1, failedAttempts: 0, artifactDriftAttempts: 0, artifactDriftRunnerMs: 0, unclassifiedFailedAttempts: 0 },
  };
  const state = {
    total: 1, corrupt: false, sourceId: 2000, calls: 0, logs: 0, inventoryFails: false, timeout: "", producers: [producer],
    benchmarks: new Map<number, RunBenchmark>(), branches: new Map<number, string>(),
    events: new Map<number, string>(), completed: new Map<string, string>(), fetched: [] as number[],
  };
  // Each extra producer defaults to its own workflow so delivery tests are not deduplicated; gating tests share one.
  const benchmarkFor = (producerId: number): RunBenchmark => state.benchmarks.get(producerId) ??
    (producerId === producer.id ? benchmark : { ...benchmark, runId: benchmark.runId + producerId - producer.id, workflowId: 100 + producerId - producer.id });
  const fetcher: typeof fetch = async (input) => {
    state.calls++;
    const path = decodeURIComponent(new URL(String(input)).pathname);
    if (path === "/user") return Response.json({ id: 1, type: "User" });
    if (path === "/repos/acme/widgets") return Response.json({ id: 42, full_name: "acme/widgets", default_branch: "main", permissions: { pull: true } });
    if (path.endsWith("/actions/workflows/cicd-optimizer-telemetry.yml")) return Response.json({ id: 8, path: FEEDBACK_WORKFLOW, state: "active" });
    if (path.endsWith("/actions/workflows/8/runs")) {
      if (state.timeout === "inventory") throw new DOMException("private download URL", "TimeoutError");
      return state.inventoryFails
        ? Response.json({}, { status: 500 }) : Response.json({ total_count: state.total, workflow_runs: state.producers });
    }
    const jobs = /\/actions\/runs\/(\d+)\/attempts\/1\/jobs$/.exec(path);
    if (jobs) return Response.json({ total_count: 1, jobs: [{ id: Number(jobs[1]), name: "telemetry", status: "completed" }] });
    const logs = /\/actions\/jobs\/(\d+)\/logs$/.exec(path);
    if (logs) {
      state.logs++;
      state.fetched.push(Number(logs[1]));
      if (state.timeout === "log") throw new DOMException("private download URL", "TimeoutError");
      return new Response(state.corrupt ? "Missing benchmark" : encodeBenchmark(benchmarkFor(Number(logs[1]))).split("\n").map((line) => `${created} ${line}`).join("\n"));
    }
    const sourceRun = /\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(path);
    const source = sourceRun && [producer, ...state.producers].map((item) => benchmarkFor(item.id))
      .find((item) => item.runId === Number(sourceRun[1]) && item.runAttempt === Number(sourceRun[2]));
    if (source) return Response.json({
      id: source.runId === benchmark.runId ? state.sourceId : source.runId, run_attempt: source.runAttempt, head_sha: source.headSha,
      head_branch: state.branches.get(source.runId) ?? "main", workflow_id: source.workflowId, repository: { id: 42 }, status: "completed",
      conclusion: source.conclusion, path: source.workflowPath, event: state.events.get(source.runId) ?? "push",
      updated_at: state.completed.get(`${source.runId}:${source.runAttempt}`) ??
        new Date(Date.parse(created) - 30000 + source.runId - 2000).toISOString(),
    });
    return Response.json({}, { status: 404 });
  };
  const remote = { allow: ["acme/widgets"], repositoryIds: new Map<string, number>(), createClient: (signal: AbortSignal) => githubReader("test-token", { fetch: fetcher, signal }) };
  const inventory = () => operation((signal) => feedbackInventory(operationAccess(remote, signal), "acme/widgets", since));
  const read = () => operation((signal) => readFeedback(operationAccess(remote, signal), "acme/widgets", producer));
  return { state, producer, benchmark, remote, inventory, read, since };
}

type Fixture = ReturnType<typeof fixture>;
function addRun(f: Fixture, producerId: number, changes: Partial<RunBenchmark> = {}) {
  f.state.benchmarks.set(producerId, { ...f.benchmark, runId: f.benchmark.runId + producerId - f.producer.id, ...changes });
  if (!f.state.producers.some((item) => item.id === producerId)) f.state.producers.push({ ...f.producer, id: producerId });
  f.state.total = f.state.producers.length;
}

async function connectFeed(f: Fixture, name: string, pollMs = 20) {
  const server = createMcpServer({ fallbackRoot: process.cwd(), remote: f.remote, feedback: { since: f.since, pollMs } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: "1" });
  clients.push(client);
  await server.connect(serverSide);
  await client.connect(clientSide);
  const text = async (uri: string) => JSON.parse(((await client.readResource({ uri })).contents[0] as { text: string }).text);
  return {
    status: () => text("cicd://feedback/status"),
    read: (key: string) => text(`cicd://feedback/runs/${key}`),
    ack: (key: string) => client.callTool({ name: "feedback_ack", arguments: { key } }),
    runs: async () => (await client.listResources()).resources.map((item) => item.uri).filter((uri) => uri.startsWith("cicd://feedback/runs/")),
  };
}

describe("verified CI feedback", () => {
  it("collects the complete replay snapshot before broadcasting a success with intervening failures", async () => {
    const f = fixture();
    for (let id = 3000; id < 3007; id++) addRun(f, id, { conclusion: "failure" });
    addRun(f, 3007);
    const feed = await connectFeed(f, "ordered-replay", 200);
    await expect.poll(() => f.state.logs, { interval: 5 }).toBe(4);
    expect(await feed.runs()).toEqual([]);
    await expect.poll(feed.runs).toEqual(["cicd://feedback/runs/42:3007:1"]);
    expect((await feed.read("42:3007:1")).rollup).toMatchObject({
      runs: Array.from({ length: 7 }, (_, i) => ({ runId: 2000 + i, conclusion: "failure" })),
      byConclusion: [{ conclusion: "failure", runs: 7 }], nonSuccessRunnerMs: 126000,
    });
  });

  it("orders a late rerun by its completion metadata rather than its older run id", async () => {
    const f = fixture();
    const feed = await connectFeed(f, "late-rerun");
    await expect.poll(feed.runs).toHaveLength(1);
    await feed.ack("42:3000:1");
    addRun(f, 3001, { runId: 1990, runAttempt: 2, metrics: { ...f.benchmark.metrics!, elapsedMs: 600000 } });
    f.state.completed.set("1990:2", new Date().toISOString());
    await expect.poll(feed.runs).toEqual(["cicd://feedback/runs/42:3001:1"]);
    expect((await feed.read("42:3001:1")).trigger).toContain("elapsed time changed from 20000 ms to 600000 ms");
  });

  it("keeps trigger types separate and does not compare incomplete or changed job sets", async () => {
    const f = fixture();
    const feed = await connectFeed(f, "comparable-runs");
    await expect.poll(feed.runs).toHaveLength(1);
    await feed.ack("42:3000:1");
    addRun(f, 3001);
    f.state.events.set(2001, "workflow_dispatch");
    await expect.poll(feed.runs).toEqual(["cicd://feedback/runs/42:3001:1"]);
    await feed.ack("42:3001:1");
    addRun(f, 3002, { analysisStatus: "partial", omittedJobs: 1, metrics: null });
    await expect.poll(async () => (await feed.status()).suppressedUnchanged).toBe(1);
    expect(await feed.runs()).toEqual([]);
    addRun(f, 3003, { jobs: [{ ...f.benchmark.jobs[0]!, key: "integration" }] });
    await expect.poll(feed.runs).toEqual(["cicd://feedback/runs/42:3003:1"]);
    expect((await feed.read("42:3003:1")).trigger).toEqual(["job set changed; durations are not comparable"]);
  });

  it("deduplicates source attempts across producers, even after rollup truncation", async () => {
    const f = fixture();
    for (let id = 3000; id < 3023; id++) addRun(f, id, { conclusion: "failure" });
    addRun(f, 3023, { runId: 2000, conclusion: "failure" });
    addRun(f, 3024);
    const feed = await connectFeed(f, "bounded-rollup");
    await expect.poll(feed.runs, { timeout: 5000 }).toEqual(["cicd://feedback/runs/42:3024:1"]);
    const event = await feed.read("42:3024:1");
    expect(event.rollup).toMatchObject({
      omittedRuns: 3, byConclusion: [{ conclusion: "failure", runs: 23 }], nonSuccessRunnerMs: 414000,
    });
    expect(event.rollup.runs).toHaveLength(20);
  });

  it("compares cumulative drift to the last broadcast, not a clean quiet success", async () => {
    const f = fixture();
    const metrics = (ms: number) => ({ ...f.benchmark.metrics!, elapsedMs: ms });
    addRun(f, 3000, { metrics: metrics(100000) });
    const feed = await connectFeed(f, "cumulative-drift");
    await expect.poll(feed.runs).toHaveLength(1);
    await feed.ack("42:3000:1");
    addRun(f, 3001, { metrics: metrics(104000) });
    await expect.poll(async () => (await feed.status()).suppressedUnchanged).toBe(1);
    addRun(f, 3002, { metrics: metrics(110000), findings: [] });
    await expect.poll(async () => (await feed.status()).filtered).toBe(1);
    addRun(f, 3003, { metrics: metrics(140000) });
    await expect.poll(feed.runs).toEqual(["cicd://feedback/runs/42:3003:1"]);
    expect((await feed.read("42:3003:1")).trigger).toContain("elapsed time changed from 100000 ms to 140000 ms");
  });

  it("does not bypass missing producer evidence to publish the next success", async () => {
    const f = fixture();
    addRun(f, 3000, { conclusion: "failure" });
    addRun(f, 3001);
    f.state.timeout = "log";
    const feed = await connectFeed(f, "unresolved-producer");
    await expect.poll(async () => (await feed.status()).state).toBe("error");
    expect(await feed.runs()).toEqual([]);
    f.state.timeout = "";
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301000);
    await expect.poll(feed.runs).toEqual(["cicd://feedback/runs/42:3001:1"]);
    expect((await feed.read("42:3001:1")).rollup.runs).toMatchObject([{ runId: 2000, conclusion: "failure" }]);
  });

  it("does not use variability from a different job set when returning to the last broadcast shape", async () => {
    const f = fixture();
    const metrics = (ms: number) => ({ ...f.benchmark.metrics!, elapsedMs: ms });
    addRun(f, 3000, { metrics: metrics(100000) });
    const feed = await connectFeed(f, "returning-shape");
    await expect.poll(feed.runs).toHaveLength(1);
    await feed.ack("42:3000:1");
    for (const [index, ms] of [10000, 100000, 1000000].entries()) {
      addRun(f, 3001 + index, {
        metrics: metrics(ms), findings: [], jobs: [{ ...f.benchmark.jobs[0]!, key: "integration" }],
      });
      await expect.poll(async () => (await feed.status()).filtered).toBe(index + 1);
    }
    addRun(f, 3004, { metrics: metrics(120000) });
    await expect.poll(feed.runs).toEqual(["cicd://feedback/runs/42:3004:1"]);
    expect((await feed.read("42:3004:1")).trigger).toContain("elapsed time changed from 100000 ms to 120000 ms");
  });

  it("reconstructs the same successful broadcasts and rollups from a complete replay", async () => {
    const f = fixture();
    for (let id = 3000; id < 3005; id++) addRun(f, id, { conclusion: "failure" });
    addRun(f, 3005);
    addRun(f, 3006);
    addRun(f, 3007, { metrics: { ...f.benchmark.metrics!, elapsedMs: 120000 } });
    const first = await connectFeed(f, "replay-first");
    await expect.poll(async () => (await first.status()).state).toBe("watching");
    const keys = ["42:3005:1", "42:3007:1"];
    const events = await Promise.all(keys.map(first.read));
    for (const key of keys) await first.ack(key);
    const second = await connectFeed(f, "replay-second");
    await expect.poll(async () => (await second.status()).state).toBe("watching");
    expect(await Promise.all(keys.map(second.read))).toEqual(events);
    expect(await second.runs()).toHaveLength(2);
  });
  it.each([
    "clean", "skipped", "gap-only", "unavailable", "omitted-only", "no-recommendation", "no-evidence",
  ])("does not broadcast or repeatedly fetch a %s benchmark", async (kind) => {
    const f = fixture();
    if (kind === "no-recommendation") f.benchmark.findings[0]!.recommendation = " \n ";
    else if (kind === "no-evidence") f.benchmark.findings[0]!.evidence = [" \t "];
    else f.benchmark.findings = [];
    if (kind === "skipped") f.benchmark.conclusion = "skipped";
    if (kind === "gap-only" || kind === "omitted-only") {
      f.benchmark.analysisStatus = "partial";
      f.benchmark.gaps = ["Log evidence is incomplete; absence of findings is not a clean result."];
    }
    if (kind === "omitted-only") f.benchmark.omittedFindings = 2;
    if (kind === "unavailable") {
      f.benchmark.analysisStatus = "unavailable";
      f.benchmark.metrics = null;
      f.benchmark.gaps = ["Analysis unavailable."];
    }
    const server = createMcpServer({ fallbackRoot: process.cwd(), remote: f.remote, feedback: { since: f.since, pollMs: 20 } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "quiet-feedback-test", version: "1" });
    clients.push(client);
    let changes = 0;
    client.setNotificationHandler("notifications/resources/list_changed", () => { changes++; });
    await server.connect(serverSide);
    await client.connect(clientSide);
    const status = async () => JSON.parse(((await client.readResource({ uri: "cicd://feedback/status" })).contents[0] as { text: string }).text);
    await expect.poll(async () => (await status()).state).toBe("watching");
    expect((await client.listResources()).resources.some((item) => item.uri.startsWith("cicd://feedback/runs/"))).toBe(false);
    expect(await status()).toMatchObject(kind === "skipped" ? { rolledUp: 1, filtered: 0, heldRuns: 1, seriesAwaitingSuccess: 1, pending: 0, undelivered: 0 }
      : kind === "unavailable" ? { filtered: 1, rolledUp: 0, heldRuns: 1, seriesAwaitingSuccess: 1, pending: 0, undelivered: 0 }
        : { filtered: 1, rolledUp: 0, heldRuns: 0, seriesAwaitingSuccess: 0, pending: 0, undelivered: 0 });
    const calls = f.state.calls;
    await expect.poll(() => f.state.calls).toBeGreaterThan(calls);
    expect(f.state.logs).toBe(1);
    expect(changes).toBe(0);
    expect((await f.read()).benchmark).toEqual(f.benchmark);
  });

  describe("feedback change heuristic", () => {
    it.each([
      [75 * 60000, 73 * 60000, false],
      [60 * 60000, 10 * 60000, true],
      [0.04, 0.12, false],
      [40 * 60000, 120 * 60000, true],
      [0, 999, false],
      [0, 1000, false],
      [0, 1001, true],
      [null, 100000, false],
      [NaN, 100000, false],
      [10000, Infinity, false],
      [-1, 100000, false],
    ])("compares %s ms to %s ms as %s", (before, after, expected) => {
      expect(significantDurationChange(before, after)).toBe(expected);
      expect(significantDurationChange(after, before)).toBe(expected);
    });

    it("damps ordinary variation, limits history and still detects large changes", () => {
      const noisy = [60000, 100000, 140000, 80000, 120000];
      expect(significantDurationChange(100000, 120000)).toBe(true);
      expect(significantDurationChange(100000, 120000, noisy)).toBe(false);
      expect(significantDurationChange(100000, 600000, noisy)).toBe(true);
      expect(significantDurationChange(100000, 120000, [NaN, -10, Infinity])).toBe(true);
    });

    it("normalizes job ids without discarding finding details", () => {
      const finding = { id: "package-cache:1234:s1.0", category: "package-cache", jobKey: "test" };
      expect(findingSignature(finding)).toBe(findingSignature({ ...finding, id: "package-cache:5678:s1.0" }));
      expect(findingSignature(finding)).not.toBe(findingSignature({ ...finding, id: "package-cache:5678:s2.0" }));
      expect(findingSignature(finding)).not.toBe(findingSignature({ ...finding, jobKey: "build" }));
    });
  });

  it("still delivers evidenced remediation with gaps and zero savings bounds", async () => {
    const f = fixture();
    f.benchmark.analysisStatus = "partial";
    f.benchmark.gaps = ["Another job log is unavailable."];
    f.benchmark.findings = [{
      ...f.benchmark.findings[0]!, id: "test:parity", category: "generated-artifact-drift",
      elapsedSavingsBoundMs: 0, runnerSavingsBoundMs: 0,
      summary: "Generated output parity failed; failed work is rework exposure, not proven savings.",
      recommendation: "Regenerate and commit the bundle with its sources; preserve the parity gate.",
      evidence: ["dist-action/index.js is stale."],
    }];
    const server = createMcpServer({ fallbackRoot: process.cwd(), remote: f.remote, feedback: { since: f.since, pollMs: 20 } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "actionable-partial-test", version: "1" });
    clients.push(client);
    await server.connect(serverSide);
    await client.connect(clientSide);
    const uri = "cicd://feedback/runs/42:3000:1";
    await expect.poll(async () => (await client.listResources()).resources.some((item) => item.uri === uri)).toBe(true);
    const result = await client.readResource({ uri });
    const event = JSON.parse((result.contents[0] as { text: string }).text);
    expect(event.benchmark).toEqual(f.benchmark);
    expect(event).toMatchObject({ sourceBranch: "main", trigger: ["first successful run of this workflow and branch in the replay scope"] });
    expect(event.rollup).toBeUndefined();
    await client.callTool({ name: "feedback_ack", arguments: { key: "42:3000:1" } });
    expect((await client.listResources()).resources.some((item) => item.uri === uri)).toBe(false);
  });

  it("holds non-success runs until a workflow's first success and rolls them into that broadcast", async () => {
    const f = fixture();
    addRun(f, 3000, { conclusion: "failure", metrics: { ...f.benchmark.metrics!, runnerMs: 7000 } });
    addRun(f, 3001, { conclusion: "cancelled", metrics: { ...f.benchmark.metrics!, runnerMs: null } });
    const feed = await connectFeed(f, "first-success-test");
    await expect.poll(async () => (await feed.status()).rolledUp).toBe(2);
    expect(await feed.status()).toMatchObject({ heldRuns: 2, seriesAwaitingSuccess: 1, filtered: 0, pending: 0 });
    expect(await feed.runs()).toEqual([]);
    addRun(f, 3002);
    await expect.poll(feed.runs).toEqual(["cicd://feedback/runs/42:3002:1"]);
    const event = await feed.read("42:3002:1");
    expect(event.trigger).toEqual(["first successful run of this workflow and branch in the replay scope"]);
    expect(event.rollup).toEqual({
      runs: [
        { runId: 2000, runAttempt: 1, conclusion: "failure", analysisStatus: "complete", elapsedMs: 20000, runnerMs: 7000 },
        { runId: 2001, runAttempt: 1, conclusion: "cancelled", analysisStatus: "complete", elapsedMs: 20000, runnerMs: null },
      ],
      omittedRuns: 0, byConclusion: [{ conclusion: "cancelled", runs: 1 }, { conclusion: "failure", runs: 1 }],
      nonSuccessRunnerMs: 7000, nonSuccessRunsWithoutRunnerMs: 1, quietSuccesses: 0,
    });
    expect(await feed.status()).toMatchObject({ heldRuns: 0, seriesAwaitingSuccess: 0, pending: 1 });
  });

  it("broadcasts only changed or newly evidenced successes, in source-run order, per workflow and branch", async () => {
    const f = fixture();
    const finding = (runId: number) => ({ ...f.benchmark.findings[0]!, id: `package-cache:${runId}:restore` });
    addRun(f, 3000, { findings: [finding(2000)] });
    const feed = await connectFeed(f, "dedup-test");
    await expect.poll(feed.runs).toEqual(["cicd://feedback/runs/42:3000:1"]);
    await feed.ack("42:3000:1");
    addRun(f, 3001, { findings: [finding(2001)], metrics: { ...f.benchmark.metrics!, elapsedMs: 20900 } });
    await expect.poll(async () => (await feed.status()).suppressedUnchanged).toBe(1);
    expect(await feed.runs()).toEqual([]);
    const slow = { ...f.benchmark.metrics!, elapsedMs: 600000, queueInclusiveMs: 600000, runnerMs: 598000 };
    const slowJobs = [{ ...f.benchmark.jobs[0]!, durationMs: 598000 }];
    addRun(f, 3002, { conclusion: "failure", findings: [finding(2002)] });
    addRun(f, 3003, { findings: [finding(2003)], metrics: slow, jobs: slowJobs });
    await expect.poll(feed.runs).toEqual(["cicd://feedback/runs/42:3003:1"]);
    const slower = await feed.read("42:3003:1");
    expect(slower.trigger).toEqual([
      "elapsed time changed from 20000 ms to 600000 ms", "queue-inclusive time changed from 20000 ms to 600000 ms",
      "runner time changed from 18000 ms to 598000 ms", "job test time changed from 18000 ms to 598000 ms",
    ]);
    expect(slower.rollup).toMatchObject({ runs: [{ runId: 2002, conclusion: "failure" }], quietSuccesses: 1, nonSuccessRunnerMs: 18000 });
    await feed.ack("42:3003:1");
    const cacheMiss = { ...f.benchmark.findings[0]!, id: "layer-cache-miss:2004:s1", category: "layer-cache-miss" };
    addRun(f, 3004, { findings: [finding(2004), cacheMiss], metrics: slow, jobs: slowJobs });
    await expect.poll(feed.runs).toEqual(["cicd://feedback/runs/42:3004:1"]);
    expect((await feed.read("42:3004:1")).trigger).toEqual(["new layer-cache-miss finding in test"]);
    await feed.ack("42:3004:1");
    addRun(f, 3005, { runId: 1990, findings: [{ ...cacheMiss, category: "rework" }] });
    f.state.branches.set(2006, "feature");
    addRun(f, 3006, { findings: [finding(2006)] });
    await expect.poll(feed.runs).toEqual(["cicd://feedback/runs/42:3006:1"]);
    expect(await feed.read("42:3006:1")).toMatchObject({ sourceBranch: "feature", trigger: ["first successful run of this workflow and branch in the replay scope"] });
    expect(await feed.status()).toMatchObject({ suppressedUnchanged: 2, rolledUp: 1, filtered: 0, heldRuns: 0, seriesAwaitingSuccess: 0 });
  });

  it.each(["inventory", "log"])("reports a %s timeout without leaking details or losing recovery", async (phase) => {
    const f = fixture();
    f.state.timeout = phase;
    const server = createMcpServer({ fallbackRoot: process.cwd(), remote: f.remote, feedback: { since: f.since, pollMs: 20 } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "timeout-test", version: "1" });
    clients.push(client);
    await server.connect(serverSide);
    await client.connect(clientSide);
    const status = async () => JSON.parse(((await client.readResource({ uri: "cicd://feedback/status" })).contents[0] as { text: string }).text);
    await expect.poll(async () => (await status()).state).toBe("error");
    expect((await status()).error).toContain("Upstream read timed out.");
    const resources = (await client.listResources()).resources;
    expect(resources.some((item) => item.uri.startsWith("cicd://feedback/runs/"))).toBe(false);
    const error = resources.find((item) => item.uri.startsWith("cicd://feedback/errors/"))!;
    const report = JSON.stringify(await client.readResource({ uri: error.uri }));
    expect(report).toContain("delivery is incomplete");
    expect(report).not.toContain("private download URL");
    f.state.timeout = "";
    if (phase === "log") {
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(f.state.logs).toBe(1);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301000);
    }
    await expect.poll(async () => (await client.listResources()).resources.some((item) => item.uri === "cicd://feedback/runs/42:3000:1")).toBe(true);
    await expect.poll(async () => (await status()).state).toBe("watching");
  });

  it("verifies the default-branch producer, framed payload and exact source attempt", async () => {
    const f = fixture();
    expect(await f.inventory()).toEqual([f.producer]);
    expect(await f.read()).toMatchObject({ key: "42:3000:1", benchmark: f.benchmark });
    f.state.sourceId++;
    await expect(f.read()).rejects.toThrow(/provenance/);
    f.state.corrupt = true;
    await expect(f.read()).rejects.toThrow(/do not infer zero/);
  });

  it("rejects incomplete inventories and non-default-branch producers", async () => {
    const f = fixture();
    f.state.total = 1001;
    await expect(f.inventory()).rejects.toThrow(/incomplete/);
    f.state.total = 1;
    f.producer.head_branch = "untrusted";
    await expect(f.inventory()).rejects.toThrow(/identity/);
  });

  it("keeps a failed producer visibly incomplete during backoff and recovers without losing the event", async () => {
    const f = fixture();
    f.state.corrupt = true;
    const server = createMcpServer({ fallbackRoot: process.cwd(), remote: f.remote, feedback: { since: f.since, pollMs: 20 } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "retry-test", version: "1" });
    clients.push(client);
    await server.connect(serverSide);
    await client.connect(clientSide);
    const status = async () => JSON.parse(((await client.readResource({ uri: "cicd://feedback/status" })).contents[0] as { text: string }).text);
    await expect.poll(async () => (await status()).state).toBe("error");
    f.state.corrupt = false;
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(f.state.logs).toBe(1);
    expect((await status()).state).not.toBe("watching");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301000);
    await expect.poll(async () => (await client.listResources()).resources.some((item) => item.uri.startsWith("cicd://feedback/runs/"))).toBe(true);
    await expect.poll(async () => (await status()).state).toBe("watching");
  });

  it("broadcasts actual resource changes, replays until acknowledgement and closes cleanly", async () => {
    const f = fixture();
    const server = createMcpServer({ fallbackRoot: process.cwd(), remote: f.remote, feedback: { since: f.since, pollMs: 20 } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "feedback-test", version: "1" });
    clients.push(client);
    let changes = 0;
    client.setNotificationHandler("notifications/resources/list_changed", () => { changes++; });
    await server.connect(serverSide);
    await client.connect(clientSide);
    const uri = "cicd://feedback/runs/42:3000:1";
    await expect.poll(async () => (await client.listResources()).resources.some((resource) => resource.uri === uri)).toBe(true);
    expect(changes).toBeGreaterThan(0);
    const result = await client.readResource({ uri });
    expect(JSON.parse((result.contents[0] as { text: string }).text)).toMatchObject({ benchmark: f.benchmark });
    await client.callTool({ name: "feedback_ack", arguments: { key: "42:3000:1" } });
    await expect.poll(async () => (await client.listResources()).resources.some((resource) => resource.uri === uri)).toBe(false);
    await client.close();
    const calls = f.state.calls;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(f.state.calls).toBe(calls);
  });

  it("reports known producers aging out even when the per-tick budget prevented their first fetch", async () => {
    const f = fixture();
    f.state.producers = Array.from({ length: 5 }, (_, i) => ({ ...f.producer, id: 3000 + i }));
    f.state.total = 5;
    const server = createMcpServer({ fallbackRoot: process.cwd(), remote: f.remote, feedback: { since: f.since, pollMs: 200 } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "backlog-test", version: "1" });
    clients.push(client);
    await server.connect(serverSide);
    await client.connect(clientSide);
    const status = async () => JSON.parse(((await client.readResource({ uri: "cicd://feedback/status" })).contents[0] as { text: string }).text);
    await expect.poll(async () => (await status()).state, { interval: 5 }).toBe("catching-up");
    expect(f.state.logs).toBe(4);
    f.state.producers = [];
    f.state.total = 0;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + FEEDBACK_REPLAY_MS + 2000);
    await expect.poll(async () => (await status()).replayGap).toBe(true);
    expect((await status()).error).toMatch(/Undelivered producer 42:3002:1/);
  });

  it("fetches both ends fairly but drains a frozen snapshot before later arrivals", async () => {
    const f = fixture();
    f.state.producers = Array.from({ length: 10 }, (_, i) => ({ ...f.producer, id: 3000 + i }));
    f.state.total = 10;
    const server = createMcpServer({ fallbackRoot: process.cwd(), remote: f.remote, feedback: { since: f.since, pollMs: 200 } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fair-replay-test", version: "1" });
    clients.push(client);
    await server.connect(serverSide);
    await client.connect(clientSide);
    const keys = async () => (await client.listResources()).resources
      .filter((item) => item.uri.startsWith("cicd://feedback/runs/"))
      .map((item) => Number(item.uri.split(":").at(-2))).sort((a, b) => a - b);
    await expect.poll(() => f.state.logs, { interval: 5 }).toBe(4);
    expect(await keys()).toEqual([]);
    expect(f.state.fetched).toEqual([3009, 3000, 3008, 3001]);
    expect(f.state.logs).toBe(4);
    f.state.producers.push({ ...f.producer, id: 3010 }, { ...f.producer, id: 3011, status: "in_progress", conclusion: null });
    f.state.total = 12;
    await expect.poll(() => f.state.logs, { interval: 5 }).toBe(8);
    expect(await keys()).toEqual([]);
    expect(f.state.fetched).toEqual([3009, 3000, 3008, 3001, 3007, 3002, 3006, 3003]);
    expect(f.state.logs).toBe(8);
    await expect.poll(keys, { interval: 5 }).toEqual(Array.from({ length: 10 }, (_, i) => 3000 + i));
    await expect.poll(() => f.state.logs, { interval: 5 }).toBe(11);
    expect(await keys()).not.toContain(3010);
    f.state.producers[11]!.status = "completed";
    f.state.producers[11]!.conclusion = "success";
    await expect.poll(keys, { interval: 5 }).toEqual(Array.from({ length: 12 }, (_, i) => 3000 + i));
    expect(new Set(f.state.fetched).size).toBe(12);
  });

  it("does not mistake continuous failed inventories for successful replay coverage", async () => {
    const f = fixture();
    f.state.inventoryFails = true;
    const server = createMcpServer({ fallbackRoot: process.cwd(), remote: f.remote, feedback: { since: f.since, pollMs: 20 } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "inventory-gap-test", version: "1" });
    clients.push(client);
    await server.connect(serverSide);
    await client.connect(clientSide);
    const status = async () => JSON.parse(((await client.readResource({ uri: "cicd://feedback/status" })).contents[0] as { text: string }).text);
    await expect.poll(async () => (await status()).state).toBe("error");
    const start = Date.now();
    const clock = vi.spyOn(Date, "now");
    for (const days of [2, 4, 6]) {
      const calls = f.state.calls;
      clock.mockReturnValue(start + days * 86400000);
      await expect.poll(() => f.state.calls).toBeGreaterThan(calls);
      await expect.poll(async () => (await status()).state).toBe("error");
    }
    f.state.inventoryFails = false;
    f.state.producers = [];
    f.state.total = 0;
    clock.mockReturnValue(start + 8 * 86400000);
    await expect.poll(async () => (await status()).replayGap).toBe(true);
    expect((await status()).state).toBe("error");
    expect((await status()).error).toMatch(/No complete inventory/);
  });

  it("preserves all buffered events when backpressure frees only one slot at a time", async () => {
    const f = fixture();
    f.state.producers = Array.from({ length: 56 }, (_, i) => ({ ...f.producer, id: 3000 + i }));
    f.state.total = 56;
    const server = createMcpServer({ fallbackRoot: process.cwd(), remote: f.remote, feedback: { since: f.since, pollMs: 50 } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fair-backpressure-test", version: "1" });
    clients.push(client);
    await server.connect(serverSide);
    await client.connect(clientSide);
    const status = async () => JSON.parse(((await client.readResource({ uri: "cicd://feedback/status" })).contents[0] as { text: string }).text);
    const has = async (id: number) => (await client.listResources()).resources.some((item) => item.uri === `cicd://feedback/runs/42:${id}:1`);
    await expect.poll(async () => (await status()).state, { timeout: 5000, interval: 10 }).toBe("backpressure");
    expect(f.state.logs).toBe(56);
    expect((await status()).buffered).toBe(6);
    f.state.producers.push({ ...f.producer, id: 3056 });
    f.state.total++;
    await client.callTool({ name: "feedback_ack", arguments: { key: "42:3000:1" } });
    await expect.poll(() => has(3050)).toBe(true);
    f.state.producers.push({ ...f.producer, id: 3057 });
    f.state.total++;
    await client.callTool({ name: "feedback_ack", arguments: { key: "42:3001:1" } });
    await expect.poll(() => has(3051)).toBe(true);
    expect(await has(3057)).toBe(false);
    expect(f.state.logs).toBe(56);
    expect((await status()).buffered).toBe(4);
    expect((await status()).pending).toBe(50);
  });
});
