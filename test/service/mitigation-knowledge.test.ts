import { describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/index.js";
import { createRunObservation } from "../../src/knowledge/run-observation.js";
import { MemoryKnowledgeStore } from "../../src/knowledge/store.js";
import { createMitigationApplication } from "../../src/knowledge/mitigation.js";
import type { RunObservation } from "../../src/knowledge/types.js";
import { serializeRecipe } from "../../src/recipes/recipe.js";
import {
  evaluateMitigationKnowledge, inspectMitigationKnowledge, listMitigationKnowledge, listRunKnowledge, refreshMitigationKnowledge,
} from "../../src/service/mitigation-knowledge.js";
import { prepareRecipeKnowledge, recordRecipeApplications, refreshMitigationApplications } from "../../src/service/recipe-knowledge.js";
import { collectRunKnowledge } from "../../src/service/run-knowledge.js";
import { marker } from "../../src/issues/markers.js";
import { snapshot as workflow } from "../alerts/fixtures.js";
import { fakeClient, httpError } from "../experiments/fixtures.js";
import { input, repository, revision } from "../knowledge/fixtures.js";
import { defaultConfig, sampleRecipe } from "../recipes/fixtures.js";

const target = { owner: repository.owner, repo: repository.repo };
const head = "b".repeat(40);
const source = { host: repository.host, repositoryId: "43", owner: "acme", repo: "platform" };

function fixture() {
  const store = new MemoryKnowledgeStore();
  const recipe = sampleRecipe();
  const observations = new Map<number, RunObservation>();
  const state = {
    published: serializeRecipe(recipe), denied: "", deniedStatus: 403, targetId: 42, mismatchedRun: false,
    change: {
      number: 81, state: "open", state_reason: null as string | null, merged: false, merged_at: null as string | null,
      body: marker("recipe", recipe.id, { revision: String(recipe.revision) }) + "\n" +
        marker("fix", `group:recipe-${recipe.id}`, { commit: head }),
      created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z", closed_at: null as string | null,
      head: { sha: head, repo: { id: 42 } }, base: { repo: { id: 42 } },
    },
  };
  const client = fakeClient((route, parameters) => {
    if (state.denied === route || state.denied === parameters.ref) throw httpError(state.deniedStatus);
    if (route === "GET /repos/{owner}/{repo}") {
      const current = parameters.repo === "platform" ? source : { ...repository, repositoryId: String(state.targetId) };
      return { id: Number(current.repositoryId), owner: { login: current.owner }, name: current.repo,
        html_url: `${current.host}/${current.owner}/${current.repo}`, default_branch: "main" };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
      return { sha: parameters.ref === "main" ? "d".repeat(40) : parameters.ref, commit: { tree: { sha: "c".repeat(40) } } };
    }
    if (route === "GET /repos/{owner}/{repo}/contents/{path}") return { content: Buffer.from(state.published).toString("base64"), encoding: "base64" };
    if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") return {
      tree: input().files.map((file, index) => ({ path: file.path, type: "blob", sha: `blob-${index}`, size: file.content.length })),
    };
    if (route === "GET /repos/{owner}/{repo}/git/blobs/{file_sha}") return {
      content: Buffer.from(input().files[Number(String(parameters.file_sha).slice(5))]!.content).toString("base64"), encoding: "base64",
    };
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}" || route === "GET /repos/{owner}/{repo}/issues/{issue_number}") return state.change;
    if (route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}") {
      const observation = observations.get(Number(parameters.run_id));
      if (!observation) throw httpError(404);
      return { id: state.mismatchedRun ? 999 : observation.run.runId, run_attempt: observation.run.runAttempt,
        head_sha: observation.run.headSha, repository: { id: 42 } };
    }
    throw new Error(`Unexpected request: ${route}`);
  });
  const prepare = () => prepareRecipeKnowledge(client, target, recipe, {
    ref: "main", sha: revision, input: { ...input(), truncated: [] },
  }, defaultConfig(), store);
  const record = async (issue = false) => {
    const prepared = await prepare();
    const [id] = await recordRecipeApplications(client, target, prepared, issue ? { issue: 81 } : { pullRequest: 81 });
    return id!;
  };
  const merged = () => Object.assign(state.change, {
    merged: true, state: "closed", merged_at: "2026-11-01T00:00:00Z", closed_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  });
  const samples = async () => {
    const sides = { control: [] as string[], treatment: [] as string[] };
    for (const [side, first, day, seconds] of [["control", 1, "2026-10-20", 60], ["treatment", 11, "2026-11-02", 30]] as const) {
      for (let index = 0; index < 4; index++) {
        const runId = first + index;
        const startedAt = `${day}T0${index}:00:00.000Z`;
        const completedAt = `${day}T0${index}:01:00.000Z`;
        const base = workflow(runId, seconds + index, [["build", seconds + index]]);
        const run = { ...base, headSha: side === "control" ? revision : head, path: ".github/workflows/ci.yml",
          createdAt: startedAt, startedAt, completedAt,
          jobs: base.jobs.map((job) => ({ ...job, startedAt, completedAt })),
          provenance: { ...base.provenance!, collectedAt: completedAt } };
        const observation = createRunObservation(repository, run, { status: "unavailable", reason: "revision-unavailable" }, new Date(completedAt));
        observations.set(runId, observation);
        await store.saveRunObservation(observation);
        sides[side].push(observation.id);
      }
    }
    return sides;
  };
  return { store, recipe, state, client, prepare, record, merged, samples, observations };
}

