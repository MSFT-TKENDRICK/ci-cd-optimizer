import { describe, expect, it } from "vitest";
import { annotationsFor, completeCheck, publishCheck, truncate } from "../../src/service/checks.js";
import { runPullRequestCheck } from "../../src/service/pull-request.js";
import type { Diagnostic } from "../../src/lint/types.js";
import { fakeClient, repo } from "../experiments/fixtures.js";
import { callsTo, CLEAN, fakeApi, MISSING_TIMEOUT, TIMEOUT_ONLY, WORKFLOW, writes } from "./api.js";

const pr = { number: 5, headSha: "head", baseRef: "main", baseSha: "base" };
const completed = (client: ReturnType<typeof fakeApi>) => callsTo(client, "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}")[0]?.parameters;

describe("runPullRequestCheck", () => {
  it("passes quickly when no CI/CD-relevant files changed", async () => {
    const client = fakeApi({ config: TIMEOUT_ONLY, pullFiles: [{ filename: "src/index.ts" }] });
    const result = await runPullRequestCheck(client, repo, pr);
    expect(result).toMatchObject({ conclusion: "success", checkRunId: 99, introduced: [] });
    expect(completed(client)).toMatchObject({ conclusion: "success", output: { title: "No CI/CD-relevant changes" } });
    expect(client.calls.some((call) => call.route.includes("/git/trees"))).toBe(false);
  });

  it("fails on findings the pull request introduces, with annotations", async () => {
    const client = fakeApi({ config: TIMEOUT_ONLY, refs: { base: { [WORKFLOW]: CLEAN }, head: { [WORKFLOW]: MISSING_TIMEOUT } }, pullFiles: [{ filename: WORKFLOW }] });
    const result = await runPullRequestCheck(client, repo, pr);
    expect(result.conclusion).toBe("failure");
    expect(result.introduced.map((diagnostic) => diagnostic.ruleId)).toEqual(["workflow/job-timeout"]);
    const output = completed(client)?.output as { title: string; summary: string; annotations: Array<Record<string, unknown>> };
    expect(output.title).toBe("1 new finding");
    expect(output.summary).toContain("**1** introduced by this pull request");
    expect(output.summary).toContain("### Introduced");
    expect(output.annotations[0]).toMatchObject({ path: WORKFLOW, annotation_level: "failure", title: "workflow/job-timeout" });
    expect(callsTo(client, "POST /repos/{owner}/{repo}/check-runs")[0]?.parameters).toMatchObject({ name: "CI/CD Optimizer", head_sha: "head", status: "in_progress" });
  });

  it("reads policy from the base so a pull request cannot relax its own check", async () => {
    const client = fakeApi({
      config: TIMEOUT_ONLY,
      refs: { base: { [WORKFLOW]: CLEAN }, head: { [WORKFLOW]: MISSING_TIMEOUT, ".github/ci-cd-optimizer.yml": "enabled: false\n" } },
      pullFiles: [{ filename: WORKFLOW }, { filename: ".github/ci-cd-optimizer.yml" }],
    });
    expect((await runPullRequestCheck(client, repo, pr)).conclusion).toBe("failure");
    expect(client.calls.find((call) => call.route.endsWith("/contents/{path}"))?.parameters.ref).toBe("base");
  });

  it("reports pre-existing findings in touched files without failing", async () => {
    const client = fakeApi({
      config: TIMEOUT_ONLY,
      refs: { base: { [WORKFLOW]: MISSING_TIMEOUT }, head: { [WORKFLOW]: `${MISSING_TIMEOUT}# touched\n` } },
      pullFiles: [{ filename: WORKFLOW }],
    });
    const result = await runPullRequestCheck(client, repo, pr);
    expect(result).toMatchObject({ conclusion: "success", introduced: [], existing: 0 });
    expect(result.touched).toHaveLength(1);
    expect((completed(client)?.output as { title: string }).title).toBe("1 existing finding in changed files");
  });

  it("is neutral for introduced findings below the failOn threshold", async () => {
    const client = fakeApi({
      config: "extends: []\nrules:\n  workflow/job-timeout: warn\n",
      refs: { base: { [WORKFLOW]: CLEAN }, head: { [WORKFLOW]: MISSING_TIMEOUT } },
      pullFiles: [{ filename: WORKFLOW }],
    });
    expect((await runPullRequestCheck(client, repo, pr)).conclusion).toBe("neutral");
  });

  it("fails with the problems when the base configuration is invalid", async () => {
    const client = fakeApi({ config: "failOn: sometimes\n", pullFiles: [{ filename: WORKFLOW }] });
    const result = await runPullRequestCheck(client, repo, pr);
    expect(result.conclusion).toBe("failure");
    expect((completed(client)?.output as { title: string }).title).toBe("Invalid .github/ci-cd-optimizer.yml");
  });

  it("is neutral when disabled", async () => {
    const client = fakeApi({ config: "enabled: false\n" });
    expect((await runPullRequestCheck(client, repo, pr)).conclusion).toBe("neutral");
  });

  it("completes the check as neutral and rethrows when analysis fails", async () => {
    const client = fakeApi({ config: TIMEOUT_ONLY, pullFiles: [{ filename: WORKFLOW }], failOn: (route) => route.includes("/git/trees") });
    await expect(runPullRequestCheck(client, repo, pr)).rejects.toThrow("HTTP 500");
    expect(completed(client)).toMatchObject({ conclusion: "neutral", output: { title: "Analysis could not complete" } });
  });

  it("writes nothing in dry-run mode", async () => {
    const client = fakeApi({ config: TIMEOUT_ONLY, refs: { base: { [WORKFLOW]: CLEAN }, head: { [WORKFLOW]: MISSING_TIMEOUT } }, pullFiles: [{ filename: WORKFLOW }] });
    const result = await runPullRequestCheck(client, repo, pr, { dryRun: true });
    expect(result.conclusion).toBe("failure");
    expect(result.checkRunId).toBeUndefined();
    expect(writes(client)).toHaveLength(0);
  });

  it("counts renamed files by their previous path too", async () => {
    const client = fakeApi({ config: TIMEOUT_ONLY, refs: { base: { [WORKFLOW]: CLEAN }, head: {} }, pullFiles: [{ filename: "old/ci.yml", previous_filename: WORKFLOW }] });
    const result = await runPullRequestCheck(client, repo, pr);
    expect(result.conclusion).toBe("success");
    expect((completed(client)?.output as { title: string }).title).toBe("No new CI/CD findings");
  });
});

