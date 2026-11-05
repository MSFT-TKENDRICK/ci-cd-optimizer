import type { GitHubClient, RepoRef } from "../github/client.js";
import type { HillClimbConfig, MetricSpec } from "./config.js";
import { armBranch, trunkBranch, type ExperimentManifest } from "./manifest.js";
import { metricsFor, type BranchMeasurement, type ExperimentMeasurements } from "./score.js";
import type { ExperimentState } from "./github.js";

interface RawRun {
  id: number;
  head_sha: string;
  run_started_at?: string | null;
  created_at: string;
  updated_at: string;
  conclusion: string | null;
}

interface RawJob {
  name: string;
  started_at: string | null;
  completed_at: string | null;
  conclusion: string | null;
}

const seconds = (start: string | null | undefined, end: string | null | undefined) => {
  const value = (Date.parse(end ?? "") - Date.parse(start ?? "")) / 1000;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

/**
 * Successful-run durations (seconds) for `branch`. Only runs of `headSha` count, so samples always measure the exact
 * change under evaluation rather than earlier iterations of the arm.
 */
export async function ciSamples(
  client: GitHubClient,
  repo: RepoRef,
  spec: MetricSpec,
  options: { branch: string; headSha?: string; since: string; maxRuns?: number },
): Promise<number[]> {
  if (!spec.workflow) return [];
  const response = await client.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
    ...repo,
    workflow_id: spec.workflow,
    branch: options.branch,
    status: "success",
    created: `>=${options.since.slice(0, 10)}`,
    per_page: 100,
  });
  const runs = ((response.data as { workflow_runs?: RawRun[] }).workflow_runs ?? [])
    .filter((run) => !options.headSha || run.head_sha === options.headSha)
    .slice(0, options.maxRuns ?? 30);
  const samples: number[] = [];
  for (const run of runs) {
    if (!spec.job) {
      const value = seconds(run.run_started_at ?? run.created_at, run.updated_at);
      if (value !== undefined) samples.push(value);
      continue;
    }
    const response = await client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", { ...repo, run_id: run.id, per_page: 100 }).catch(() => undefined);
    const list = (response?.data as { jobs?: RawJob[] } | undefined)?.jobs ?? [];
    const job = list.find((candidate) => candidate.name === spec.job && candidate.conclusion === "success");
    const value = job ? seconds(job.started_at, job.completed_at) : undefined;
    if (value !== undefined) samples.push(value);
  }
  return samples;
}

const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);

/** true when every check on the commit succeeded, false when any failed, undefined while running or when there are none. */
export async function checksPassed(client: GitHubClient, repo: RepoRef, sha: string): Promise<boolean | undefined> {
  const response = await client.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { ...repo, ref: sha, per_page: 100 });
  const runs = (response.data as { check_runs?: Array<{ status: string; conclusion: string | null }> }).check_runs ?? [];
  if (runs.length === 0) return undefined;
  if (runs.some((run) => run.conclusion && FAILED.has(run.conclusion))) return false;
  if (runs.some((run) => run.status !== "completed")) return undefined;
  return true;
}

export async function changedPaths(client: GitHubClient, repo: RepoRef, base: string, head: string): Promise<string[]> {
  const response = await client.request("GET /repos/{owner}/{repo}/compare/{basehead}", { ...repo, basehead: `${base}...${head}`, per_page: 300 });
  return ((response.data as { files?: Array<{ filename: string; previous_filename?: string }> }).files ?? []).flatMap((file) =>
    file.previous_filename ? [file.filename, file.previous_filename] : [file.filename],
  );
}

/**
 * Collects GitHub-side evidence (CI duration samples, check status, changed paths) for the control and every arm.
 * Corpus metrics for `rules` experiments are merged in separately by the local evaluator.
 */
export async function collectMeasurements(
  client: GitHubClient,
  repo: RepoRef,
  options: { manifest: ExperimentManifest; state: ExperimentState; config: HillClimbConfig; now?: Date },
): Promise<ExperimentMeasurements> {
  const { manifest, state, config } = options;
  const ciSpecs = metricsFor(manifest, config).filter((spec) => spec.source === "ci");
  const trunk = trunkBranch(manifest.name);
  const measure = async (branch: string, arm: string, headSha: string | undefined, pullRequest?: number): Promise<BranchMeasurement> => {
    const measurement: BranchMeasurement = { arm, changedPaths: [], ...(headSha ? { headSha } : {}), ...(pullRequest ? { pullRequest } : {}) };
    try {
      if (ciSpecs.length > 0) {
        measurement.ci = {};
        for (const spec of ciSpecs) {
          measurement.ci[spec.id] = await ciSamples(client, repo, spec, { branch, since: manifest.createdAt, ...(headSha ? { headSha } : {}) });
        }
      }
      if (arm !== "trunk" && headSha) {
        measurement.changedPaths = await changedPaths(client, repo, state.trunk?.headSha ?? trunk, headSha);
        const passed = await checksPassed(client, repo, headSha);
        if (passed !== undefined) measurement.testsPassed = passed;
      } else {
        measurement.testsPassed = true;
      }
    } catch (error) {
      measurement.error = (error as Error).message;
    }
    return measurement;
  };
  const control = await measure(trunk, "trunk", state.trunk?.headSha, state.trunk?.number);
  const arms: BranchMeasurement[] = [];
  for (const spec of manifest.arms) {
    const pull = state.arms.find((candidate) => candidate.arm === spec.name && candidate.state === "open");
    if (pull) arms.push(await measure(armBranch(manifest.name, spec.name), spec.name, pull.headSha, pull.number));
  }
  return { experiment: manifest.name, collectedAt: (options.now ?? new Date()).toISOString(), control, arms };
}

/** Merges locally computed evidence (corpus metrics, local test results, judge scores) into collected measurements. */
export function mergeMeasurement(measurements: ExperimentMeasurements, update: Partial<BranchMeasurement> & { arm: string }): ExperimentMeasurements {
  const apply = (branch: BranchMeasurement): BranchMeasurement => {
    const merged = { ...branch, ...update, changedPaths: update.changedPaths ?? branch.changedPaths };
    // A failure from either source wins: CI checks passing cannot hide failing local tests, and vice versa.
    if (branch.testsPassed === false || update.testsPassed === false) merged.testsPassed = false;
    return merged;
  };
  if (update.arm === "trunk") return { ...measurements, control: apply(measurements.control) };
  const exists = measurements.arms.some((arm) => arm.arm === update.arm);
  return {
    ...measurements,
    arms: exists ? measurements.arms.map((arm) => (arm.arm === update.arm ? apply(arm) : arm)) : [...measurements.arms, { changedPaths: [], ...update }],
  };
}