describe("authenticated mitigation operations", () => {
  it("records published definitions and pinned proposals without inferring project execution", async () => {
    const f = fixture();
    const id = await f.record();
    expect(await f.record()).toBe(id);
    const result = await inspectMitigationKnowledge(f.client, target, async () => f.store, id);
    expect(result.application).toMatchObject({ change: { kind: "pull-request", number: 81, headSha: head }, projectIds: [] });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.state).toBe("proposed");
    expect(result.evaluations).toEqual([]);
    expect(await f.store.listMitigationDefinitions(source, 10)).toHaveLength(1);
    expect("definition" in result).toBe(false);
    expect(f.client.calls.some(({ route, parameters }) => route.endsWith("/contents/{path}") && parameters.ref === "d".repeat(40))).toBe(true);
  });

  it("rejects unpublished/mutated local recipe content before storing any definition or topology", async () => {
    const f = fixture();
    f.state.published = serializeRecipe(sampleRecipe({ instructions: "Different published instructions." }));
    await expect(f.prepare()).rejects.toThrow("differs from its published");
    expect(await f.store.listMitigationDefinitions(source, 10)).toEqual([]);
    expect(await f.store.list({ ...repository, limit: 10 })).toEqual([]);
  });

  it("records merge state without claiming benefit and treats a changed PR head as unknown", async () => {
    const f = fixture();
    const id = await f.record();
    f.merged();
    expect(await refreshMitigationKnowledge(f.client, target, async () => f.store, id)).toMatchObject({ state: "applied", observedAt: "2026-11-01T00:00:00.000Z" });
    f.state.change.head.sha = "e".repeat(40);
    f.state.change.updated_at = "2026-11-02T00:00:00Z";
    expect(await refreshMitigationKnowledge(f.client, target, async () => f.store, id)).toMatchObject({ state: "unknown" });
    expect(await f.record()).toBe(id);
    expect((await f.store.listMitigationApplicationEvents(repository, id, 1))[0]?.state).toBe("unknown");
  });

  it("never translates a completed adaptation issue into an applied optimization", async () => {
    const f = fixture();
    const id = await f.record(true);
    Object.assign(f.state.change, { state: "closed", state_reason: "completed", closed_at: "2026-11-01T00:00:00Z" });
    expect(await refreshMitigationKnowledge(f.client, target, async () => f.store, id)).toMatchObject({ state: "unknown" });
  });

  it("deduplicates change reads and rejects cross-repository bulk refresh without appending events", async () => {
    const f = fixture();
    const id = await f.record();
    const application = (await f.store.loadMitigationApplication(repository, id))!;
    const topology = (await f.store.load(repository, application.topologySnapshotId))!;
    const second = createMitigationApplication({ ...application, projectIds: [topology.projects[0]!.id] });
    await f.store.saveMitigationApplication(second);
    f.merged();
    const before = f.client.calls.length;
    await refreshMitigationApplications(f.client, target, f.store, [application, second]);
    expect(f.client.calls.slice(before).filter(({ route }) => route.includes("/pulls/"))).toHaveLength(1);
    f.state.change.head.sha = "e".repeat(40);
    f.state.change.updated_at = "2026-11-02T00:00:00Z";
    await expect(refreshMitigationApplications(f.client, target, f.store, [
      application, { ...second, target: { ...repository, repositoryId: "99" } },
    ])).rejects.toThrow("target identity changed");
    expect((await f.store.listMitigationApplicationEvents(repository, id, 1))[0]?.state).toBe("applied");
  });

  it("requires contents authorization before touching storage and exact historical revision access before returning data", async () => {
    const f = fixture();
    const id = await f.record();
    const factory = vi.fn(async () => f.store);
    f.state.denied = "GET /repos/{owner}/{repo}/commits/{ref}";
    await expect(listMitigationKnowledge(f.client, target, factory)).rejects.toThrow("HTTP 403");
    expect(factory).not.toHaveBeenCalled();
    f.state.denied = revision;
    await expect(inspectMitigationKnowledge(f.client, target, factory, id)).rejects.toThrow("HTTP 403");
    f.state.denied = "";
    f.state.targetId = 99;
    await expect(inspectMitigationKnowledge(f.client, target, factory, id)).rejects.toThrow("not found");
  });

  it("authorizes each exact Actions attempt before persisting or exposing a measured evaluation", async () => {
    const f = fixture();
    const id = await f.record();
    f.merged();
    await refreshMitigationKnowledge(f.client, target, async () => f.store, id);
    const samples = await f.samples();
    expect((await listRunKnowledge(f.client, target, async () => f.store, 20, 1)).observations.map(({ id }) => id)).toEqual([samples.control[0]]);
    const options = { ...samples, now: new Date("2026-11-03T00:00:00Z") };
    f.state.mismatchedRun = true;
    await expect(evaluateMitigationKnowledge(f.client, target, async () => f.store, id, options)).rejects.toThrow("Actions authorization");
    expect(await f.store.listMitigationEvaluations(repository, id, 10)).toEqual([]);
    f.state.mismatchedRun = false;
    const evaluation = await evaluateMitigationKnowledge(f.client, target, async () => f.store, id, options);
    expect(evaluation.outcome).toBe("observed-faster");
    expect((await inspectMitigationKnowledge(f.client, target, async () => f.store, id)).evaluations).toEqual([evaluation]);
    f.state.denied = "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}";
    await expect(inspectMitigationKnowledge(f.client, target, async () => f.store, id)).rejects.toThrow("HTTP 403");
  });

  it("refreshes recorded proposals during durable runtime collection but not in previews", async () => {
    const f = fixture();
    await f.record();
    f.merged();
    await f.samples();
    const observed = f.observations.get(11)!.run;
    const collected = await collectRunKnowledge(f.client, target, observed, defaultConfig(), { store: f.store });
    expect(collected.mitigations?.events).toEqual([expect.objectContaining({ state: "applied" })]);
    const before = f.client.calls.length;
    const preview = await collectRunKnowledge(f.client, target, observed, defaultConfig());
    expect(preview.mitigations).toBeUndefined();
    expect(f.client.calls.slice(before).some(({ route }) => route.includes("/pulls/"))).toBe(false);
  });

  it.each(["disabled", "unavailable"] as const)("does not refresh proposals with %s source/configuration", async (mode) => {
    const f = fixture();
    await f.record();
    await f.samples();
    const config = defaultConfig();
    if (mode === "disabled") config.recipes.enabled = false;
    else { f.state.denied = head; f.state.deniedStatus = 404; }
    const list = vi.spyOn(f.store, "listMitigationApplications");
    const result = await collectRunKnowledge(f.client, target, f.observations.get(11)!.run, config, { store: f.store });
    expect(result.mitigations).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });

  it("exposes authorized CLI output and refuses malformed selection without printing cached data", async () => {
    const f = fixture();
    const id = await f.record();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = { cwd: ".", env: {}, github: () => f.client, knowledgeStore: async () => f.store,
      stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) };
    expect(await run(["knowledge", "inspect", "--repo", "acme/widgets", "--application", id], io)).toBe(0);
    expect(JSON.parse(stdout[0]!).application.id).toBe(id);
    stdout.length = 0;
    expect(await run(["knowledge", "inspect", "--repo", "acme/widgets", "--application", "wrong"], io)).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("application ID");
  });
});
