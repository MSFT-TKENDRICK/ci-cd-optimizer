import type { GitHubClient } from "../../src/github/client.js";
import type { ExperimentManifest } from "../../src/experiments/manifest.js";

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
