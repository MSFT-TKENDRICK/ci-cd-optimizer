import { describe, expect, it, vi } from "vitest";
import { marker } from "../../src/issues/markers.js";
import { handleIssueComment, type IssueCommentPayload } from "../../src/service/comments.js";
import { httpError, repo } from "../experiments/fixtures.js";
import { callsTo, CLEAN, fakeApi, TIMEOUT_ONLY, WORKFLOW, writes } from "./api.js";

const managedPull = (group = "workflow", number = 12) => ({
  number,
  title: "ci: workflow fixes",
  state: "open",
  body: `${marker("fix", `group:${group}`, { signature: "s", commit: "c", rules: "workflow/job-timeout" })}\nBody`,
  labels: [{ name: "cicd-optimizer" }],
  pull_request: { merged_at: null },
});

const payload = (body: string, overrides: Partial<IssueCommentPayload["comment"]> = {}, issue: IssueCommentPayload["issue"] = { number: 12, pull_request: {} }): IssueCommentPayload => ({
  issue,
  comment: { body, author_association: "MEMBER", user: { login: "octocat", type: "User" }, ...overrides },
});

const comments = (client: ReturnType<typeof fakeApi>) =>
  callsTo(client, "POST /repos/{owner}/{repo}/issues/{issue_number}/comments").map((call) => call.parameters.body as string);

