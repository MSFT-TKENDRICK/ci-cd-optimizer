import { describe, expect, it } from "vitest";
import { DEFAULT_HILL_CLIMB_CONFIG } from "../../src/experiments/config.js";
import { serializeManifest } from "../../src/experiments/manifest.js";
import { marker, parseMarker } from "../../src/issues/markers.js";
import { planRecipe } from "../../src/recipes/apply.js";
import { applyRecipe, publishRecipe, recipeStatus } from "../../src/recipes/github.js";
import { fakeClient, sampleManifest } from "../experiments/fixtures.js";
import { CLEAN, defaultConfig, EXCESSIVE_TIMEOUT, MISSING_TIMEOUT, sampleRecipe, workflowInput } from "./fixtures.js";
import { server } from "./server.js";

const target = { owner: "acme", repo: "web" };

const workflow = (content: string) => ({ ".github/workflows/ci.yml": content });
const routes = (client: ReturnType<typeof server>) => client.calls.map((call) => call.route);
const recipePull = (overrides: Record<string, unknown> = {}, attributes: Record<string, string> = {}, revision = "1") => ({
  number: 30,
  title: "ci: recipe",
  state: "open",
  body: `${marker("fix", "group:recipe-job-timeouts", { signature: "old", commit: "head-sha", ...attributes })}\n${marker("recipe", "job-timeouts", { revision })}`,
  labels: [{ name: "cicd-optimizer" }, { name: "recipe:job-timeouts" }],
  pull_request: { merged_at: null },
  ...overrides,
});
const recipeIssueRaw = (overrides: Record<string, unknown> = {}, revision = "1") => ({
  number: 31,
  title: "Adapt recipe",
  state: "open",
  body: marker("recipe", "job-timeouts", { revision, signature: "x" }),
  ...overrides,
});

