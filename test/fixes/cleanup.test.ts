import { describe, expect, it, vi } from "vitest";
import { handleFixCommands, listManagedPullRequests } from "../../src/fixes/github.js";
import { parseMarker, updateMarker } from "../../src/issues/markers.js";
import { scanRepository, type ScanOptions } from "../../src/service/scan.js";
import { applyRecipe } from "../../src/recipes/github.js";
import { sampleRecipe } from "../recipes/fixtures.js";
import { httpError, repo } from "../experiments/fixtures.js";
import { callsTo, CLEAN, fakeApi, MISSING_TIMEOUT, TIMEOUT_ONLY, WORKFLOW, writes, type FakeApiState } from "../service/api.js";

type Phase = "close" | "delete" | "record";

async function fixture(recipe = false) {
  const files = { [WORKFLOW]: MISSING_TIMEOUT };
  const heads: Record<string, string> = {};
  const state: FakeApiState = { config: `${TIMEOUT_ONLY}fixes:\n  enabled: true\n`, refs: { main: files }, pulls: [], branchHeads: heads };
  const client = fakeApi(state);
  const scan = (options: ScanOptions = {}) => scanRepository(client, repo, options);
  if (recipe) await applyRecipe(client, repo, sampleRecipe());
  else await scan();
  const pull = state.pulls?.[0];
  if (!pull) throw new Error("Expected a fix PR");
  files[WORKFLOW] = CLEAN;
  const original = client.request.bind(client);
  let fault: { phase: Phase; after: boolean } | undefined;
  client.request = async (route, parameters = {}) => {
    const attrs = typeof parameters.body === "string" ? parseMarker(parameters.body)?.attributes : undefined;
    const phase = route === "POST /graphql" ? "delete" : route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}"
      ? parameters.state === "closed" ? "close" : attrs?.cleanupStatus && attrs.cleanupStatus !== "pending" ? "record" : undefined : undefined;
    const failed = fault !== undefined && fault.phase === phase;
    const after = fault?.after;
    if (failed) fault = undefined;
    if (failed && !after) throw httpError(500);
    const result = await original(route, parameters);
    if (failed) throw httpError(500);
    return result;
  };
  const command = async (type: "close" | "ignore-group") => {
    const managed = (await listManagedPullRequests(client, repo)).find((candidate) => candidate.number === pull.number);
    if (!managed) throw new Error("Expected a managed PR");
    return handleFixCommands(client, repo, managed, [{ type }]);
  };
  return { files, heads, state, client, pull, scan, command, fail: (phase: Phase, after = false) => { fault = { phase, after }; } };
}

