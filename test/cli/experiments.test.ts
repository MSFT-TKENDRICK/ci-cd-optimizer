import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/index.js";
import { serializeManifest } from "../../src/experiments/manifest.js";
import type { ExperimentMeasurements } from "../../src/experiments/score.js";
import { fakeClient, sampleManifest } from "../experiments/fixtures.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cicd-experiment-cli-")); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

describe("experiment creation credentials", () => {
  it("publishes with the App credential but dispatches arms with the Actions credential", async () => {
    await writeFile(join(root, "manifest.yml"), serializeManifest(sampleManifest()));
    const dispatched: string[] = [];
    vi.stubGlobal("fetch", async (input: URL, init: RequestInit) => {
      const path = input.pathname;
      const dispatch = path.endsWith("/dispatches");
      expect(init.headers).toHaveProperty("authorization", `Bearer ${dispatch ? "dispatch-test-token" : "publisher-test-token"}`);
      if (dispatch) {
        dispatched.push(JSON.parse(String(init.body)).inputs.arm);
        return new Response(null, { status: 204 });
      }
      let data: unknown;
      if (path.endsWith("/pulls")) data = init.method === "GET" ? [] : { number: 42 };
      else if (path.includes("/git/ref/")) data = { object: { sha: "a".repeat(40) } };
      else if (path.includes("/git/commits/")) data = { tree: { sha: "tree" } };
      else if (path.endsWith("/labels")) data = [{ name: "experiment" }];
      else if (path.includes("/git/")) data = { sha: "b".repeat(40) };
      else throw new Error(`Unexpected request: ${path}`);
      return Response.json(data);
    });
    const stderr: string[] = [];
    const exit = await run(["experiments", "create", "--repo", "acme/widgets", "--manifest", "manifest.yml", "--arm-workflow", "experiment-arm.lock.yml"], {
      cwd: root,
      env: { GITHUB_TOKEN: "publisher-test-token", CICD_OPTIMIZER_DISPATCH_TOKEN: "dispatch-test-token", GITHUB_API_URL: "https://github.test" },
      now: () => new Date("2026-11-05T00:00:00Z"), stdout: () => undefined, stderr: (line) => stderr.push(line),
    });
    expect(stderr).toEqual([]);
    expect(exit).toBe(0);
    expect(dispatched).toEqual(["lockfile", "packagemanager"]);
  });

  it("rejects a multi-proposal agent batch before it can bypass the concurrency gate", async () => {
    await writeFile(join(root, "agent.json"), JSON.stringify({ items: [
      { type: "create_experiment", manifest: serializeManifest(sampleManifest()) },
      { type: "create_experiment", manifest: serializeManifest(sampleManifest({ name: "another-proposal" })) },
    ] }));
    const client = fakeClient();
    const stderr: string[] = [];
    const exit = await run(["experiments", "create", "--repo", "acme/widgets", "--agent-output", "agent.json"], {
      cwd: root, env: {}, github: () => client, stdout: () => undefined, stderr: (line) => stderr.push(line),
    });
    expect(exit).toBe(2);
    expect(stderr.join("\n")).toContain("only one proposal");
    expect(client.calls).toEqual([]);
  });
});

describe("experiment capacity CLI", () => {
  it("uses configured capacity and paginates past unrelated pull requests", async () => {
    await writeFile(join(root, "budget.yml"), "selection:\n  maxConcurrent: 1\n");
    const raw = (ref: string) => ({
      number: 10, state: "open", merged_at: null, head: { ref, sha: "a".repeat(40), repo: { full_name: "acme/widgets" } },
      base: { ref: "main" }, body: "", title: ref, labels: [],
    });
    const client = fakeClient((_route, parameters) =>
      parameters.page === 1 ? Array.from({ length: 100 }, () => raw("unrelated")) : [raw("experiments/demo/trunk")]);
    const stdout: string[] = [];
    const exit = await run(["experiments", "capacity", "--repo", "acme/widgets", "--config", "budget.yml"], {
      cwd: root, env: {}, github: () => client, stdout: (line) => stdout.push(line), stderr: () => undefined,
    });
    expect(exit).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toEqual({ running: 1, limit: 1, available: 0 });
    expect(client.calls).toHaveLength(2);
  });

  it("does not turn a failed API read into an empty or full budget", async () => {
    const client = fakeClient(() => { throw new Error("API unavailable"); });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await run(["experiments", "capacity", "--repo", "acme/widgets"], {
      cwd: root, env: {}, github: () => client, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
    });
    expect(exit).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("API unavailable");
  });
});