describe("applyRecipe", () => {
  it("plans without writing in dry-run mode", async () => {
    const client = server({ files: workflow(MISSING_TIMEOUT) });
    const result = await applyRecipe(client, target, sampleRecipe(), { dryRun: true });
    expect(result).toMatchObject({ repo: "acme/web", attempted: false, plan: { status: "autofix" } });
    expect(routes(client).some((route) => !route.startsWith("GET"))).toBe(false);
  });

  it("opens a labeled pull request rebuilt from the target's own files", async () => {
    const client = server({ files: workflow(MISSING_TIMEOUT) });
    const result = await applyRecipe(client, target, sampleRecipe());
    expect(result).toMatchObject({ pullRequest: 42, attempted: true });
    expect(result.issue).toBeUndefined();
    const tree = client.calls.find((call) => call.route === "POST /repos/{owner}/{repo}/git/trees");
    expect(JSON.stringify(tree?.parameters)).toContain("timeout-minutes: 30");
    const pull = client.calls.find((call) => call.route === "POST /repos/{owner}/{repo}/pulls");
    expect(pull?.parameters).toMatchObject({ title: "ci: Bound every job with timeout-minutes (recipe job-timeouts)", head: "cicd-optimizer/recipe-job-timeouts", base: "main" });
    expect(parseMarker(pull?.parameters.body as string)).toMatchObject({ kind: "fix", fingerprint: "group:recipe-job-timeouts" });
    const labels = client.calls.find((call) => call.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels");
    expect(labels?.parameters.labels).toEqual(expect.arrayContaining(["cicd-optimizer", "recipe:job-timeouts"]));
    expect(routes(client)).not.toContain("POST /repos/{owner}/{repo}/issues");
  });

  it("is idempotent when the pull request is up to date", async () => {
    const plan = planRecipe({ recipe: sampleRecipe(), input: workflowInput(MISSING_TIMEOUT), config: defaultConfig() });
    const client = server({ files: workflow(MISSING_TIMEOUT), issues: [recipePull({}, { signature: plan.change?.signature as string })] });
    const result = await applyRecipe(client, target, sampleRecipe());
    expect(result).toMatchObject({ pullRequest: 30, attempted: true });
    expect(routes(client).some((route) => route.startsWith("POST") || route.startsWith("PATCH"))).toBe(false);
  });

  it.each([false, true])("recovers an unlabeled recipe PR without rewriting its branch (human edits: %s)", async (humanEdits) => {
    const plan = planRecipe({ recipe: sampleRecipe(), input: workflowInput(MISSING_TIMEOUT), config: defaultConfig() });
    const pull = recipePull({
      labels: [],
      head: { ref: "custom/recipe-job-timeouts", sha: humanEdits ? "maintainer-commit" : "head-sha", repo: { full_name: "acme/web" } },
      base: { ref: "main" },
    }, { signature: plan.change?.signature as string });
    const client = server({
      files: workflow(MISSING_TIMEOUT), config: "fixes:\n  branchPrefix: custom/\n", pulls: [pull],
    });
    const result = await applyRecipe(client, target, sampleRecipe());
    expect(result).toMatchObject({ pullRequest: 30, attempted: true });
    expect(routes(client)).not.toContain("POST /repos/{owner}/{repo}/pulls");
    expect(routes(client)).not.toContain("POST /repos/{owner}/{repo}/git/commits");
    expect(routes(client)).not.toContain("PATCH /repos/{owner}/{repo}/pulls/{pull_number}");
    expect(client.calls.find((call) => call.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels")?.parameters)
      .toMatchObject({ issue_number: 30, labels: ["cicd-optimizer", "recipe:job-timeouts"] });
  });

  it("opens an adaptation issue labeled for the coding agent when no autofix applies", async () => {
    const client = server({ files: workflow(EXCESSIVE_TIMEOUT) });
    const result = await applyRecipe(client, target, sampleRecipe());
    expect(result).toMatchObject({ issue: 43, copilot: "labeled", attempted: true, plan: { status: "adapt" } });
    expect(result.pullRequest).toBeUndefined();
    const issue = client.calls.find((call) => call.route === "POST /repos/{owner}/{repo}/issues");
    expect(parseMarker(issue?.parameters.body as string)).toMatchObject({ kind: "recipe", fingerprint: "job-timeouts" });
    expect(client.calls.find((call) => call.route.endsWith("/labels") && call.parameters.issue_number === 43)?.parameters.labels).toEqual(["copilot:ready"]);
  });

  it("assigns Copilot with a user client", async () => {
    const copilotClient = fakeClient();
    const result = await applyRecipe(server({ files: workflow(EXCESSIVE_TIMEOUT) }), target, sampleRecipe(), { copilotClient });
    expect(result.copilot).toBe("assigned");
    expect(copilotClient.calls[0]?.parameters).toMatchObject({ issue_number: 43, assignees: ["copilot-swe-agent[bot]"] });
  });

  it("closes adaptation issues once the recipe no longer applies", async () => {
    const client = server({ files: workflow(CLEAN), issues: [recipeIssueRaw()] });
    const result = await applyRecipe(client, target, sampleRecipe());
    expect(result).toMatchObject({ attempted: false, plan: { status: "not-applicable" } });
    expect(client.calls.find((call) => call.route === "PATCH /repos/{owner}/{repo}/issues/{issue_number}")?.parameters).toMatchObject({ issue_number: 31, state: "closed" });
  });

  it("does not touch repositories with invalid configuration", async () => {
    const client = server({ files: workflow(MISSING_TIMEOUT), config: "rules:\n  nope/rule: error\n" });
    const result = await applyRecipe(client, target, sampleRecipe());
    expect(result).toMatchObject({ attempted: false, plan: { status: "ignored" } });
    expect(result.configProblems?.[0]).toContain("nope/rule");
    expect(routes(client)).not.toContain("GET /repos/{owner}/{repo}/commits/{ref}");
  });

  it("respects a target that opted out of recipes", async () => {
    const client = server({ files: workflow(MISSING_TIMEOUT), config: "recipes:\n  ignore: [job-timeouts]\n" });
    const result = await applyRecipe(client, target, sampleRecipe());
    expect(result).toMatchObject({ attempted: false, plan: { status: "ignored" } });
    expect(routes(client)).not.toContain("POST /repos/{owner}/{repo}/pulls");
  });
});

describe("recipeStatus", () => {
  it("is untouched without a pull request or issue", async () => {
    expect(await recipeStatus(server(), target, sampleRecipe())).toEqual({ repo: "acme/web", state: "untouched" });
  });

  it("counts merged pull requests as passed", async () => {
    const client = server({ issues: [recipePull({ state: "closed", pull_request: { merged_at: "2026-11-03T00:00:00Z" } })] });
    expect(await recipeStatus(client, target, sampleRecipe())).toEqual({ repo: "acme/web", state: "passed", number: 30, url: "https://github.com/acme/web/pull/30" });
  });

  it("judges open pull requests by the target's CI, ignoring the optimizer's own check", async () => {
    const failing = server({
      issues: [recipePull()],
      checkRuns: [
        { name: "build", status: "completed", conclusion: "failure" },
        { name: "CI/CD Optimizer", status: "completed", conclusion: "success" },
      ],
    });
    expect((await recipeStatus(failing, target, sampleRecipe())).state).toBe("failed");
    expect(failing.calls.find((call) => call.route.endsWith("/check-runs"))?.parameters.ref).toBe("head-sha");
    const ownCheck = server({
      issues: [recipePull()],
      checkRuns: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: "CI/CD Optimizer", status: "completed", conclusion: "failure" },
      ],
    });
    expect((await recipeStatus(ownCheck, target, sampleRecipe())).state).toBe("passed");
    expect((await recipeStatus(server({ issues: [recipePull()], checkRuns: [{ status: "in_progress", conclusion: null }] }), target, sampleRecipe())).state).toBe("pending");
  });

  it("treats declined pull requests as failed and ignores older revisions", async () => {
    const declined = server({ issues: [recipePull({ state: "closed" })] });
    expect((await recipeStatus(declined, target, sampleRecipe())).state).toBe("failed");
    expect((await recipeStatus(declined, target, sampleRecipe({ revision: 2 }))).state).toBe("untouched");
  });

  it("falls back to adaptation issues", async () => {
    expect(await recipeStatus(server({ issues: [recipeIssueRaw()] }), target, sampleRecipe())).toMatchObject({ state: "pending", number: 31, url: "https://github.com/acme/web/issues/31" });
    const notPlanned = server({ issues: [recipeIssueRaw({ state: "closed", state_reason: "not_planned" })] });
    expect((await recipeStatus(notPlanned, target, sampleRecipe())).state).toBe("failed");
    const completed = server({ issues: [recipeIssueRaw({ state: "closed", state_reason: "completed" })] });
    expect((await recipeStatus(completed, target, sampleRecipe())).state).toBe("passed");
    expect((await recipeStatus(completed, target, sampleRecipe({ revision: 2 }))).state).toBe("untouched");
  });
});

describe("publishRecipe", () => {
  const manifest = sampleManifest({
    name: "job-timeouts",
    kind: "pipeline",
    status: "promoted",
    winner: "packagemanager",
    applicability: { rules: ["workflow/job-timeout"] },
  });
  const rawPull = (number: number, arm: string, mergedAt: string | null) => ({
    number,
    node_id: `PR_${number}`,
    state: "closed",
    merged_at: mergedAt,
    closed_at: "2026-11-03T00:00:00Z",
    title: arm,
    body: null,
    labels: [],
    head: { ref: `experiments/job-timeouts/${arm}`, sha: `sha-${number}` },
    base: { ref: "experiments/job-timeouts/trunk" },
  });
  const pulls = [rawPull(11, "lockfile", null), rawPull(12, "packagemanager", "2026-11-03T00:00:00Z")];
  const pullFiles = [{ filename: ".github/workflows/ci.yml", status: "modified", patch: "+  timeout-minutes: 30" }];

  it("builds the recipe from the merged winning arm", async () => {
    const client = server({ manifest: serializeManifest(manifest), pulls, pullFiles });
    const result = await publishRecipe(client, { owner: "acme", repo: "platform" }, { experiment: "job-timeouts", config: DEFAULT_HILL_CLIMB_CONFIG });
    if (!("recipe" in result)) throw new Error(result.error);
    expect(result.recipe.source).toEqual({ repository: "acme/platform", experiment: "job-timeouts", arm: "packagemanager", pullRequest: 12, promotedAt: "2026-11-03T00:00:00Z" });
    expect(result.recipe.patch).toContain("timeout-minutes: 30");
    expect(client.calls.find((call) => call.route.endsWith("/files"))?.parameters.pull_number).toBe(12);
    expect(client.calls.find((call) => call.route.endsWith("/contents/{path}"))?.parameters).toMatchObject({ path: "experiments/job-timeouts/experiment.yml", ref: "main" });
  });

  it("uses a provided manifest and reports missing ones", async () => {
    const client = server({ pulls, pullFiles });
    const result = await publishRecipe(client, { owner: "acme", repo: "platform" }, { experiment: "job-timeouts", config: DEFAULT_HILL_CLIMB_CONFIG, manifest });
    expect("recipe" in result).toBe(true);
    expect(routes(client)).not.toContain("GET /repos/{owner}/{repo}/contents/{path}");
    const missing = await publishRecipe(server(), { owner: "acme", repo: "platform" }, { experiment: "job-timeouts", config: DEFAULT_HILL_CLIMB_CONFIG });
    expect(missing).toEqual({ error: "experiments/job-timeouts/experiment.yml was not found on main." });
  });

  it("skips experiments that were not promoted", async () => {
    const result = await publishRecipe(server({ pulls }), { owner: "acme", repo: "platform" }, {
      experiment: "job-timeouts",
      config: DEFAULT_HILL_CLIMB_CONFIG,
      manifest: { ...manifest, status: "running" },
    });
    expect(result).toMatchObject({ skipped: true });
  });
});
