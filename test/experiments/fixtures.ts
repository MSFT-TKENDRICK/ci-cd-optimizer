import { createHash } from "node:crypto";
import type { GitHubClient } from "../../src/github/client.js";
import { CI_EVIDENCE_SCHEMA } from "../../src/experiments/ci-evidence.js";
import { armBranch, trunkBranch, type ExperimentManifest } from "../../src/experiments/manifest.js";
import type { BranchMeasurement } from "../../src/experiments/score.js";

export const sampleManifest = (overrides: Partial<ExperimentManifest> = {}): ExperimentManifest => ({
  name: "setup-cache-yarn",
  title: "Detect missing Yarn Berry caches",
  hypothesis: "Flagging Yarn Berry projects without a cache raises recall without hurting precision.",
  kind: "rules",
  rubric: { scores: { impact: 4, evidence: 4, safety: 5, generality: 4, measurability: 4 }, rationale: "Yarn Berry is common in monorepos." },
  arms: [
    { name: "lockfile", title: "Lockfile detection", approach: "Detect yarn.lock with __metadata." },
    { name: "packagemanager", title: "packageManager field", approach: "Read package.json packageManager." },
  ],
  createdAt: "2026-11-01T00:00:00.000Z",
  expiresAt: "2026-11-15T00:00:00.000Z",
  status: "running",
  ...overrides,
});

export interface Call {
  route: string;
  parameters: Record<string, unknown>;
}

export function fakeClient(handler: (route: string, parameters: Record<string, unknown>) => unknown = () => ({})): GitHubClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async request(route, parameters = {}) {
      calls.push({ route, parameters });
      return { status: 200, data: await handler(route, parameters) };
    },
  };
}

export const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
export const repo = { owner: "acme", repo: "widgets" };

export const sampleSha = (arm: string): string => createHash("sha1").update(arm).digest("hex");

export function ciMeasurement(arm: string, values: number[], experiment = "setup-cache-yarn"): BranchMeasurement {
  const headSha = sampleSha(arm);
  return {
    arm, headSha, changedPaths: [], testsPassed: true, ci: { ci: values },
    ciEvidence: {
      ci: {
        schema: CI_EVIDENCE_SCHEMA, repository: "acme/widgets", workflow: "ci.yml",
        samples: values.map((seconds, index) => {
          const startedAt = new Date(Date.parse("2026-11-02T00:00:00Z") + index * 3_600_000).toISOString();
          return {
            runId: Number.parseInt(headSha.slice(0, 10), 16) + index, attempt: 1, workflowId: 99,
            workflowPath: ".github/workflows/ci.yml", event: "workflow_dispatch", status: "completed", conclusion: "success",
            headSha, branch: arm === "trunk" ? trunkBranch(experiment) : armBranch(experiment, arm),
            createdAt: startedAt, startedAt, updatedAt: new Date(Date.parse(startedAt) + seconds * 1000).toISOString(), seconds,
          };
        }),
      },
    },
  };
}