describe("experiment recovery CLI", () => {
  it.each([{ args: [] }, { args: ["--experiment", "demo"] }, { args: ["--experiment", "../main", "--expected-head", "a".repeat(40)] }])(
    "refuses ambiguous recovery input ($args)", async ({ args }) => {
      const client = fakeClient();
      const stderr: string[] = [];
      const exit = await run(["experiments", "resume", ...args], {
        cwd: root, env: {}, github: () => client,
        stdout: () => undefined, stderr: (line) => stderr.push(line),
      });
      expect(exit).toBe(2);
      expect(stderr.join("\n")).toContain("--expected-head");
      expect(client.calls).toEqual([]);
    },
  );

  it("previews a source-bound recovery without dispatching or writing", async () => {
    const manifest = sampleManifest();
    const sha = "a".repeat(40);
    const client = fakeClient((route) => {
      if (route === "GET /repos/{owner}/{repo}") return { default_branch: "main" };
      if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return { object: { sha } };
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") return { content: serializeManifest(manifest) };
      if (route === "GET /repos/{owner}/{repo}/pulls") return [];
      throw new Error(`Unexpected request: ${route}`);
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await run(["experiments", "resume", "--repo", "acme/widgets", "--experiment", manifest.name, "--expected-head", sha, "--dry-run"], {
      cwd: root, env: {}, github: () => client, now: () => new Date("2026-11-05T00:00:00Z"),
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
    });
    expect(exit).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ sha, baseBranch: "main", created: false });
    expect(stderr.join("\n")).toContain("no changes made");
    expect(client.calls.every((call) => call.route.startsWith("GET"))).toBe(true);
  });
});

describe("experiment decision CLI", () => {
  it.each(["stale", "unconfirmed", "dry run", "stale rejection", "unconfirmed rejection", "stale expiry", "unconfirmed expiry"])("preserves evidence and failure semantics (%s)", async (scenario) => {
    const manifest = sampleManifest();
    const negative = scenario.includes("rejection") || scenario.includes("expiry");
    const corpus = (recall: number) => ({ precision: 0.9, recall, f1: 0, fixRate: 1, durationMs: 100 });
    const measurements: ExperimentMeasurements = {
      experiment: manifest.name, collectedAt: "2026-11-05T00:00:00Z",
      control: { arm: "trunk", headSha: "sha-trunk", pullRequest: 10, changedPaths: [], testsPassed: true, corpus: corpus(0.6) },
      arms: [
        { arm: "lockfile", headSha: scenario.startsWith("stale") ? "old-winner" : "sha-lockfile", pullRequest: 11, changedPaths: [], testsPassed: true, corpus: corpus(negative ? 0.5 : 0.8) },
        { arm: "packagemanager", headSha: "sha-packagemanager", pullRequest: 12, changedPaths: [], testsPassed: true, corpus: corpus(negative ? 0.55 : 0.65) },
      ],
    };
    await writeFile(join(root, "measurements.json"), JSON.stringify(measurements));
    const pulls = ["trunk", "lockfile", "packagemanager"].map((arm, index) => ({
      number: 10 + index, node_id: `PR_${10 + index}`, state: "open", merged_at: null, closed_at: null,
      title: arm, body: "", labels: [], draft: arm === "trunk",
      head: { ref: `experiments/${manifest.name}/${arm}`, sha: `sha-${arm}`, repo: { full_name: "acme/widgets" } },
      base: { ref: arm === "trunk" ? "main" : `experiments/${manifest.name}/trunk` },
    }));
    const client = fakeClient((route, parameters) => {
      if (route === "GET /repos/{owner}/{repo}/pulls") return pulls;
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") return pulls.find((pull) => pull.number === parameters.pull_number);
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        expect(parameters.ref).toBe("sha-trunk");
        return { encoding: "base64", content: Buffer.from(serializeManifest(manifest)).toString("base64") };
      }
      if (route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge") return { merged: false, sha: "unconfirmed" };
      if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments" ||
        route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") return {};
      throw new Error(`Unexpected request: ${route}`);
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await run(["experiments", "decide", "--repo", "acme/widgets", "--measurements", "measurements.json", ...(scenario === "dry run" ? [] : ["--apply"])], {
      cwd: root, env: {}, github: () => client, now: () => new Date(scenario.includes("expiry") ? "2026-11-16T00:00:00Z" : "2026-11-05T00:00:00Z"),
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
    });
    expect(exit).toBe(scenario === "dry run" ? 0 : 1);
    if (scenario === "dry run") expect(stderr.join("\n")).toContain("dry run");
    else {
      expect(stderr.join("\n")).toMatch(scenario.startsWith("stale") ? /[Rr]ecollect/ : negative ? /closure was not confirmed/ : /did not confirm/);
      expect(stderr.join("\n")).not.toContain("(merged #");
      expect(stderr.join("\n")).not.toContain(", closed #");
      expect(stdout).toEqual([]);
    }
    expect(client.calls.filter((call) => !call.route.startsWith("GET")).map((call) => call.route))
      .toEqual(scenario.startsWith("unconfirmed") ? negative
        ? ["POST /repos/{owner}/{repo}/issues/{issue_number}/comments", "PATCH /repos/{owner}/{repo}/pulls/{pull_number}"]
        : ["PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"] : []);
  });
});
