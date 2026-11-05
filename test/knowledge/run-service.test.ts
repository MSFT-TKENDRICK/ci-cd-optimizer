import { describe, expect, it, vi } from "vitest";
import { MemoryKnowledgeStore } from "../../src/knowledge/store.js";
import { DEFAULT_CONFIG } from "../../src/lint/config.js";
import { collectRunKnowledge, describeRunKnowledge } from "../../src/service/run-knowledge.js";
import { processWorkflowRun } from "../../src/service/workflow-run.js";
import { MemoryTelemetryStore } from "../../src/telemetry/store.js";
import type { WorkflowRunPayload } from "../../src/telemetry/snapshot.js";
import { snapshot as workflow } from "../alerts/fixtures.js";
import { fakeApi, callsTo, TIMEOUT_ONLY, writes } from "../service/api.js";
import { httpError } from "../experiments/fixtures.js";
import { now, repository, revision } from "./fixtures.js";
import { observation } from "./run-window-cases.js";

const metadata = { id: 42, html_url: "https://github.com/acme/widgets", owner: { login: "acme" }, name: "widgets" };
const workflowFile = "name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps: [{run: make}]\n";
const api = (extra: Parameters<typeof fakeApi>[0] = {}) => fakeApi({
  config: TIMEOUT_ONLY, repositoryMetadata: metadata,
  refs: {
    main: { "package.json": '{"name":"root","devDependencies":{"nx":"20"}}' },
    [revision]: { "package.json": '{"name":"root","devDependencies":{"turbo":"2"}}', ".github/workflows/ci.yml": workflowFile },
  },
  jobs: { 100: [{ id: 1, name: "build", conclusion: "success", labels: ["ubuntu-24.04"], started_at: "2026-11-01T00:00:00Z", completed_at: "2026-11-01T00:01:00Z", steps: [] }] },
  ...extra,
});
const runtime = () => ({ ...workflow(100, 60, [["build", 60]]), headSha: revision });
const payload = (values: Partial<WorkflowRunPayload> = {}): WorkflowRunPayload => ({
  id: 100, name: "CI", path: ".github/workflows/ci.yml", workflow_id: 7, run_attempt: 1,
  head_sha: revision, head_branch: "main", event: "push", status: "completed", conclusion: "success",
  created_at: "2026-11-01T00:00:00Z", run_started_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:01:00Z",
  ...values,
});

