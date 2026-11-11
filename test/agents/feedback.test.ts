import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BENCHMARK_SCHEMA, encodeBenchmark, type RunBenchmark } from "../../src/telemetry/benchmark.js";
import { FEEDBACK_REPLAY_MS, FEEDBACK_WORKFLOW, feedbackInventory, readFeedback, type FeedbackProducer } from "../../src/agents/feedback.js";
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
    collectedAt: created, analysisStatus: "unavailable", metrics: null, previous: null, jobs: [], omittedJobs: 0,
    findings: [], omittedFindings: 0, gaps: ["No completed jobs."], omittedGaps: 0,
    rework: { observedAttempts: 1, failedAttempts: 0, artifactDriftAttempts: 0, artifactDriftRunnerMs: 0, unclassifiedFailedAttempts: 0 },
  };
  const state = { total: 1, corrupt: false, sourceId: 2000, calls: 0, logs: 0, inventoryFails: false, producers: [producer] };
  const fetcher: typeof fetch = async (input) => {
    state.calls++;
    const path = decodeURIComponent(new URL(String(input)).pathname);
    if (path === "/user") return Response.json({ id: 1, type: "User" });
    if (path === "/repos/acme/widgets") return Response.json({ id: 42, full_name: "acme/widgets", default_branch: "main", permissions: { pull: true } });
    if (path.endsWith("/actions/workflows/cicd-optimizer-telemetry.yml")) return Response.json({ id: 8, path: FEEDBACK_WORKFLOW, state: "active" });
    if (path.endsWith("/actions/workflows/8/runs")) return state.inventoryFails
      ? Response.json({}, { status: 500 }) : Response.json({ total_count: state.total, workflow_runs: state.producers });
    if (/\/actions\/runs\/\d+\/attempts\/1\/jobs$/.test(path)) return Response.json({ total_count: 1, jobs: [{ id: 55, name: "telemetry", status: "completed" }] });
    if (path.endsWith("/actions/jobs/55/logs")) {
      state.logs++;
      return new Response(state.corrupt ? "Missing benchmark" : encodeBenchmark(benchmark).split("\n").map((line) => `${created} ${line}`).join("\n"));
    }
    if (path.endsWith("/actions/runs/2000/attempts/1")) return Response.json({
      id: state.sourceId, run_attempt: 1, head_sha: benchmark.headSha, workflow_id: 7, repository: { id: 42 }, status: "completed",
      conclusion: "success", path: ".github/workflows/ci.yml",
    });
    return Response.json({}, { status: 404 });
  };
  const remote = { allow: ["acme/widgets"], repositoryIds: new Map<string, number>(), createClient: (signal: AbortSignal) => githubReader("test-token", { fetch: fetcher, signal }) };
  const inventory = () => operation((signal) => feedbackInventory(operationAccess(remote, signal), "acme/widgets", since));
  const read = () => operation((signal) => readFeedback(operationAccess(remote, signal), "acme/widgets", producer));
  return { state, producer, benchmark, remote, inventory, read, since };
}

describe("verified CI feedback", () => {
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
    expect((await status()).error).toMatch(/Undelivered producer 42:3004:1/);
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
});
