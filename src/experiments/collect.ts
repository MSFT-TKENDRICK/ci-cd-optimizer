import { isDeepStrictEqual } from "node:util";
import type { GitHubClient, RepoRef } from "../github/client.js";
import { CI_EVIDENCE_SCHEMA, durationSeconds, fullGitHubSha, supportedCiSample, validatedCiSeries, type CiEvidence, type CiJobSample, type CiSample } from "./ci-evidence.js";
import type { HillClimbConfig, MetricSpec } from "./config.js";
import { armBranch, trunkBranch, type ExperimentManifest } from "./manifest.js";
import { metricsFor, type BranchMeasurement, type ExperimentMeasurements } from "./score.js";
import type { ExperimentState } from "./github.js";

interface RawRun {
  id: number;
  run_attempt: number;
  workflow_id: number;
  path: string;
  event: string;
  status: string;
  head_branch: string;
  head_sha: string;
  run_started_at?: string | null;
  created_at: string;
  updated_at: string;
  conclusion: string | null;
  repository?: { full_name: string };
  head_repository?: { full_name: string };
}

interface RawJob {
  id: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  status: string;
  name: string;
  started_at: string | null;
  completed_at: string | null;
  conclusion: string | null;
}

const repositoryName = (repo: RepoRef) => `${repo.owner}/${repo.repo}`;

async function selectedJob(client: GitHubClient, repo: RepoRef, run: RawRun, name: string): Promise<CiJobSample | undefined> {
  const jobs: RawJob[] = [];
  let total: number | undefined;
  for (let page = 1; ; page += 1) {
    const response = await client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs", {
      ...repo, run_id: run.id, attempt_number: 1, per_page: 100, page,
    });
    const data = response.data as { jobs?: RawJob[]; total_count?: number };
    if (!Array.isArray(data.jobs) || !Number.isSafeInteger(data.total_count) || (data.total_count ?? -1) < 0 ||
      (total !== undefined && total !== data.total_count)) throw new Error("Incomplete or changing CI job inventory; recollect.");
    total = data.total_count;
    jobs.push(...data.jobs);
    if (jobs.length > 10_000 || new Set(jobs.map((job) => job.id)).size !== jobs.length) throw new Error("Oversized or repeated CI job inventory.");
    if (data.jobs.length < 100) break;
  }
  if (jobs.length !== total) throw new Error("Incomplete CI job inventory; recollect.");
  const matching = jobs.filter((job) => job.name === name);
  const job = matching.length === 1 ? matching[0] : undefined;
  if (!job || job.run_id !== run.id || job.run_attempt !== 1 || job.head_sha !== run.head_sha ||
    job.status !== "completed" || job.conclusion !== "success" || !job.started_at || !job.completed_at) return undefined;
  return { id: job.id, name: job.name, startedAt: job.started_at, completedAt: job.completed_at, conclusion: job.conclusion };
}

async function observation(client: GitHubClient, repo: RepoRef, run: RawRun, spec: MetricSpec, context: { branch: string; headSha?: string; since: string }): Promise<CiSample | undefined> {
  if (run.repository?.full_name.toLowerCase() !== repositoryName(repo).toLowerCase() ||
    run.head_repository?.full_name.toLowerCase() !== repositoryName(repo).toLowerCase()) return undefined;
  const sample: CiSample = {
    runId: run.id, attempt: run.run_attempt, workflowId: run.workflow_id, workflowPath: run.path,
    event: run.event, status: run.status, conclusion: run.conclusion ?? "", headSha: run.head_sha, branch: run.head_branch,
    createdAt: run.created_at, startedAt: run.run_started_at ?? "", updatedAt: run.updated_at,
    seconds: durationSeconds(run.run_started_at ?? "", run.updated_at) ?? -1,
  };
  // Validate the run context before spending API reads on jobs from an ineligible PR/retry/old-head run.
  const runSpec = { ...spec };
  delete runSpec.job;
  if (!supportedCiSample(sample, runSpec, context)) return undefined;
  if (spec.job) {
    const job = await selectedJob(client, repo, run, spec.job);
    if (!job) return undefined;
    sample.job = job;
    sample.seconds = durationSeconds(job.startedAt, job.completedAt) ?? -1;
  }
  return supportedCiSample(sample, spec, context) ? sample : undefined;
}

/** GitHub-reported, first-attempt dispatch observations; never claim that head_sha attests the checkout/workload. */
export async function ciSamples(
  client: GitHubClient,
  repo: RepoRef,
  spec: MetricSpec,
  options: { branch: string; headSha?: string; since: string; maxRuns?: number },
): Promise<CiEvidence> {
  const evidence: CiEvidence = { schema: CI_EVIDENCE_SCHEMA, repository: repositoryName(repo), workflow: spec.workflow ?? "", samples: [] };
  if (!spec.workflow || !fullGitHubSha(options.headSha) || !Number.isFinite(Date.parse(options.since))) return evidence;
  const maxRuns = options.maxRuns ?? 30;
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 10_000) throw new Error("CI sample limit must be an integer in [1, 10000].");
  const seen = new Set<number>();
  for (let page = 1; ; page += 1) {
    const response = await client.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
      ...repo, workflow_id: spec.workflow, branch: options.branch, head_sha: options.headSha, event: "workflow_dispatch",
      status: "success", created: `>=${options.since.slice(0, 10)}`, per_page: 100, page,
    });
    const runs = (response.data as { workflow_runs?: RawRun[] }).workflow_runs;
    if (!Array.isArray(runs)) throw new Error("Missing CI workflow run inventory.");
    const previous = seen.size;
    for (const run of runs) {
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      const sample = await observation(client, repo, run, spec, options);
      if (sample) evidence.samples.push(sample);
      if (evidence.samples.length === maxRuns) return evidence;
    }
    if (runs.length < 100) return evidence;
    if (seen.size === previous) throw new Error("Repeated CI workflow run page; refusing an incomplete collection.");
  }
}