describe("run source context collection", () => {
  it("joins exact run-revision declarations, never the current default branch", async () => {
    const store = new MemoryKnowledgeStore();
    const client = api();
    const result = await collectRunKnowledge(client, repository, runtime(), DEFAULT_CONFIG, { store, expectedRepositoryId: 42, now });
    expect(result.project?.technologies.map((fact) => fact.technology)).toEqual(["turborepo"]);
    expect(result.project?.revision).toBe(revision);
    expect(callsTo(client, "GET /repos/{owner}/{repo}/commits/{ref}")[0]?.parameters.ref).toBe(revision);
    expect(callsTo(client, "GET /repos/{owner}/{repo}/git/blobs/{file_sha}")).toHaveLength(1);
    expect(await store.loadRunObservation(repository, result.observation.id)).toEqual(result.observation);
  });

  it("reuses complete source only for an identical selection policy and always rechecks repository identity", async () => {
    const store = new MemoryKnowledgeStore();
    const client = api();
    const first = await collectRunKnowledge(client, repository, runtime(), DEFAULT_CONFIG, { store, now });
    client.calls.length = 0;
    const second = await collectRunKnowledge(client, repository, { ...runtime(), runId: 101 }, DEFAULT_CONFIG, { store, now });
    expect(second.project?.id).toBe(first.project?.id);
    expect(callsTo(client, "GET /repos/{owner}/{repo}")).toHaveLength(1);
    expect(callsTo(client, "GET /repos/{owner}/{repo}/commits/{ref}")).toHaveLength(1);
    expect(callsTo(client, "GET /repos/{owner}/{repo}/git/trees/{tree_sha}")).toHaveLength(0);
    await collectRunKnowledge(client, repository, runtime(), { ...DEFAULT_CONFIG, limits: { ...DEFAULT_CONFIG.limits, maxFiles: 1 } }, { store, now });
    expect(callsTo(client, "GET /repos/{owner}/{repo}/commits/{ref}")).toHaveLength(2);
  });

  it("retains a 404 as explicit unknown source but surfaces forbidden and transient failures", async () => {
    for (const status of [404, 403, 500]) {
      const client = api();
      const original = client.request.bind(client);
      vi.spyOn(client, "request").mockImplementation(async (route, parameters) => {
        if (route === "GET /repos/{owner}/{repo}/commits/{ref}") throw httpError(status);
        return original(route, parameters);
      });
      const store = new MemoryKnowledgeStore();
      const result = collectRunKnowledge(client, repository, runtime(), DEFAULT_CONFIG, { store, now });
      if (status === 404) {
        expect((await result).observation.source).toEqual({ status: "unavailable", reason: "revision-unavailable" });
        expect(await store.list({ ...repository, limit: 10 })).toEqual([]);
        expect(await store.listRunObservations({ ...repository, limit: 10 })).toHaveLength(1);
      } else {
        await expect(result).rejects.toThrow();
        expect(await store.listRunObservations({ ...repository, limit: 10 })).toEqual([]);
      }
    }
  });

  it("rejects repository-name reuse and a source response at the wrong commit", async () => {
    await expect(collectRunKnowledge(api(), repository, runtime(), DEFAULT_CONFIG, { expectedRepositoryId: 43, now })).rejects.toThrow("identity changed");
    await expect(collectRunKnowledge(api({ commitSha: "b".repeat(40) }), repository, runtime(), DEFAULT_CONFIG, { now })).rejects.toThrow("revision changed");
  });

  it("retains cancelled runs and stale attempts before report suppression", async () => {
    const store = new MemoryKnowledgeStore();
    const telemetry = new MemoryTelemetryStore();
    await telemetry.save({ ...runtime(), runAttempt: 2 });
    const client = api();
    const stale = await processWorkflowRun(client, repository, payload(), { store: telemetry, knowledgeStore: async () => store, now });
    expect(stale.status).toBe("skipped");
    expect(stale.knowledge?.persistence).toBe("saved");
    expect(writes(client)).toEqual([]);
    const cancelled = await processWorkflowRun(api({ jobs: { 100: [] } }), repository, payload({ conclusion: "cancelled", run_attempt: 3 }), {
      store: telemetry, knowledgeStore: async () => store, now,
    });
    expect(cancelled.snapshot?.jobs).toEqual([]);
    expect(cancelled.knowledge?.observation.run.conclusion).toBe("cancelled");
    expect(await store.listRunObservations({ ...repository, runId: 100, limit: 10 })).toHaveLength(2);
  });

  it("does not initialize persistence during dry runs or disabled/invalid configuration", async () => {
    const provider = vi.fn(async () => new MemoryKnowledgeStore());
    const preview = await processWorkflowRun(api(), repository, payload(), { dryRun: true, knowledgeStore: provider, now });
    expect(preview.knowledge?.persistence).toBe("preview");
    expect(preview.report).toContain("does not identify executed projects");
    await processWorkflowRun(api({ config: "enabled: false\n" }), repository, payload(), { knowledgeStore: provider, now });
    const invalid = await processWorkflowRun(api({ config: "rules:\n  unknown: error\n" }), repository, payload(), { knowledgeStore: provider, now });
    expect(invalid.knowledgeSkipped).toBe("invalid-config");
    expect(invalid.report).toContain("configuration is invalid");
    expect(provider).not.toHaveBeenCalled();
  });

  it("fails configured persistence before checks or alert side effects", async () => {
    const store = new MemoryKnowledgeStore();
    vi.spyOn(store, "saveRunObservation").mockRejectedValue(new Error("Database unavailable"));
    const client = api();
    await expect(processWorkflowRun(client, repository, payload(), { knowledgeStore: async () => store, now })).rejects.toThrow("Database unavailable");
    expect(writes(client)).toEqual([]);
  });

  it("rejects stale repository identity before any telemetry or GitHub side effects even without knowledge enabled", async () => {
    const client = api();
    await expect(processWorkflowRun(client, repository, payload(), { expectedRepositoryId: 43 })).rejects.toThrow("identity changed");
    expect(client.calls).toHaveLength(1);
    expect(writes(client)).toEqual([]);
  });

  it.each([403, 404])("never uses cached source after the current commit read returns %s", async (status) => {
    const store = new MemoryKnowledgeStore();
    const client = api();
    await collectRunKnowledge(client, repository, runtime(), DEFAULT_CONFIG, { store, now });
    const list = vi.spyOn(store, "list");
    const original = client.request.bind(client);
    vi.spyOn(client, "request").mockImplementation(async (route, parameters) => {
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") throw httpError(status);
      return original(route, parameters);
    });
    const result = collectRunKnowledge(client, repository, { ...runtime(), runId: 101 }, DEFAULT_CONFIG, { store, now });
    if (status === 403) await expect(result).rejects.toThrow();
    else {
      const unknown = await result;
      expect(unknown.project).toBeUndefined();
      expect(unknown.observation.source.status).toBe("unavailable");
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps partial collection explicit in reports and never reuses it as complete source", async () => {
    const client = api({ refs: { [revision]: { "package.json": "{}", "packages/a/package.json": "{}" } } });
    const store = new MemoryKnowledgeStore();
    const config = { ...DEFAULT_CONFIG, limits: { ...DEFAULT_CONFIG.limits, maxFiles: 1 } };
    const first = await collectRunKnowledge(client, repository, runtime(), config, { store, now });
    expect(first.project?.coverage.inventoryComplete).toBe(false);
    expect(describeRunKnowledge(first)).toContain("partial or uncertain");
    await collectRunKnowledge(client, repository, { ...runtime(), runId: 101 }, config, { store, now });
    expect(callsTo(client, "GET /repos/{owner}/{repo}/git/trees/{tree_sha}")).toHaveLength(2);
  });

  it("uses immutable eligible evidence for configured baselines instead of corrected mutable history", async () => {
    const store = new MemoryKnowledgeStore();
    const telemetry = new MemoryTelemetryStore();
    for (const item of [observation(1, 10), observation(1, 90), observation(2, 20), observation(3, 40)]) {
      await store.saveRunObservation(item);
      await telemetry.save(item.run);
    }
    const result = await processWorkflowRun(api(), repository, payload(), { store: telemetry, knowledgeStore: async () => store, now, check: false, alerts: false });
    expect(result.samples).toBe(2);
    expect(result.baseline?.medianDurationMs).toBe(30_000);
    expect(result.knowledge?.durations?.excluded).toContainEqual({ runId: 1, reason: "conflicting-runtime-observations" });
    expect(result.knowledge).not.toHaveProperty("comparison");
  });

  it("surfaces history read failures before publishing checks or alerts", async () => {
    const store = new MemoryKnowledgeStore();
    vi.spyOn(store, "readRunWindow").mockRejectedValue(new Error("History read failed"));
    const client = api();
    await expect(processWorkflowRun(client, repository, payload(), { knowledgeStore: async () => store, now })).rejects.toThrow("History read failed");
    expect(writes(client)).toEqual([]);
    expect(await store.listRunObservations({ ...repository, limit: 10 })).toHaveLength(1);
  });

  it("suppresses a stale attempt known only to immutable history", async () => {
    const store = new MemoryKnowledgeStore();
    await store.saveRunObservation(observation(100, 10, { runAttempt: 2 }));
    const client = api();
    const result = await processWorkflowRun(client, repository, payload(), { knowledgeStore: async () => store, now });
    expect(result.status).toBe("skipped");
    expect(writes(client)).toEqual([]);
  });

  it("holds alert changes for a conflicted reference and never backfills mutable history into knowledge comparisons", async () => {
    const store = new MemoryKnowledgeStore();
    for (const item of [observation(1), observation(2), observation(3), observation(100, 90)]) await store.saveRunObservation(item);
    const client = api({ config: "extends: []\nalerts:\n  enabled: true\n  minSamples: 3\n" });
    const result = await processWorkflowRun(client, repository, payload(), { knowledgeStore: async () => store, now, check: false });
    expect(result.knowledge?.durations?.reason).toBe("conflicting-runtime-observations");
    expect(result.baseline).toBeUndefined();
    expect(result.alerts).toBeUndefined();
    expect(callsTo(client, "GET /repos/{owner}/{repo}/issues")).toEqual([]);
    expect(callsTo(client, "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs")).toEqual([]);
    expect(writes(client)).toEqual([]);
  });

  it.each(["build", "build (unit)"])("never assesses budgets using an ambiguous display-name mapping: %s", async (name) => {
    const client = api({
      config: "durations:\n  objectives:\n    - workflow: .github/workflows/ci.yml\n      job: build\n      maxDurationMs: 1000\n",
      refs: { [revision]: { ".github/workflows/ci.yml": `name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps: [{run: make}]\n  other:\n    name: ${name}\n    runs-on: ubuntu-24.04\n    steps: [{run: make}]\n` } },
      jobs: { 100: [{ id: 1, name, conclusion: "success", labels: ["ubuntu-24.04"], started_at: "2026-11-01T00:00:00Z", completed_at: "2026-11-01T00:01:00Z", steps: [] }] },
    });
    const result = await processWorkflowRun(client, repository, payload(), { knowledge: true, dryRun: true, now });
    expect(result.snapshot?.provenance?.definitionKnown).toBe(false);
    expect(result.knowledge?.durations).toMatchObject({ status: "reference-excluded", reason: "ineligible-workload", jobs: [] });
    expect(result.knowledge?.durations?.workflow).toBeUndefined();
    expect(writes(client)).toEqual([]);
  });
});
