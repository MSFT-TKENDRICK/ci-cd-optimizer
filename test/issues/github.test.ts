import { describe, expect, it } from "vitest";
import { ensureLabels, type GitHubClient } from "../../src/github/client.js";
import { applyIssueActions, assignCopilot, COPILOT_LOGIN, listManagedIssues } from "../../src/issues/github.js";
import { marker } from "../../src/issues/markers.js";
import type { DesiredIssue } from "../../src/issues/plan.js";

interface Call {
  route: string;
  parameters: Record<string, unknown>;
}

function fakeClient(handler: (route: string, parameters: Record<string, unknown>) => unknown = () => ({})): GitHubClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async request(route, parameters = {}) {
      calls.push({ route, parameters });
      return { status: 200, data: handler(route, parameters) };
    },
  };
}

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

const repo = { owner: "acme", repo: "widgets" };

function desired(overrides: Partial<DesiredIssue> = {}): DesiredIssue {
  return {
    fingerprint: "rule:x",
    signature: "s1",
    title: "Title",
    body: marker("finding", "rule:x", { signature: "s1" }),
    labels: ["cicd-optimizer", "severity:error"],
    assignees: [],
    assignCopilot: false,
    priority: 1,
    ...overrides,
  };
}

describe("listManagedIssues", () => {
  it("returns only issues with a marker of the requested kind, excluding pull requests", async () => {
    const client = fakeClient((route) =>
      route.startsWith("GET /repos/{owner}/{repo}/issues")
        ? [
            { number: 1, title: "a", state: "open", body: marker("finding", "rule:a", { signature: "s" }) },
            { number: 2, title: "b", state: "closed", state_reason: "not_planned", closed_at: "2026-01-01T00:00:00Z", body: marker("alert", "duration:1") },
            { number: 3, title: "c", state: "open", body: marker("finding", "rule:c"), pull_request: {} },
            { number: 4, title: "d", state: "open", body: "manual issue" },
          ]
        : [],
    );
    const findings = await listManagedIssues(client, repo, "finding");
    expect(findings).toEqual([{ number: 1, title: "a", state: "open", stateReason: null, closedAt: null, fingerprint: "rule:a", attributes: { signature: "s" }, signature: "s" }]);
    const alerts = await listManagedIssues(client, repo, "alert");
    expect(alerts.map((issue) => [issue.number, issue.stateReason, issue.closedAt])).toEqual([[2, "not_planned", "2026-01-01T00:00:00Z"]]);
    expect(client.calls[0]?.parameters).toMatchObject({ state: "all", labels: "cicd-optimizer", per_page: 100, page: 1 });
  });
});

describe("ensureLabels", () => {
  it("creates only missing labels and tolerates concurrent creation", async () => {
    const client = fakeClient((route, parameters) => {
      if (route.startsWith("GET")) return [{ name: "CICD-Optimizer" }];
      if (parameters.name === "severity:error") throw httpError(422);
      return {};
    });
    await ensureLabels(client, repo, ["cicd-optimizer", "severity:error", "ruleset:caching", "ruleset:caching"]);
    expect(client.calls.filter((call) => call.route.startsWith("POST")).map((call) => [call.parameters.name, call.parameters.color])).toEqual([
      ["severity:error", "b60205"],
      ["ruleset:caching", "1d76db"],
    ]);
  });
});

describe("assignCopilot", () => {
  it("assigns the Copilot coding agent with a user token and agent options", async () => {
    const issueClient = fakeClient();
    const userClient = fakeClient();
    const result = await assignCopilot(issueClient, userClient, repo, 5, { baseBranch: "main", customInstructions: "Keep diffs small" });
    expect(result).toBe("assigned");
    expect(userClient.calls).toEqual([
      {
        route: "POST /repos/{owner}/{repo}/issues/{issue_number}/assignees",
        parameters: {
          ...repo,
          issue_number: 5,
          assignees: [COPILOT_LOGIN],
          agent_assignment: { target_repo: "acme/widgets", base_branch: "main", custom_instructions: "Keep diffs small" },
        },
      },
    ]);
    expect(issueClient.calls).toEqual([]);
  });

  it("falls back to the copilot:ready label without a user token or when assignment is refused", async () => {
    const issueClient = fakeClient();
    expect(await assignCopilot(issueClient, undefined, repo, 5, {})).toBe("labeled");
    const refusing = fakeClient(() => {
      throw httpError(403);
    });
    expect(await assignCopilot(issueClient, refusing, repo, 6, {})).toBe("labeled");
    expect(issueClient.calls.map((call) => [call.route, call.parameters.issue_number, call.parameters.labels])).toEqual([
      ["POST /repos/{owner}/{repo}/issues/{issue_number}/labels", 5, ["copilot:ready"]],
      ["POST /repos/{owner}/{repo}/issues/{issue_number}/labels", 6, ["copilot:ready"]],
    ]);
  });

  it("propagates unexpected errors from the assignment API", async () => {
    const broken = fakeClient(() => {
      throw httpError(500);
    });
    await expect(assignCopilot(fakeClient(), broken, repo, 5, {})).rejects.toThrow("HTTP 500");
  });
});

describe("applyIssueActions", () => {
  it("creates, updates, reopens and closes issues and assigns Copilot to new work", async () => {
    let next = 100;
    const client = fakeClient((route) => {
      if (route === "GET /repos/{owner}/{repo}/labels") return [];
      if (route === "POST /repos/{owner}/{repo}/issues") return { number: next++ };
      return {};
    });
    const applied = await applyIssueActions(client, repo, [
      { type: "create", desired: desired({ assignCopilot: true, assignees: ["octocat"] }) },
      { type: "update", number: 7, desired: desired({ assignCopilot: true }), comment: "changed" },
      { type: "reopen", number: 8, desired: desired() },
      { type: "close", number: 9, fingerprint: "rule:y", comment: "resolved" },
    ]);
    expect(applied.map((entry) => [entry.action.type, entry.number, entry.copilot])).toEqual([
      ["create", 100, "labeled"],
      ["update", 7, undefined],
      ["reopen", 8, undefined],
      ["close", 9, undefined],
    ]);
    const writes = client.calls.filter((call) => !call.route.startsWith("GET") && call.route !== "POST /repos/{owner}/{repo}/labels");
    expect(writes.map((call) => [call.route, call.parameters.issue_number, call.parameters.state])).toEqual([
      ["POST /repos/{owner}/{repo}/issues", undefined, undefined],
      ["POST /repos/{owner}/{repo}/issues/{issue_number}/labels", 100, undefined],
      ["PATCH /repos/{owner}/{repo}/issues/{issue_number}", 7, undefined],
      ["POST /repos/{owner}/{repo}/issues/{issue_number}/comments", 7, undefined],
      ["PATCH /repos/{owner}/{repo}/issues/{issue_number}", 8, "open"],
      ["POST /repos/{owner}/{repo}/issues/{issue_number}/comments", 9, undefined],
      ["PATCH /repos/{owner}/{repo}/issues/{issue_number}", 9, "closed"],
    ]);
    expect(client.calls.find((call) => call.route === "POST /repos/{owner}/{repo}/issues")?.parameters.assignees).toEqual(["octocat"]);
    const createdLabels = client.calls.filter((call) => call.route === "POST /repos/{owner}/{repo}/labels").map((call) => call.parameters.name);
    expect(createdLabels).toEqual(["cicd-optimizer", "severity:error", "copilot:ready"]);
  });
});
