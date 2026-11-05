import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/index.js";
import { serializeManifest } from "../../src/experiments/manifest.js";
import type { ExperimentMeasurements } from "../../src/experiments/score.js";
import { fakeClient, sampleManifest } from "../experiments/fixtures.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cicd-experiment-cli-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

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