const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);

/** All reported checks are complete/nonfailing, with at least one success; not proof of required/equivalent work. */
export async function checksPassed(client: GitHubClient, repo: RepoRef, sha: string): Promise<boolean | undefined> {
  const runs: Array<{ status: string; conclusion: string | null }> = [];
  for (let page = 1; ; page += 1) {
    const response = await client.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { ...repo, ref: sha, per_page: 100, page });
    const items = (response.data as { check_runs?: Array<{ status: string; conclusion: string | null }> }).check_runs;
    if (!Array.isArray(items)) throw new Error("Missing check-run inventory.");
    runs.push(...items);
    if (runs.length > 10_000) throw new Error("Oversized check-run inventory; refusing an incomplete check gate.");
    if (items.length < 100) break;
  }
  if (runs.some((run) => run.conclusion && FAILED.has(run.conclusion))) return false;
  if (runs.some((run) => run.status !== "completed" || !["success", "skipped", "neutral"].includes(run.conclusion ?? ""))) return undefined;
  return runs.some((run) => run.conclusion === "success") ? true : undefined;
}

export async function changedPaths(client: GitHubClient, repo: RepoRef, base: string, head: string): Promise<string[]> {
  const response = await client.request("GET /repos/{owner}/{repo}/compare/{basehead}", { ...repo, basehead: `${base}...${head}`, per_page: 300 });
  const files = (response.data as { files?: Array<{ filename: string; previous_filename?: string }> }).files;
  if (!Array.isArray(files) || files.length >= 300) throw new Error("Missing or potentially truncated comparison paths; refusing incomplete protected-path evidence.");
  return files.flatMap((file) =>
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
        const values: Record<string, number[]> = Object.create(null);
        const series: Record<string, CiEvidence> = Object.create(null);
        measurement.ci = values;
        measurement.ciEvidence = series;
        for (const spec of ciSpecs) {
          const evidence = await ciSamples(client, repo, spec, { branch, since: manifest.createdAt, maxRuns: Math.max(30, config.selection.minSamples), ...(headSha ? { headSha } : {}) });
          series[spec.id] = evidence;
          values[spec.id] = evidence.samples.map((sample) => sample.seconds);
        }
      }
      if (arm !== "trunk" && headSha) {
        measurement.changedPaths = await changedPaths(client, repo, state.trunk?.headSha ?? trunk, headSha);
      }
      if (headSha) {
        const passed = await checksPassed(client, repo, headSha);
        if (passed !== undefined) measurement.testsPassed = passed;
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

/** Re-read GitHub provenance before the CLI publishes a performance promotion; offline certificates do not do this. */
export async function verifyCiMeasurements(
  client: GitHubClient, repo: RepoRef,
  options: { manifest: ExperimentManifest; measurements: ExperimentMeasurements; config: HillClimbConfig },
): Promise<void> {
  const { manifest, measurements, config } = options;
  const specs = metricsFor(manifest, config).filter((spec) => spec.source === "ci");
  const runCache = new Map<number, RawRun>();
  const branches = [measurements.control, ...measurements.arms.filter((arm) => manifest.arms.some((spec) => spec.name === arm.arm))];
  for (const measured of branches) {
    const branch = measured === measurements.control ? trunkBranch(manifest.name) : armBranch(manifest.name, measured.arm);
    const context = { branch, since: manifest.createdAt, ...(measured.headSha ? { headSha: measured.headSha } : {}) };
    for (const spec of specs) {
      const series = validatedCiSeries(spec, measured, context);
      // Unsupported/missing observations were excluded by the selector, not used as empirical input.
      if (series.issue || series.values.length === 0) continue;
      const evidence = measured.ciEvidence?.[spec.id];
      if (!evidence || evidence.repository.toLowerCase() !== repositoryName(repo).toLowerCase()) throw new Error("CI evidence belongs to a different repository; recollect before promotion.");
      for (const recorded of evidence.samples) {
        let run = runCache.get(recorded.runId);
        if (!run) {
          const response = await client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", { ...repo, run_id: recorded.runId });
          run = response.data as RawRun;
          runCache.set(recorded.runId, run);
        }
        const current = await observation(client, repo, run, spec, context);
        if (!current || !isDeepStrictEqual(current, recorded)) throw new Error(`CI run ${recorded.runId} no longer matches its recorded dispatch/head/attempt/timing context; recollect before promotion.`);
      }
    }
  }
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