describe("conditional fix branch cleanup", () => {
  it("records the target in the close request and removes only that ref", async () => {
    const f = await fixture();
    await f.scan();
    expect(f.pull.state).toBe("closed");
    expect(f.heads[f.pull.head.ref]).toBeUndefined();
    const patches = callsTo(f.client, "PATCH /repos/{owner}/{repo}/pulls/{pull_number}");
    expect(patches[0]?.parameters.state).toBe("closed");
    expect(parseMarker(String(patches[0]?.parameters.body))?.attributes).toMatchObject({ cleanupHead: "new-commit", cleanupStatus: "pending" });
    expect(parseMarker(f.pull.body)?.attributes.cleanupStatus).toBe("deleted");
    f.client.calls.length = 0;
    await f.scan();
    expect(writes(f.client)).toEqual([]);
  });

  it.each((["close", "delete", "record"] as const).flatMap((phase) => [false, true].map((after) => ({ phase, after }))))(
    "recovers $phase failure (write persisted: $after)",
    async ({ phase, after }) => {
      const f = await fixture();
      f.fail(phase, after);
      await expect(f.scan()).rejects.toThrow("500");
      f.pull.body += "\nNotes added while cleanup was interrupted.";
      if (!(phase === "close" && !after)) expect(parseMarker(f.pull.body)?.attributes.cleanupHead).toBe("new-commit");
      await f.scan();
      expect(f.pull.state).toBe("closed");
      expect(f.heads[f.pull.head.ref]).toBeUndefined();
      expect(["deleted", "missing"]).toContain(parseMarker(f.pull.body)?.attributes.cleanupStatus);
      expect(f.pull.body).toContain("Notes added while cleanup was interrupted.");
      expect(callsTo(f.client, "POST /graphql")).toHaveLength(1);
      f.client.calls.length = 0;
      await f.scan();
      expect(writes(f.client)).toEqual([]);
    },
  );

  it("does not adopt a racing human head when retrying a failed deletion", async () => {
    const f = await fixture();
    const original = f.client.request.bind(f.client);
    vi.spyOn(f.client, "request").mockImplementation((route, parameters) => {
      if (route === "POST /graphql") { f.heads[f.pull.head.ref] = "human"; f.pull.head.sha = "human"; }
      return original(route, parameters);
    });
    await expect(f.scan()).rejects.toThrow("expected commit");
    expect(parseMarker(f.pull.body)?.attributes.cleanupHead).toBe("new-commit");
    await f.scan();
    expect(f.heads[f.pull.head.ref]).toBe("human");
    expect(parseMarker(f.pull.body)?.attributes).toMatchObject({ cleanupHead: "new-commit", cleanupStatus: "changed" });
    expect(f.pull.body).toContain("Branch retained");
    expect(callsTo(f.client, "POST /graphql")).toHaveLength(1);
    expect(f.client.calls.some((call) => call.route.startsWith("DELETE"))).toBe(false);
  });

  it("preserves a new head that appeared after deletion but before outcome recording", async () => {
    const f = await fixture();
    f.fail("record");
    await expect(f.scan()).rejects.toThrow();
    f.heads[f.pull.head.ref] = "new-human-branch";
    await f.scan();
    expect(f.heads[f.pull.head.ref]).toBe("new-human-branch");
    expect(parseMarker(f.pull.body)?.attributes.cleanupStatus).toBe("changed");
    expect(callsTo(f.client, "POST /graphql")).toHaveLength(1);
  });

  it("never repeats a terminal cleanup even if the same head is recreated", async () => {
    const f = await fixture();
    await f.scan();
    f.heads[f.pull.head.ref] = "new-commit";
    f.client.calls.length = 0;
    await f.command("close");
    await f.scan();
    expect(f.heads[f.pull.head.ref]).toBe("new-commit");
    expect(callsTo(f.client, "POST /graphql")).toEqual([]);
    expect(callsTo(f.client, "GET /repos/{owner}/{repo}/git/ref/{ref}")).toEqual([]);
  });

  it("retains a cleanup target used by another open PR, even at the same commit", async () => {
    const f = await fixture();
    f.fail("delete");
    await expect(f.scan()).rejects.toThrow();
    f.state.pulls!.push({ ...structuredClone(f.pull), number: 99, body: "An unrelated open PR", labels: [], state: "open" });
    await f.scan();
    expect(f.heads[f.pull.head.ref]).toBe("new-commit");
    expect(parseMarker(f.pull.body)?.attributes.cleanupStatus).toBe("in-use");
    expect(callsTo(f.client, "POST /graphql")).toEqual([]);
  });

  it("holds a reopened PR rather than deleting or closing it again on retry", async () => {
    const f = await fixture();
    f.fail("delete");
    await expect(f.scan()).rejects.toThrow();
    f.pull.state = "open";
    const result = await f.scan();
    expect(result.fixes?.skipped).toContainEqual({ group: "workflow", number: 42, reason: "reopened" });
    expect(f.pull.state).toBe("open");
    expect(parseMarker(f.pull.body)?.attributes.cleanupStatus).toBe("reopened");
    f.client.calls.length = 0;
    await f.scan();
    expect(writes(f.client)).toEqual([]);
    await f.command("close");
    expect(f.pull.state).toBe("closed");
    expect(f.heads[f.pull.head.ref]).toBeUndefined();
  });

  it("lets explicit rebase resume a reopened, unedited PR and clear its cleanup history", async () => {
    const f = await fixture();
    f.fail("delete");
    await expect(f.scan()).rejects.toThrow();
    f.pull.state = "open";
    f.files[WORKFLOW] = `${MISSING_TIMEOUT}# changed\n`;
    await f.scan();
    const result = await f.scan({ rebase: new Set(["workflow"]) });
    expect(result.fixes?.actions.map((action) => action.type)).toEqual(["update"]);
    expect(parseMarker(f.pull.body)?.attributes.cleanupStatus).toBeUndefined();
    expect(f.pull.body).not.toContain("cicd-optimizer:cleanup");
    expect(f.pull.state).toBe("open");
  });

  it("shows pending cleanup in dry-run without changing anything", async () => {
    const f = await fixture();
    f.fail("delete");
    await expect(f.scan()).rejects.toThrow();
    f.client.calls.length = 0;
    const result = await f.scan({ dryRun: true });
    expect(result.fixes?.actions).toEqual([{ type: "metadata", number: 42, group: "workflow", labels: [], reviewers: [], cleanup: true }]);
    expect(writes(f.client)).toEqual([]);
    expect(f.heads[f.pull.head.ref]).toBe("new-commit");
  });

  it.each(["close", "ignore-group"] as const)("retries %s with the original recorded target", async (type) => {
    const f = await fixture();
    f.fail("delete");
    await expect(f.command(type)).rejects.toThrow();
    f.heads[f.pull.head.ref] = "human";
    f.pull.head.sha = "human";
    await f.command(type);
    expect(parseMarker(f.pull.body)?.attributes).toMatchObject({ cleanupHead: "new-commit", cleanupStatus: "changed" });
    expect(f.heads[f.pull.head.ref]).toBe("human");
    if (type === "ignore-group") expect(f.pull.labels).toContain("cicd-optimizer:ignored");
  });

  it("does not invent a cleanup target for a legacy closed PR", async () => {
    const f = await fixture();
    f.pull.state = "closed";
    const result = await f.command("close");
    expect(result.replies.join(" ")).toContain("No recorded cleanup target");
    expect(f.heads[f.pull.head.ref]).toBe("new-commit");
    expect(callsTo(f.client, "POST /graphql")).toEqual([]);
  });

  it("refuses incomplete cleanup markers and base-branch deletion", async () => {
    const f = await fixture();
    const oldBody = f.pull.body;
    f.pull.body = updateMarker(oldBody, "fix", "group:workflow", { cleanupHead: "new-commit" });
    await expect(f.scan()).rejects.toThrow("Incomplete branch cleanup");
    f.pull.body = oldBody;
    f.pull.head.ref = "main";
    f.heads.main = "new-commit";
    await expect(f.scan()).rejects.toThrow("base branch");
    expect(f.pull.state).toBe("open");
    expect(callsTo(f.client, "POST /graphql")).toEqual([]);
  });

  it("runs the same recoverable cleanup for recipe PRs", async () => {
    const f = await fixture(true);
    f.fail("record");
    await expect(applyRecipe(f.client, repo, sampleRecipe())).rejects.toThrow();
    await applyRecipe(f.client, repo, sampleRecipe());
    expect(parseMarker(f.pull.body)?.attributes.cleanupStatus).toBe("missing");
    expect(f.pull.body).toContain("cicd-optimizer:recipe");
    expect(callsTo(f.client, "POST /graphql")).toHaveLength(1);
  });
});
