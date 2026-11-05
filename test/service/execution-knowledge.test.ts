import { describe, expect, it, vi } from "vitest";
import { MemoryKnowledgeStore } from "../../src/knowledge/store.js";
import { importExecutionKnowledge, listExecutionKnowledge } from "../../src/service/execution-knowledge.js";
import { fakeClient, httpError } from "../experiments/fixtures.js";
import { executionFixture } from "../knowledge/execution-cases.js";
import { now, repository, revision } from "../knowledge/fixtures.js";

const repo = { owner: repository.owner, repo: repository.repo };
async function fixture() {
  const evidence = executionFixture();
  const store = new MemoryKnowledgeStore();
  await store.saveRunObservation(evidence.observation, evidence.topology);
  const state = { denied: "", attempt: 1 };
  const client = fakeClient((route, parameters) => {
    if (state.denied === route || state.denied === parameters.ref) throw httpError(403);
    if (route === "GET /repos/{owner}/{repo}") return {
      id: 42, owner: { login: repo.owner }, name: repo.repo, html_url: `${repository.host}/${repo.owner}/${repo.repo}`, default_branch: "main",
    };
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}") return {
      sha: parameters.ref === "main" ? revision : parameters.ref, commit: { tree: { sha: "c".repeat(40) } },
    };
    if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}") return {
      id: 1, run_attempt: 1, head_sha: revision, repository: { id: 42 },
    };
    if (route === "GET /repos/{owner}/{repo}/actions/jobs/{job_id}") return {
      id: 10, run_id: 1, run_attempt: state.attempt, head_sha: revision,
    };
    throw new Error(`Unexpected request ${route}`);
  });
  return { ...evidence, store, state, client, factory: vi.fn(async () => store) };
}

describe("authorized execution evidence", () => {
  it("authenticates run/job association without upgrading supplied reports to attested facts", async () => {
    const f = await fixture();
    const result = await importExecutionKnowledge(f.client, repo, f.factory, f.observation.id, 10, {
      ...f.report, command: "this must never execute", environment: { secret: "not-stored" },
    }, now);
    expect(result.execution).toEqual(f.execution);
    expect(result.limitations.join(" ")).toContain("not report origin");
    const listed = await listExecutionKnowledge(f.client, repo, f.factory, f.observation.id);
    expect(listed.executions).toEqual([f.execution]);
    expect(await f.store.loadRunObservation(repository, f.observation.id)).toEqual(f.observation);
    f.state.denied = "GET /repos/{owner}/{repo}/actions/jobs/{job_id}";
    await expect(listExecutionKnowledge(f.client, repo, f.factory, f.observation.id)).rejects.toThrow("HTTP 403");
  });

  it("refuses API job-attempt mismatches and inaccessible checkout revisions before persistence", async () => {
    const f = await fixture();
    f.state.attempt = 2;
    await expect(importExecutionKnowledge(f.client, repo, f.factory, f.observation.id, 10, f.report, now)).rejects.toThrow("exact run attempt");
    expect(await f.store.listExecutionObservations(repository, f.observation.id, 20)).toEqual([]);
    f.state.attempt = 1;
    f.state.denied = "b".repeat(40);
    await expect(importExecutionKnowledge(f.client, repo, f.factory, f.observation.id, 10, {
      ...f.report, checkoutSha: f.state.denied,
    }, now)).rejects.toThrow("HTTP 403");
    expect(await f.store.listExecutionObservations(repository, f.observation.id, 20)).toEqual([]);
  });

  it("requires repository Contents access before opening the database", async () => {
    const f = await fixture();
    f.state.denied = "GET /repos/{owner}/{repo}/commits/{ref}";
    await expect(listExecutionKnowledge(f.client, repo, f.factory, f.observation.id)).rejects.toThrow("HTTP 403");
    expect(f.factory).not.toHaveBeenCalled();
  });
});