const diagnostic = (overrides: Partial<Diagnostic> = {}): Diagnostic =>
  ({
    ruleId: "workflow/job-timeout",
    ruleset: "workflow",
    severity: "warn",
    message: "Job has no timeout",
    path: WORKFLOW,
    line: 3,
    column: 0,
    fingerprint: "f",
    impact: "medium",
    confidence: "high",
    docsUrl: "https://example.com",
    ...overrides,
  }) as Diagnostic;

describe("check run helpers", () => {
  it("maps severities to annotation levels and caps the count", () => {
    const annotations = annotationsFor([diagnostic({ severity: "error" }), diagnostic({ severity: "info", line: 0, column: 4, suggestion: "Add timeout-minutes" })]);
    expect(annotations[0]).toMatchObject({ annotation_level: "failure", start_line: 3, end_line: 3 });
    expect(annotations[0]).not.toHaveProperty("start_column");
    expect(annotations[1]).toMatchObject({ annotation_level: "notice", start_line: 1, start_column: 4, end_column: 4 });
    expect(annotations[1]?.message).toContain("Fix: Add timeout-minutes");
    expect(annotationsFor(Array.from({ length: 600 }, () => diagnostic()))).toHaveLength(500);
  });

  it("truncates long output fields", () => {
    expect(truncate("short")).toBe("short");
    const long = truncate("x".repeat(70_000));
    expect(long).toHaveLength(65_535);
    expect(long.endsWith("_…truncated._")).toBe(true);
  });

  it("sends annotations in batches of 50", async () => {
    const client = fakeClient(() => ({ id: 7 }));
    const annotations = annotationsFor(Array.from({ length: 120 }, () => diagnostic()));
    await completeCheck(client, repo, 7, "neutral", { title: "t", summary: "s", annotations });
    expect(client.calls.map((call) => (call.parameters.output as { annotations?: unknown[] }).annotations?.length)).toEqual([50, 50, 20]);
    expect(client.calls[0]?.parameters).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(client.calls[1]?.parameters).not.toHaveProperty("conclusion");

    const published = fakeClient(() => ({ id: 8 }));
    expect(await publishCheck(published, repo, { name: "n", headSha: "s", conclusion: "neutral", title: "t", summary: "s", annotations, detailsUrl: "https://x" })).toBe(8);
    expect(published.calls.map((call) => call.route)).toEqual([
      "POST /repos/{owner}/{repo}/check-runs",
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
      "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
    ]);
    expect(published.calls[0]?.parameters).toMatchObject({ details_url: "https://x", status: "completed" });
  });
});
