import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { marker, parseMarker } from "../../src/issues/markers.js";
import { describeScan, scanRepository } from "../../src/service/scan.js";
import { fakeClient, repo } from "../experiments/fixtures.js";
import { callsTo, CLEAN, fakeApi, MISSING_TIMEOUT, TIMEOUT_ONLY, WORKFLOW, writes, type FakeApiState } from "./api.js";

const enabled = `${TIMEOUT_ONLY}issues:\n  enabled: true\nfixes:\n  enabled: true\n`;
const findingIssue = (number: number, fingerprint: string, state = "open") => ({
  number,
  title: "workflow/job-timeout",
  state,
  body: marker("finding", fingerprint, { rule: "workflow/job-timeout" }),
  labels: [{ name: "cicd-optimizer" }],
});

describe("scanRepository", () => {
  it("reports invalid configuration without linting", async () => {
    const client = fakeApi({ config: "rules:\n  workflow/job-timout: error\n", refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } } });
    const scan = await scanRepository(client, repo);
    expect(scan.status).toBe("invalid-config");
    expect(scan.configProblems?.[0]).toContain('Did you mean "workflow/job-timeout"?');
    expect(client.calls.some((call) => call.route.includes("/git/trees"))).toBe(false);
    expect(describeScan(scan)).toContain("invalid configuration");
  });

  it("does nothing when disabled", async () => {
    const scan = await scanRepository(fakeApi({ config: "enabled: false\n" }), repo);
    expect(scan.status).toBe("disabled");
    expect(describeScan(scan)).toBe("acme/widgets: disabled by configuration.");
  });

  it("lints the default branch without writing when issues and fixes are off (the defaults)", async () => {
    const client = fakeApi({ config: TIMEOUT_ONLY, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } } });
    const scan = await scanRepository(client, repo);
    expect(scan).toMatchObject({ status: "scanned", ref: "main", sha: "main-sha", inventoryComplete: true });
    expect(scan.result?.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual(["workflow/job-timeout"]);
    expect(scan.issues).toBeUndefined();
    expect(scan.fixes).toBeUndefined();
    expect(writes(client)).toHaveLength(0);
    expect(describeScan(scan)).toBe("acme/widgets@main: 1 error(s), 0 warning(s), 0 info");
  });

  it("uploads SARIF for the scanned commit", async () => {
    const client = fakeApi({ config: TIMEOUT_ONLY, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } } });
    const scan = await scanRepository(client, repo, { uploadSarif: true });
    expect(scan.sarif).toEqual({ status: "uploaded", id: "sarif-1" });
    const upload = callsTo(client, "POST /repos/{owner}/{repo}/code-scanning/sarifs")[0];
    expect(upload?.parameters).toMatchObject({ commit_sha: "main-sha", ref: "refs/heads/main" });
    const sarif = JSON.parse(gunzipSync(Buffer.from(upload?.parameters.sarif as string, "base64")).toString("utf8"));
    expect(sarif.runs[0].results[0].ruleId).toBe("workflow/job-timeout");
    expect(describeScan(scan)).toContain("SARIF uploaded");
  });

  it("treats code scanning being unavailable as a soft outcome", async () => {
    const client = fakeApi({ config: TIMEOUT_ONLY, refs: { main: { [WORKFLOW]: CLEAN } }, sarifStatus: 403 });
    const scan = await scanRepository(client, repo, { uploadSarif: true });
    expect(scan.sarif?.status).toBe("unavailable");
  });

  it("opens finding issues and fix pull requests on the default branch", async () => {
    const client = fakeApi({ config: enabled, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } } });
    const scan = await scanRepository(client, repo);
    expect(scan.issues?.actions.map((action) => action.type)).toEqual(["create"]);
    expect(scan.fixes?.actions.map((action) => action.type)).toEqual(["create"]);
    const issue = callsTo(client, "POST /repos/{owner}/{repo}/issues")[0];
    expect(parseMarker(issue?.parameters.body as string)?.kind).toBe("finding");
    const tree = callsTo(client, "POST /repos/{owner}/{repo}/git/trees")[0];
    expect(JSON.stringify(tree?.parameters)).toContain("timeout-minutes");
    expect(callsTo(client, "POST /repos/{owner}/{repo}/pulls")[0]?.parameters).toMatchObject({ base: "main" });
    expect(describeScan(scan)).toContain("issues: 1 create · fix PRs: 1 create");
  });

  it("plans but does not write in dry-run mode", async () => {
    const client = fakeApi({ config: enabled, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } } });
    const scan = await scanRepository(client, repo, { dryRun: true, uploadSarif: true });
    expect(scan.sarif).toEqual({ status: "skipped" });
    expect(scan.issues?.actions).toHaveLength(1);
    expect(scan.issues?.applied).toEqual([]);
    expect(scan.fixes?.actions).toHaveLength(1);
    expect(writes(client)).toHaveLength(0);
  });

  it("reports blocked agent handoff without rewriting unchanged pending findings on every scan", async () => {
    const config = `${TIMEOUT_ONLY}issues:\n  enabled: true\n  assignCopilot: true\n`;
    const first = await scanRepository(fakeApi({ config, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } } }), repo);
    expect(describeScan(first)).toContain("awaiting assignment");
    const action = first.issues?.actions[0];
    if (action?.type !== "create") throw new Error("Expected finding creation");
    const pending = { number: 13, state: "open", title: action.desired.title, body: action.desired.body, labels: ["cicd-optimizer", "copilot:ready"] };
    const client = fakeApi({ config, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } }, issues: [pending] });
    const next = await scanRepository(client, repo);
    expect(next.issues?.actions).toEqual([]);
    expect(next.issues?.awaitingCopilot).toEqual([13]);
    expect(writes(client)).toEqual([]);
    expect(describeScan(next)).toContain("1 issue(s) awaiting assignment");
    expect(describeScan(next)).toContain("COPILOT_ASSIGN_TOKEN");
    expect(describeScan(next)).toContain("no changes");
  });

  it("still requests assignment of pending findings when an assignment token is configured", async () => {
    const config = `${TIMEOUT_ONLY}issues:\n  enabled: true\n  assignCopilot: true\n`;
    const first = await scanRepository(fakeApi({ config, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } } }), repo);
    const action = first.issues?.actions[0];
    if (action?.type !== "create") throw new Error("Expected finding creation");
    const pending = { number: 13, state: "open", title: action.desired.title, body: action.desired.body, labels: ["cicd-optimizer", "copilot:ready"] };
    const client = fakeApi({ config, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } }, issues: [pending] });
    const user = fakeClient(() => ({ assignees: [{ login: "Copilot" }] }));
    const next = await scanRepository(client, repo, { copilotClient: user });
    expect(next.issues?.actions).toMatchObject([{ type: "assign", number: 13 }]);
    expect(next.issues?.awaitingCopilot).toBeUndefined();
    expect(next.issues?.applied).toMatchObject([{ copilot: "assigned" }]);
    expect(callsTo(client, "PATCH /repos/{owner}/{repo}/issues/{issue_number}")).toEqual([]);
    expect(callsTo(client, "POST /repos/{owner}/{repo}/issues")).toEqual([]);
    expect(describeScan(next)).not.toContain("COPILOT_ASSIGN_TOKEN");
  });

  it("reports metadata repair in dry-run mode without performing it", async () => {
    let failLabels = true;
    const state: FakeApiState = {
      config: `${TIMEOUT_ONLY}fixes:\n  enabled: true\n`, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } }, pulls: [],
      failOn: (route) => failLabels && route === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
    };
    const client = fakeApi(state);
    await expect(scanRepository(client, repo)).rejects.toThrow("500");
    failLabels = false;
    client.calls.length = 0;
    const scan = await scanRepository(client, repo, { dryRun: true });
    expect(scan.fixes?.actions).toEqual([{ type: "metadata", number: 42, group: "workflow", labels: ["cicd-optimizer"], reviewers: [] }]);
    expect(scan.fixes?.skipped[0]?.reason).toBe("up-to-date");
    expect(describeScan(scan)).toContain("fix PRs: 1 metadata");
    expect(writes(client)).toHaveLength(0);
  });

  it("respects a PR declined after creation but before successful labeling", async () => {
    const state: FakeApiState = {
      config: `${TIMEOUT_ONLY}fixes:\n  enabled: true\n`, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } }, pulls: [],
      failOn: (route) => route === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
    };
    const client = fakeApi(state);
    await expect(scanRepository(client, repo)).rejects.toThrow("500");
    const pull = state.pulls?.[0];
    if (!pull) throw new Error("Expected created PR");
    pull.state = "closed";
    client.calls.length = 0;
    const scan = await scanRepository(client, repo);
    expect(scan.fixes?.skipped).toEqual([{ group: "workflow", number: 42, reason: "declined" }]);
    expect(writes(client)).toHaveLength(0);
  });

  it("closes resolved finding issues once the finding is gone", async () => {
    const client = fakeApi({ config: `${TIMEOUT_ONLY}issues:\n  enabled: true\n`, refs: { main: { [WORKFLOW]: CLEAN } }, issues: [findingIssue(7, "rule:workflow/job-timeout")] });
    const scan = await scanRepository(client, repo);
    expect(scan.issues?.actions).toEqual([expect.objectContaining({ type: "close", number: 7 })]);
    expect(callsTo(client, "PATCH /repos/{owner}/{repo}/issues/{issue_number}")[0]?.parameters).toMatchObject({ issue_number: 7, state: "closed" });
  });

  it("honors per-call opt-outs", async () => {
    const client = fakeApi({ config: enabled, refs: { main: { [WORKFLOW]: MISSING_TIMEOUT } } });
    const scan = await scanRepository(client, repo, { issues: false, fixes: false });
    expect(scan.issues).toBeUndefined();
    expect(scan.fixes).toBeUndefined();
    expect(writes(client)).toHaveLength(0);
  });

  it("only lints other refs (issues and fixes track the default branch)", async () => {
    const client = fakeApi({ config: enabled, refs: { main: { [WORKFLOW]: CLEAN }, feature: { [WORKFLOW]: MISSING_TIMEOUT } } });
    const scan = await scanRepository(client, repo, { ref: "feature" });
    expect(scan.ref).toBe("feature");
    expect(scan.result?.diagnostics).toHaveLength(1);
    expect(scan.issues).toBeUndefined();
    expect(scan.fixes).toBeUndefined();
  });

  it("leaves recipe pull requests to their rollout", async () => {
    const recipePull = {
      number: 30,
      title: "ci: recipe",
      state: "open",
      body: `${marker("fix", "group:recipe-job-timeouts", { signature: "old", commit: "x" })}\n${marker("recipe", "job-timeouts", { revision: "1" })}`,
      labels: [{ name: "cicd-optimizer" }],
      pull_request: { merged_at: null },
    };
    const client = fakeApi({ config: `${TIMEOUT_ONLY}fixes:\n  enabled: true\n`, refs: { main: { [WORKFLOW]: CLEAN } }, issues: [recipePull] });
    const scan = await scanRepository(client, repo);
    expect(scan.fixes?.actions).toEqual([]);
    expect(writes(client)).toHaveLength(0);
  });
});
