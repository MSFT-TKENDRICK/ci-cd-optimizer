import { describe, expect, it, vi } from "vitest";
import { parseMarker, updateMarker } from "../../src/issues/markers.js";
import { scanRepository, type ScanOptions } from "../../src/service/scan.js";
import { listManagedPullRequests } from "../../src/fixes/github.js";
import { applyRecipe } from "../../src/recipes/github.js";
import { sampleRecipe } from "../recipes/fixtures.js";
import { httpError, repo } from "../experiments/fixtures.js";
import { callsTo, CLEAN, fakeApi, MISSING_TIMEOUT, TIMEOUT_ONLY, WORKFLOW, writes, type FakeApiState } from "../service/api.js";

type Phase = "prepare" | "branch" | "finalize";
interface Fault { phase: Phase; after: boolean }

async function fixture(options: { recipe?: boolean; config?: string } = {}) {
  const files = { [WORKFLOW]: MISSING_TIMEOUT };
  const state: FakeApiState = {
    config: options.config ?? `${TIMEOUT_ONLY}fixes:\n  enabled: true\n`,
    refs: { main: files }, pulls: [], branchHeads: {},
  };
  const client = fakeApi(state);
  const scan = (scanOptions: ScanOptions = {}) => scanRepository(client, repo, scanOptions);
  if (options.recipe) await applyRecipe(client, repo, sampleRecipe());
  else await scan();
  const pull = state.pulls?.[0];
  if (!pull || !state.branchHeads) throw new Error("Expected a created PR");
  state.branchHeads[pull.head.ref] = pull.head.sha;
  files[WORKFLOW] += "# changed on base\n";
  const original = client.request.bind(client);
  let commits = 0;
  let fault: Fault | undefined;
  const phases: Phase[] = [];
  client.request = async (route, parameters = {}) => {
    const phase = route === "POST /graphql" ? "branch" :
      route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}" && typeof parameters.body === "string"
        ? parseMarker(parameters.body)?.attributes.pendingCommit ? "prepare" : "finalize" : undefined;
    if (phase) phases.push(phase);
    const fail = fault !== undefined && phase === fault.phase;
    const after = fault?.after;
    if (fail) fault = undefined;
    if (fail && !after) throw httpError(500);
    const response = await original(route, parameters);
    if (fail) throw httpError(500);
    if (route === "POST /repos/{owner}/{repo}/git/commits") return { status: 200, data: { sha: `bot-update-${++commits}` } };
    return response;
  };
  return { state, files, client, pull, scan, phases, fail: (value: Fault) => { fault = value; } };
}