describe("handleIssueComment", () => {
  it("ignores issues, bots, comments without commands, and unmanaged pull requests", async () => {
    const client = fakeApi({ issues: [managedPull()] });
    expect((await handleIssueComment(client, repo, payload("@cicd-optimizer rebase", {}, { number: 12 }))).reason).toBe("Not a pull request.");
    expect((await handleIssueComment(client, repo, payload("@cicd-optimizer rebase", { user: { login: "ci", type: "Bot" } }))).reason).toBe("Comment from a bot.");
    expect((await handleIssueComment(client, repo, payload("thanks!"))).reason).toBe("No commands.");
    expect((await handleIssueComment(client, repo, payload("@cicd-optimizer rebase", {}, { number: 99, pull_request: {} }))).reason).toBe(
      "Not a pull request managed by this app.",
    );
    expect(writes(client)).toHaveLength(0);
  });

  it("refuses commands from users without push access", async () => {
    const client = fakeApi({ issues: [managedPull()], collaboratorPermission: "read" });
    const result = await handleIssueComment(client, repo, payload("@cicd-optimizer close", { author_association: "CONTRIBUTOR" }));
    expect(result.status).toBe("unauthorized");
    expect(comments(client)).toEqual(["Sorry @octocat, only users with push access to this repository can use `@cicd-optimizer` commands."]);
    expect(callsTo(client, "PATCH /repos/{owner}/{repo}/pulls/{pull_number}")).toHaveLength(0);
  });

  it.each(["OWNER", "MEMBER", "COLLABORATOR"])("does not trust %s association when current access is read-only", async (association) => {
    const client = fakeApi({ issues: [managedPull()], collaboratorPermission: "read" });
    expect((await handleIssueComment(client, repo, payload("@cicd-optimizer recreate", { author_association: association }))).status).toBe("unauthorized");
    expect(callsTo(client, "GET /repos/{owner}/{repo}/collaborators/{username}/permission")[0]?.parameters).toMatchObject({ ...repo, username: "octocat" });
    expect(writes(client).map((call) => call.route)).toEqual(["POST /repos/{owner}/{repo}/issues/{issue_number}/comments"]);
  });

  it.each(["write", "admin"])("permits current base permission %s regardless of contributor association", async (permission) => {
    const client = fakeApi({ issues: [managedPull()], collaboratorPermission: permission });
    expect((await handleIssueComment(client, repo, payload("@cicd-optimizer close", { author_association: "CONTRIBUTOR" }))).status).toBe("handled");
    expect(callsTo(client, "PATCH /repos/{owner}/{repo}/pulls/{pull_number}")[0]?.parameters.state).toBe("closed");
  });

  it.each(["none", "triage", "unknown", ""])("rejects insufficient or unknown permission %j", async (permission) => {
    const client = fakeApi({ issues: [managedPull()], collaboratorPermission: permission });
    expect((await handleIssueComment(client, repo, payload("@cicd-optimizer close"))).status).toBe("unauthorized");
    expect(callsTo(client, "DELETE /repos/{owner}/{repo}/git/refs/{ref}")).toHaveLength(0);
  });

  it.each([403, 404, 429, 500])("does not mutate a PR when the permission lookup returns %s", async (status) => {
    const client = fakeApi({ issues: [managedPull()] });
    const original = client.request.bind(client);
    vi.spyOn(client, "request").mockImplementation((route, parameters) => {
      if (route.endsWith("/permission")) return Promise.reject(httpError(status));
      return original(route, parameters);
    });
    const result = handleIssueComment(client, repo, payload("@cicd-optimizer close"));
    if (status === 404) {
      expect((await result).status).toBe("unauthorized");
    } else {
      await expect(result).rejects.toThrow(`HTTP ${status}`);
      expect(writes(client)).toHaveLength(0);
    }
    expect(callsTo(client, "PATCH /repos/{owner}/{repo}/pulls/{pull_number}")).toHaveLength(0);
    expect(callsTo(client, "DELETE /repos/{owner}/{repo}/git/refs/{ref}")).toHaveLength(0);
  });

  it("rejects a comment with no user login without making a permission lookup", async () => {
    const client = fakeApi({ issues: [managedPull()] });
    expect((await handleIssueComment(client, repo, payload("@cicd-optimizer close", { user: null }))).status).toBe("unauthorized");
    expect(callsTo(client, "GET /repos/{owner}/{repo}/collaborators/{username}/permission")).toHaveLength(0);
  });

  it("closes the pull request and deletes its branch", async () => {
    const client = fakeApi({ issues: [managedPull()] });
    const result = await handleIssueComment(client, repo, payload("@cicd-optimizer close"));
    expect(result.status).toBe("handled");
    expect(result.scan).toBeUndefined();
    expect(callsTo(client, "PATCH /repos/{owner}/{repo}/pulls/{pull_number}")[0]?.parameters).toMatchObject({ pull_number: 12, state: "closed" });
    expect(callsTo(client, "POST /graphql")[0]?.parameters.variables).toMatchObject({
      input: { refUpdates: [{ name: "refs/heads/cicd-optimizer/workflow", beforeOid: "pr-head", afterOid: "0".repeat(40) }] },
    });
  });

  it("rebuilds via a fixes-only scan on rebase", async () => {
    const client = fakeApi({ issues: [managedPull()], config: `${TIMEOUT_ONLY}issues:\n  enabled: true\nfixes:\n  enabled: true\n`, refs: { main: { [WORKFLOW]: CLEAN } } });
    const result = await handleIssueComment(client, repo, payload("@cicd-optimizer rebase"));
    expect(result.outcome?.rebase).toEqual(new Set(["workflow"]));
    expect(result.scan).toMatchObject({ status: "scanned" });
    expect(result.scan?.issues).toBeUndefined();
    expect(result.scan?.fixes).toBeDefined();
    expect(comments(client)[0]).toContain("Rebuilding this pull request");
  });

  it("leaves recipe rebuilds to the rollout but still applies other commands", async () => {
    const client = fakeApi({ issues: [managedPull("recipe-job-timeouts")], pullHeads: { 12: { sha: "h", ref: "cicd-optimizer/recipe-job-timeouts" } } });
    const result = await handleIssueComment(client, repo, payload("@cicd-optimizer recreate\n@cicd-optimizer ignore this rule"));
    expect(result.status).toBe("handled");
    expect(result.scan).toBeUndefined();
    expect(result.outcome?.recreate.size).toBe(0);
    const replies = comments(client);
    expect(replies[0]).toContain("`workflow/job-timeout` will no longer be fixed automatically");
    expect(replies[1]).toContain("rebuilt by the recipe's next rollout run");
  });

  it("reports what it would do in dry-run mode without writing", async () => {
    const client = fakeApi({ issues: [managedPull()] });
    const result = await handleIssueComment(client, repo, payload("@cicd-optimizer close"), { dryRun: true });
    expect(result).toEqual({ status: "handled", reason: "Would run: close" });
    expect(writes(client)).toHaveLength(0);
  });
});