describe("interrupted fix updates", () => {
  it.each((["prepare", "branch", "finalize"] as const).flatMap((phase) => [false, true].map((after) => ({ phase, after }))))(
    "recovers a failure at $phase (write persisted: $after)",
    async ({ phase, after }) => {
      const f = await fixture();
      f.fail({ phase, after });
      await expect(f.scan()).rejects.toThrow("500");
      const branchWritten = phase === "finalize" || (phase === "branch" && after);
      expect(f.pull.head.sha).toBe(branchWritten ? "bot-update-1" : "new-commit");
      if (phase === "prepare") expect(callsTo(f.client, "POST /graphql")).toHaveLength(0);
      if (!(phase === "prepare" && !after) && !(phase === "finalize" && after)) {
        expect(parseMarker(f.pull.body)?.attributes).toMatchObject({
          commit: "new-commit", pendingFrom: "new-commit", pendingCommit: "bot-update-1", pendingBase: "main-sha",
        });
      }
      f.pull.body = `Maintainer preface.\n${f.pull.body}\nMaintainer notes after the interrupted write.`;
      await f.scan();
      expect(parseMarker(f.pull.body)?.attributes.commit).toBe(f.pull.head.sha);
      expect(parseMarker(f.pull.body)?.attributes.pendingCommit).toBeUndefined();
      expect(f.pull.body).not.toContain("Update pending");
      expect(f.pull.body).toContain("Maintainer preface.");
      expect(f.pull.body).toContain("Maintainer notes after the interrupted write.");
      expect(callsTo(f.client, "POST /repos/{owner}/{repo}/pulls")).toHaveLength(1);
      expect(callsTo(f.client, "POST /repos/{owner}/{repo}/git/refs")).toHaveLength(1);
      if (branchWritten) {
        expect(callsTo(f.client, "POST /repos/{owner}/{repo}/git/commits")).toHaveLength(2);
        expect(callsTo(f.client, "POST /graphql")).toHaveLength(1);
      }
      f.client.calls.length = 0;
      await f.scan();
      expect(writes(f.client)).toEqual([]);
    },
  );

  it("persists and confirms the intent before the ref, then finalizes only the marker", async () => {
    const f = await fixture();
    await f.scan();
    expect(f.phases).toEqual(["prepare", "branch", "finalize"]);
    const patches = callsTo(f.client, "PATCH /repos/{owner}/{repo}/pulls/{pull_number}");
    expect(patches[0]?.parameters.title).toBeDefined();
    expect(patches[1]?.parameters.title).toBeUndefined();
    expect(parseMarker(String(patches[0]?.parameters.body))?.attributes.commit).toBe("new-commit");
    expect(parseMarker(String(patches[1]?.parameters.body))?.attributes.commit).toBe("bot-update-1");
  });

  it.each([false, true])("protects a human head on recovery (original ref write completed: %s)", async (completed) => {
    const f = await fixture();
    f.fail({ phase: "branch", after: completed });
    await expect(f.scan()).rejects.toThrow();
    f.pull.head.sha = "human-commit";
    f.state.branchHeads![f.pull.head.ref] = "human-commit";
    f.pull.body += "\nHuman follow-up notes.";
    const before = callsTo(f.client, "POST /graphql").length;
    const result = await f.scan();
    expect(result.fixes?.skipped).toContainEqual({ group: "workflow", number: 42, reason: "edited" });
    expect(f.pull.head.sha).toBe("human-commit");
    expect(f.pull.body).toContain("Human follow-up notes.");
    expect(f.pull.body).toContain("Update interrupted");
    expect(parseMarker(f.pull.body)?.attributes.pendingCommit).toBeUndefined();
    expect(callsTo(f.client, "POST /graphql")).toHaveLength(before);
  });

  it("reports recovery in dry-run without performing any writes", async () => {
    const f = await fixture();
    f.fail({ phase: "finalize", after: false });
    await expect(f.scan()).rejects.toThrow();
    f.client.calls.length = 0;
    const before = f.pull.body;
    const result = await f.scan({ dryRun: true });
    expect(result.fixes?.actions).toEqual([{ type: "metadata", number: 42, group: "workflow", labels: [], reviewers: [], recoverUpdate: true }]);
    expect(result.fixes?.applied).toEqual([]);
    expect(writes(f.client)).toEqual([]);
    expect(f.pull.body).toBe(before);
  });

  it.each(["rebase", "recreate"] as const)("does not repeat an already-applied %s intent on the same base", async (command) => {
    const f = await fixture();
    const options = command === "rebase" ? { rebase: new Set(["workflow"]) } : { recreate: new Set(["workflow"]) };
    f.fail({ phase: "finalize", after: false });
    await expect(f.scan(options)).rejects.toThrow();
    const result = await f.scan(options);
    expect(result.fixes?.actions.map((action) => action.type)).toEqual(["metadata"]);
    expect(callsTo(f.client, "POST /graphql")).toHaveLength(1);
  });

  it.each([false, true])("recomputes current policy rather than replaying stale files (old branch write completed: %s)", async (completed) => {
    const f = await fixture();
    f.fail({ phase: "branch", after: completed });
    await expect(f.scan()).rejects.toThrow();
    f.files[WORKFLOW] = MISSING_TIMEOUT.replace("echo hi", "echo latest-policy");
    const result = await f.scan();
    expect(result.fixes?.actions.map((action) => action.type)).toEqual(["metadata", "update"]);
    expect(f.pull.head.sha).toBe("bot-update-2");
    expect(JSON.stringify(callsTo(f.client, "POST /repos/{owner}/{repo}/git/trees").at(-1)?.parameters)).toContain("latest-policy");
    expect(parseMarker(f.pull.body)?.attributes.commit).toBe("bot-update-2");
  });

  it("settles metadata and closes a now-unnecessary PR without rebuilding it", async () => {
    const f = await fixture();
    f.fail({ phase: "finalize", after: false });
    await expect(f.scan()).rejects.toThrow();
    f.files[WORKFLOW] = CLEAN;
    const result = await f.scan();
    expect(result.fixes?.actions.map((action) => action.type)).toEqual(["metadata", "close"]);
    expect(f.pull.state).toBe("closed");
    expect(callsTo(f.client, "POST /graphql")).toHaveLength(2);
    expect(parseMarker(f.pull.body)?.attributes.cleanupStatus).toBe("deleted");
  });

  it("respects a decline after the branch write but before marker finalization", async () => {
    const f = await fixture();
    f.fail({ phase: "finalize", after: false });
    await expect(f.scan()).rejects.toThrow();
    f.pull.state = "closed";
    const result = await f.scan();
    expect(result.fixes?.actions.map((action) => action.type)).toEqual(["metadata"]);
    expect(result.fixes?.skipped).toContainEqual({ group: "workflow", number: 42, reason: "declined" });
    expect(callsTo(f.client, "POST /repos/{owner}/{repo}/pulls")).toHaveLength(1);
    expect(f.pull.state).toBe("closed");
    expect(parseMarker(f.pull.body)?.attributes.commit).toBe("bot-update-1");
  });

  it("does not plan from a stale issues body paired with a current PR head", async () => {
    const f = await fixture();
    const stale = { ...f.pull, pull_request: {} };
    f.fail({ phase: "finalize", after: false });
    await expect(f.scan()).rejects.toThrow();
    const original = f.client.request.bind(f.client);
    vi.spyOn(f.client, "request").mockImplementation((route, parameters) =>
      route === "GET /repos/{owner}/{repo}/issues" ? Promise.resolve({ status: 200, data: [stale] }) : original(route, parameters));
    const result = await f.scan();
    expect(result.fixes?.actions.map((action) => action.type)).toEqual(["metadata"]);
    expect(parseMarker(f.pull.body)?.attributes.commit).toBe("bot-update-1");
    expect(callsTo(f.client, "POST /graphql")).toHaveLength(1);
  });

  it("fails closed on an incomplete intent rather than forgetting it", async () => {
    const f = await fixture();
    f.pull.body = updateMarker(f.pull.body, "fix", "group:workflow", { pendingCommit: "unknown" });
    f.client.calls.length = 0;
    await expect(listManagedPullRequests(f.client, repo)).rejects.toThrow("Incomplete pending update");
    expect(writes(f.client)).toEqual([]);
  });

  it.each(["head", "marker", "state", "acknowledgement"] as const)("refuses the ref write when %s changes during intent preparation", async (changed) => {
    const f = await fixture();
    const original = f.client.request.bind(f.client);
    vi.spyOn(f.client, "request").mockImplementation(async (route, parameters = {}) => {
      const preparing = route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}" &&
        typeof parameters.body === "string" && parseMarker(parameters.body)?.attributes.pendingCommit;
      if (preparing && changed === "acknowledgement") return { status: 200, data: {} };
      const response = await original(route, parameters);
      if (preparing) {
        if (changed === "head") f.pull.head.sha = "human-commit";
        if (changed === "marker") f.pull.body = updateMarker(f.pull.body, "fix", "group:workflow", { ignored: "workflow/job-timeout" });
        if (changed === "state") f.pull.state = "closed";
      }
      return response;
    });
    await expect(f.scan()).rejects.toThrow("changed since planning");
    expect(callsTo(f.client, "POST /graphql")).toHaveLength(0);
  });

  it("fails recovery without dropping the intent if the marker changes after cached discovery", async () => {
    const f = await fixture();
    f.fail({ phase: "finalize", after: false });
    await expect(f.scan()).rejects.toThrow();
    const original = f.client.request.bind(f.client);
    let discovered = false;
    let injected = false;
    vi.spyOn(f.client, "request").mockImplementation(async (route, parameters = {}) => {
      if (discovered && !injected && route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        injected = true;
        f.pull.body = updateMarker(f.pull.body, "fix", "group:workflow", { pendingCommit: "different-intent" });
      }
      const response = await original(route, parameters);
      if (route === "GET /repos/{owner}/{repo}/pulls" && parameters.state === "all" && parameters.head === `${repo.owner}:${f.pull.head.ref}`) {
        discovered = true;
      }
      return response;
    });
    await expect(f.scan()).rejects.toThrow("changed since planning");
    expect(injected).toBe(true);
    expect(parseMarker(f.pull.body)?.attributes.pendingCommit).toBe("different-intent");
    expect(callsTo(f.client, "POST /graphql")).toHaveLength(1);
  });

  it("rejects damaged generated-body boundaries before writing a ref", async () => {
    const f = await fixture();
    f.pull.body = f.pull.body.replace("<!-- cicd-optimizer:fix-body-end -->", "");
    await expect(f.scan()).rejects.toThrow("body boundaries changed");
    expect(callsTo(f.client, "POST /graphql")).toHaveLength(0);
  });

  it("preserves draft reviewer intent through a rebuild and finishes it after readiness", async () => {
    const f = await fixture({ config: `${TIMEOUT_ONLY}fixes:\n  enabled: true\n  draft: true\n  reviewers: [alice]\n` });
    f.fail({ phase: "finalize", after: false });
    await expect(f.scan()).rejects.toThrow();
    expect(parseMarker(f.pull.body)?.attributes.pendingReviewers).toBe("alice");
    f.pull.draft = false;
    await f.scan();
    expect(parseMarker(f.pull.body)?.attributes.pendingCommit).toBeUndefined();
    expect(parseMarker(f.pull.body)?.attributes.pendingReviewers).toBeUndefined();
    expect(f.pull.requested_reviewers).toEqual([{ login: "alice" }]);
    expect(callsTo(f.client, "POST /graphql")).toHaveLength(1);
  });

  it("retains the staged recipe revision, renderer, and later body edits during recovery", async () => {
    const f = await fixture({ recipe: true });
    f.fail({ phase: "finalize", after: false });
    const recipe = sampleRecipe({ revision: 2 });
    await expect(applyRecipe(f.client, repo, recipe)).rejects.toThrow();
    expect(f.pull.body).toContain("cicd-optimizer:recipe");
    f.pull.body += "\nRecipe rollout review notes.";
    await applyRecipe(f.client, repo, recipe);
    expect(f.pull.body).toContain("revision=2");
    expect(f.pull.body).toContain("Recipe rollout review notes.");
    expect(parseMarker(f.pull.body)?.attributes.commit).toBe("bot-update-1");
    expect(callsTo(f.client, "POST /graphql")).toHaveLength(1);
  });
});
