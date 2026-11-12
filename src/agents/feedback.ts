import { createHash } from "node:crypto";
import type { McpServer, RegisteredResource } from "@modelcontextprotocol/server";
import { z } from "zod";
import { decodeBenchmark, type RunBenchmark } from "../telemetry/benchmark.js";
import { operationAccess, repositoryReader, resolveRepository, type RemoteAccess, type RemoteOptions } from "./remote.js";
import { agentErrorMessage, LIMITS, operation } from "./safety.js";
import { AgentError } from "./workspace.js";

export const FEEDBACK_WORKFLOW = ".github/workflows/cicd-optimizer-telemetry.yml";
export const FEEDBACK_REPLAY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING = 50;
const MAX_INVENTORY = 1000;
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const producerSchema = z.object({
  id: positiveId, run_attempt: positiveId, workflow_id: positiveId,
  head_sha: z.string().regex(/^[a-f0-9]{40}$/), head_branch: z.string(), event: z.literal("workflow_run"),
  status: z.string(), conclusion: z.string().nullable(), created_at: z.iso.datetime(), path: z.string(),
});
export type FeedbackProducer = z.infer<typeof producerSchema>;
type BenchmarkFinding = RunBenchmark["findings"][number];
export interface FeedbackRollupRun {
  runId: number;
  runAttempt: number;
  conclusion: string | null;
  analysisStatus: RunBenchmark["analysisStatus"];
  elapsedMs: number | null;
  runnerMs: number | null;
}
/** Runs of the same workflow, branch and trigger held since the previous broadcast. */
export interface FeedbackRollup {
  /** Non-success runs and successes without analysis, newest collected summaries kept. */
  runs: FeedbackRollupRun[];
  omittedRuns: number;
  byConclusion: { conclusion: string; runs: number }[];
  /** Runner time of held non-success runs: rework exposure, not removable cost. */
  nonSuccessRunnerMs: number;
  nonSuccessRunsWithoutRunnerMs: number;
  /** Successes not broadcast because they were unchanged, older than a newer success, or not actionable. */
  quietSuccesses: number;
}
export interface FeedbackEvent {
  key: string;
  repository: string;
  repositoryId: number;
  producer: FeedbackProducer;
  benchmark: RunBenchmark;
  /** Head branch of the benchmarked source run, from GitHub's run record. */
  sourceBranch: string;
  sourceEvent: string;
  /** GitHub's exact-attempt updated_at; used as completion ordering, with run/attempt tie-breakers. */
  sourceUpdatedAt: string;
  /** Why this success was broadcast: first success, new finding or significant duration change. */
  trigger?: string[];
  rollup?: FeedbackRollup;
}
export interface FeedbackOptions {
  /** Explicit start of the replay scope; this is never an inferred authorization boundary. */
  since: string;
  pollMs?: number;
}

// Product noise-filter heuristics, not perceptual laws or a statistical significance test.
// An absolute floor and offset suppress tiny changes; recent log-MAD raises the relative threshold.
const PERCEPTION_FLOOR_MS = 1_000;
const DURATION_SCALE_MS = 10_000;
const NOTICEABLE_LOG_CHANGE = Math.log(1.1);
const ALWAYS_NOTICEABLE_LOG_CHANGE = Math.log(2);
const MAD_TO_SIGMA = 1.4826;
const MIN_VARIABILITY_SAMPLES = 3;
const MAX_SAMPLES = 10;
const MAX_ROLLUP_RUNS = 20;
const MAX_TRIGGERS = 10;

const logDuration = (ms: number) => Math.log(ms + DURATION_SCALE_MS);
const isDuration = (ms: number | null | undefined): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms >= 0;
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Whether a change clears the notification heuristic for comparable durations.
 * The variability cap applies to offset durations (ms + 10 s), not raw doubling/halving.
 */
export function significantDurationChange(previousMs: number | null | undefined, currentMs: number | null | undefined, recentMs: readonly number[] = []): boolean {
  if (!isDuration(previousMs) || !isDuration(currentMs) || Math.abs(currentMs - previousMs) < PERCEPTION_FLOOR_MS) return false;
  const samples = recentMs.filter(isDuration).slice(-MAX_SAMPLES).map(logDuration);
  let threshold = NOTICEABLE_LOG_CHANGE;
  if (samples.length >= MIN_VARIABILITY_SAMPLES) {
    const center = median(samples);
    const spread = MAD_TO_SIGMA * median(samples.map((value) => Math.abs(value - center)));
    threshold = Math.min(ALWAYS_NOTICEABLE_LOG_CHANGE, NOTICEABLE_LOG_CHANGE + 2 * spread);
  }
  return Math.abs(logDuration(currentMs) - logDuration(previousMs)) > threshold;
}

/** A finding identity that is stable across runs: job ids change every run, job keys and details do not. */
export function findingSignature(finding: Pick<BenchmarkFinding, "id" | "category" | "jobKey">): string {
  const parts = finding.id.split(":");
  if (parts.length > 1 && /^\d+$/.test(parts[1]!)) parts.splice(1, 1);
  return JSON.stringify([finding.category, finding.jobKey, parts.join(":")]);
}

function actionableFindings(benchmark: RunBenchmark): BenchmarkFinding[] {
  // Rework and cache-save fixes can have zero measured savings; bounds are not an actionability test.
  if (benchmark.analysisStatus === "unavailable") return [];
  return benchmark.findings.filter((finding) =>
    finding.id.trim().length > 0 && finding.category.trim().length > 0 && finding.summary.trim().length > 0 &&
    finding.recommendation.trim().length > 0 && finding.evidence.some((line) => line.trim().length > 0));
}

function durationMetrics(benchmark: RunBenchmark): Map<string, number> {
  const metrics = new Map<string, number>();
  const add = (name: string, ms: number | null | undefined) => { if (isDuration(ms)) metrics.set(name, (metrics.get(name) ?? 0) + ms); };
  add("elapsed", benchmark.metrics?.elapsedMs);
  add("queue-inclusive", benchmark.metrics?.queueInclusiveMs);
  add("runner", benchmark.metrics?.runnerMs);
  for (const job of benchmark.jobs) add(`job ${job.key}`, job.durationMs);
  return metrics;
}

interface RunOrder { runId: number; runAttempt: number; updatedAt: string }
const orderOf = (event: FeedbackEvent): RunOrder => ({
  runId: event.benchmark.runId, runAttempt: event.benchmark.runAttempt, updatedAt: event.sourceUpdatedAt,
});
const compareRuns = (a: RunOrder, b: RunOrder) =>
  Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.runId - b.runId || a.runAttempt - b.runAttempt;
function jobShape(benchmark: RunBenchmark): string | undefined {
  if (benchmark.omittedJobs || !isDuration(benchmark.metrics?.elapsedMs) || !isDuration(benchmark.metrics?.runnerMs)) return undefined;
  return JSON.stringify(benchmark.jobs.map((job) => [job.key, job.name]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
interface FeedbackGate {
  /** Newest success seen, so older successes replayed later never re-broadcast. */
  latest?: RunOrder;
  /** Last broadcast, not last observation: gradual drift accumulates. */
  reference?: { metrics: Map<string, number>; signatures: Set<string>; shape: string | undefined };
  lastSeen: number;
  sampleShape?: string;
  samples: Map<string, number[]>;
  rollup: FeedbackRollup;
}
const emptyRollup = (): FeedbackRollup => ({
  runs: [], omittedRuns: 0, byConclusion: [], nonSuccessRunnerMs: 0, nonSuccessRunsWithoutRunnerMs: 0, quietSuccesses: 0,
});

export async function feedbackInventory(access: RemoteAccess, repo: string, since: string): Promise<FeedbackProducer[]> {
  const target = await resolveRepository(access, repo);
  const client = repositoryReader(access, target);
  const metadata = (await client.request("GET /repos/{owner}/{repo}", { ...target.repo })).data as { default_branch?: string };
  if (!metadata.default_branch) throw new AgentError("Feedback repository has no verified default branch.");
  const workflow = (await client.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}", {
    ...target.repo, workflow_id: FEEDBACK_WORKFLOW.split("/").at(-1),
  })).data as { id?: number; path?: string; state?: string };
  if (!Number.isSafeInteger(workflow.id) || workflow.path !== FEEDBACK_WORKFLOW || workflow.state !== "active") {
    throw new AgentError("The trusted telemetry producer workflow is unavailable or inactive.");
  }
  const found = new Map<number, FeedbackProducer>();
  let total: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const data = (await client.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
      ...target.repo, workflow_id: workflow.id, event: "workflow_run", created: `>=${since}`, per_page: 100, page,
    })).data as { total_count?: number; workflow_runs?: unknown[] };
    if (!Number.isSafeInteger(data.total_count) || data.total_count! < 0 || data.total_count! > MAX_INVENTORY ||
      (total !== undefined && total !== data.total_count) || !Array.isArray(data.workflow_runs)) {
      throw new AgentError("Feedback inventory changed or exceeds 1000 producers; collection is incomplete, not clean.");
    }
    total = data.total_count;
    for (const raw of data.workflow_runs) {
      const run = producerSchema.parse(raw);
      if (run.workflow_id !== workflow.id || run.path !== FEEDBACK_WORKFLOW || run.head_branch !== metadata.default_branch ||
        Date.parse(run.created_at) < Date.parse(since) || found.has(run.id)) {
        throw new AgentError("Feedback producer identity, branch, ordering, or pagination is inconsistent.");
      }
      found.set(run.id, run);
    }
    if (found.size === total) return [...found.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
    if (!data.workflow_runs.length || found.size > total!) break;
  }
  throw new AgentError("Feedback inventory is incomplete; replay has not advanced.");
}

export async function readFeedback(access: RemoteAccess, repo: string, producer: FeedbackProducer): Promise<FeedbackEvent> {
  const target = await resolveRepository(access, repo);
  const client = repositoryReader(access, target);
  const data = (await client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs", {
    ...target.repo, run_id: producer.id, attempt_number: producer.run_attempt, per_page: 100, page: 1,
  })).data as { total_count?: number; jobs?: { id: number; name: string; status: string }[] };
  if (!Array.isArray(data.jobs) || data.total_count !== data.jobs.length || data.jobs.length > 100) {
    throw new AgentError("Telemetry producer job inventory is incomplete.");
  }
  const jobs = data.jobs.filter((job) => job.name === "telemetry" && job.status === "completed");
  if (jobs.length !== 1 || !Number.isSafeInteger(jobs[0]!.id)) throw new AgentError("Telemetry producer has no unique completed telemetry job.");
  const log = (await client.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", {
    ...target.repo, job_id: jobs[0]!.id,
  })).data;
  if (typeof log !== "string") throw new AgentError("Telemetry producer log is unavailable.");
  let benchmark: RunBenchmark;
  try { benchmark = decodeBenchmark(log); }
  catch { throw new AgentError("Telemetry producer did not publish a complete, valid benchmark. Inspect the producer run; do not infer zero findings."); }
  if (benchmark.repositoryId !== target.id || benchmark.repository.toLowerCase() !== target.fullName.toLowerCase()) {
    throw new AgentError("Benchmark repository identity does not match the authorized repository.");
  }
  const source = (await client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}", {
    ...target.repo, run_id: benchmark.runId, attempt_number: benchmark.runAttempt,
  })).data as { id?: number; run_attempt?: number; head_sha?: string; head_branch?: string | null; workflow_id?: number; repository?: { id?: number }; status?: string; conclusion?: string | null; path?: string; event?: string; updated_at?: string };
  if (source.id !== benchmark.runId || source.run_attempt !== benchmark.runAttempt || source.head_sha !== benchmark.headSha ||
    source.workflow_id !== benchmark.workflowId || source.repository?.id !== target.id || source.status !== "completed" ||
    source.path !== benchmark.workflowPath || source.conclusion !== benchmark.conclusion) {
    throw new AgentError("Benchmark source run provenance does not match GitHub.");
  }
  if (!(source.head_branch === null || typeof source.head_branch === "string") ||
    typeof source.event !== "string" || !source.event.length || source.event.length > 100 ||
    !z.iso.datetime().safeParse(source.updated_at).success) {
    throw new AgentError("Benchmark source run comparison metadata is unavailable; collection is incomplete.");
  }
  return {
    key: `${target.id}:${producer.id}:${producer.run_attempt}`, repository: target.fullName, repositoryId: target.id,
    producer, benchmark, sourceBranch: source.head_branch ?? "", sourceEvent: source.event, sourceUpdatedAt: source.updated_at!,
  };
}

/** A bounded in-memory outbox; durable replay comes from GitHub producer logs and client receipts. */
export function attachFeedback(server: McpServer, remote: RemoteOptions, options: FeedbackOptions): void {
  if (!remote.allow.length || remote.allow.length > 5) throw new AgentError("Feedback polling requires one to five explicitly authorized repositories per server.");
  const sinceMs = Date.parse(options.since);
  if (!Number.isFinite(sinceMs) || sinceMs > Date.now() || Date.now() - sinceMs > FEEDBACK_REPLAY_MS) {
    throw new AgentError("Feedback --since must be an ISO timestamp within the last seven days.");
  }
  const controller = new AbortController();
  const repositoryIds = remote.repositoryIds ?? new Map<string, number>();
  const access = (signal: AbortSignal) => operationAccess({ ...remote, repositoryIds }, signal);
  const outbox = new Map<string, { event: FeedbackEvent; resource: RegisteredResource }>();
  const seen = new Map<string, number>();
  const retry = new Map<string, { at: number; created: number; message: string }>();
  const undelivered = new Map<string, number>();
  const newestNext = new Map<string, boolean>();
  const snapshots = new Map<string, { keys: Set<string>; events: Map<string, FeedbackEvent>; ready: boolean }>();
  const sourceSeen = new Map<string, number>();
  const lastInventory = new Map(remote.allow.map((repo) => [repo.toLowerCase(), sinceMs]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One series per workflow, source branch and trigger. Job topology gates metric comparisons within it.
  const gates = new Map<string, FeedbackGate>();
  const maxGates = MAX_INVENTORY * remote.allow.length;
  let filtered = 0;
  let rolledUp = 0;
  let suppressedUnchanged = 0;
  const counters = () => {
    let seriesAwaitingSuccess = 0;
    let heldRuns = 0;
    for (const gate of gates.values()) {
      if (!gate.latest) seriesAwaitingSuccess++;
      heldRuns += gate.rollup.runs.length + gate.rollup.omittedRuns;
    }
    const buffered = [...snapshots.values()].reduce((sum, snapshot) => sum + snapshot.events.size, 0);
    return { filtered, rolledUp, suppressedUnchanged, seriesAwaitingSuccess, heldRuns, buffered };
  };
  let status: Record<string, unknown> = { state: "starting", since: options.since, replayDays: 7, pending: 0, ...counters() };
  let errorResource: RegisteredResource | undefined;
  let lastError = "";
  let replayGap: string | undefined;
  const resource = (uri: URL, value: unknown) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }] });
  server.registerResource("feedback-status", "cicd://feedback/status", {
    title: "CI benchmark feed status", mimeType: "application/json",
    description: "Replay scope, pending actionable events, filtered, rolled-up and unchanged benchmarks, backpressure and collection errors. Broadcasts start at a workflow's first successful run. No broadcast is not a completeness guarantee.",
  }, (uri) => resource(uri, status));
  server.registerTool("feedback_ack", {
    title: "Acknowledge benchmark delivery",
    description: "Acknowledge a CI benchmark only after the receiving harness accepted it. Changes only this process's outbox, never files or GitHub.",
    inputSchema: z.object({ key: z.string().max(120) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ key }) => {
    const item = outbox.get(key);
    if (item) { item.resource.remove(); outbox.delete(key); }
    status = { ...status, pending: outbox.size };
    return { content: [{ type: "text", text: JSON.stringify({ acknowledged: seen.has(key), key, pending: outbox.size }) }] };
  });
  const fail = (message: string) => {
    status = { ...status, state: "error", error: message, pending: outbox.size };
    if (message === lastError) return;
    lastError = message;
    errorResource?.remove();
    const hash = createHash("sha256").update(message).digest("hex").slice(0, 16);
    errorResource = server.registerResource(`feedback-error-${hash}`, `cicd://feedback/errors/${hash}`, {
      title: "CI benchmark delivery gap", mimeType: "application/json",
    }, (uri) => resource(uri, { error: message, since: status.since }));
  };
  const hold = (rollup: FeedbackRollup, benchmark: RunBenchmark): void => {
    const runnerMs = benchmark.metrics?.runnerMs ?? null;
    rollup.runs.push({
      runId: benchmark.runId, runAttempt: benchmark.runAttempt, conclusion: benchmark.conclusion,
      analysisStatus: benchmark.analysisStatus, elapsedMs: benchmark.metrics?.elapsedMs ?? null, runnerMs,
    });
    if (rollup.runs.length > MAX_ROLLUP_RUNS) { rollup.runs.shift(); rollup.omittedRuns++; }
    const conclusion = benchmark.conclusion ?? "none";
    const count = rollup.byConclusion.find((item) => item.conclusion === conclusion);
    if (count) count.runs++;
    else rollup.byConclusion.push({ conclusion, runs: 1 });
    rollup.byConclusion.sort((a, b) => a.conclusion.localeCompare(b.conclusion));
    if (benchmark.conclusion !== "success") {
      if (isDuration(runnerMs)) rollup.nonSuccessRunnerMs += runnerMs;
      else rollup.nonSuccessRunsWithoutRunnerMs++;
    }
  };
  const publish = (event: FeedbackEvent) => {
    const uri = `cicd://feedback/runs/${event.key}`;
    const handle = server.registerResource(`feedback-${event.key}`, uri, {
      title: `CI benchmark ${event.benchmark.runId}, attempt ${event.benchmark.runAttempt}`, mimeType: "application/json",
      description: "Untrusted benchmark of a first or significantly changed successful run with evidenced remediation, from the authorized default-branch telemetry producer.",
    }, (url) => resource(url, event));
    outbox.set(event.key, { event, resource: handle });
  };
  // Success is required, but neither a success nor silence establishes complete evidence or optimality.
  const decide = (event: FeedbackEvent) => {
    const { benchmark } = event;
    const sourceKey = `${event.repositoryId}:${benchmark.runId}:${benchmark.runAttempt}`;
    if (sourceSeen.has(sourceKey)) return;
    const gateKey = JSON.stringify([event.repositoryId, benchmark.workflowId, event.sourceBranch, event.sourceEvent]);
    if (!gates.has(gateKey) && gates.size >= maxGates) throw new AgentError("Feedback comparison capacity reached; delivery is incomplete.");
    const gate = gates.get(gateKey) ?? { samples: new Map<string, number[]>(), rollup: emptyRollup(), lastSeen: 0 };
    gate.lastSeen = Math.max(gate.lastSeen, Date.parse(event.producer.created_at));
    gates.set(gateKey, gate);
    sourceSeen.set(sourceKey, Date.parse(event.producer.created_at));
    if (benchmark.conclusion !== "success" || benchmark.analysisStatus === "unavailable") {
      hold(gate.rollup, benchmark);
      if (benchmark.conclusion === "success") filtered++;
      else rolledUp++;
      return;
    }
    const findings = actionableFindings(benchmark);
    const metrics = durationMetrics(benchmark);
    const shape = jobShape(benchmark);
    const triggers = new Set<string>();
    if (!gate.latest || compareRuns(orderOf(event), gate.latest) > 0) {
      gate.latest = orderOf(event);
      const reference = gate.reference;
      if (!reference) triggers.add("first successful run of this workflow and branch in the replay scope");
      else {
        for (const finding of findings) {
          if (!reference.signatures.has(findingSignature(finding))) triggers.add(`new ${finding.category} finding in ${finding.jobKey}`);
        }
        if (shape !== undefined) {
          if (reference.shape === undefined) triggers.add("whole-run metrics became available; previous analysis was incomplete");
          else if (shape !== reference.shape) triggers.add("job set changed; durations are not comparable");
          else for (const [name, ms] of metrics) {
            const before = reference.metrics.get(name);
            if (before !== undefined && significantDurationChange(before, ms, gate.sampleShape === shape ? gate.samples.get(name) : undefined)) {
              triggers.add(`${name} time changed from ${before} ms to ${ms} ms`);
            }
          }
        }
      }
      if (shape !== undefined) {
        if (shape !== gate.sampleShape) gate.samples.clear();
        gate.sampleShape = shape;
        for (const [name, ms] of metrics) {
          const samples = gate.samples.get(name) ?? [];
          samples.push(ms);
          if (samples.length > MAX_SAMPLES) samples.shift();
          gate.samples.set(name, samples);
        }
      }
    }
    if (!triggers.size || !findings.length) {
      gate.rollup.quietSuccesses++;
      if (findings.length) suppressedUnchanged++;
      else filtered++;
      return;
    }
    gate.reference = { metrics, signatures: new Set(findings.map(findingSignature)), shape };
    const rollup = gate.rollup;
    gate.rollup = emptyRollup();
    const trigger = [...triggers];
    publish({
      ...event,
      trigger: trigger.length > MAX_TRIGGERS ? [...trigger.slice(0, MAX_TRIGGERS - 1), `${trigger.length - MAX_TRIGGERS + 1} more changes`] : trigger,
      ...(rollup.runs.length || rollup.omittedRuns || rollup.quietSuccesses ? { rollup } : {}),
    });
  };
  const tick = async () => {
    const now = Date.now();
    const cutoff = Math.max(sinceMs, now - FEEDBACK_REPLAY_MS);
    status = { state: "polling", since: new Date(cutoff).toISOString(), replayDays: 7, pending: outbox.size, ...counters(), checkedAt: new Date(now).toISOString() };
    let failed = false;
    if ([...lastInventory.values()].some((at) => now - at > FEEDBACK_REPLAY_MS)) {
      replayGap = "No complete inventory was obtained within the seven-day replay window; historical delivery is incomplete.";
    }
    for (const [key, created] of seen) if (created < cutoff && !outbox.has(key)) seen.delete(key);
    for (const [key, created] of sourceSeen) if (created < cutoff) sourceSeen.delete(key);
    for (const [key, gate] of gates) if (gate.lastSeen < cutoff) {
      if (gate.rollup.runs.length || gate.rollup.omittedRuns) replayGap = "Held run summaries aged out of the replay window; historical rollup is incomplete.";
      gates.delete(key);
    }
    for (const [key, entry] of retry) if (entry.created < cutoff) {
      replayGap = `Unresolved producer ${key} aged out of the replay window; delivery is incomplete.`;
      retry.delete(key);
    }
    for (const [key, created] of undelivered) if (created < cutoff) {
      replayGap = `Undelivered producer ${key} aged out of the replay window; delivery is incomplete.`;
      undelivered.delete(key);
    }
    if (replayGap) { status.replayGap = true; fail(replayGap); failed = true; }
    try {
      for (const repo of remote.allow) {
        if (controller.signal.aborted) break;
        const producers = await operation((signal) => feedbackInventory(access(signal), repo, new Date(cutoff).toISOString()), controller.signal);
        const repoId = repositoryIds.get(repo.toLowerCase());
        const present = new Set<string>();
        for (const producer of producers) {
          const key = `${repoId}:${producer.id}:${producer.run_attempt}`;
          present.add(key);
          if (!seen.has(key)) {
            if (!undelivered.has(key) && undelivered.size >= MAX_INVENTORY * remote.allow.length) {
              throw new AgentError("Undelivered producer capacity exceeded; collection is incomplete.");
            }
            undelivered.set(key, Date.parse(producer.created_at));
          }
        }
        lastInventory.set(repo.toLowerCase(), now);
        for (const key of undelivered.keys()) if (key.startsWith(`${repoId}:`) && !present.has(key)) {
          fail(`Known producer ${key} is absent from the complete inventory; delivery is incomplete.`);
          failed = true;
        }
        let snapshot = snapshots.get(repo);
        if (!snapshot) {
          snapshot = { keys: new Set(producers.map((producer) => `${repoId}:${producer.id}:${producer.run_attempt}`).filter((key) => !seen.has(key))), events: new Map(), ready: false };
          snapshots.set(repo, snapshot);
        }
        const eligible = producers.filter((producer) => {
          const key = `${repoId}:${producer.id}:${producer.run_attempt}`;
          return snapshot.keys.has(key) && producer.status === "completed" && !seen.has(key) && (retry.get(key)?.at ?? 0) <= now;
        });
        let oldest = 0;
        let newest = eligible.length - 1;
        // Freeze membership so continuous arrivals cannot starve this bounded replay snapshot.
        // Preserve fetch fairness, but publish only after every member has been verified.
        for (let fetched = 0; fetched < 4 && oldest <= newest && outbox.size < MAX_PENDING; fetched++) {
          const takeNewest = newestNext.get(repo) ?? true;
          const producer = eligible[takeNewest ? newest-- : oldest++]!;
          newestNext.set(repo, !takeNewest);
          const key = `${repoId}:${producer.id}:${producer.run_attempt}`;
          try {
            const event = await operation((signal) => readFeedback(access(signal), repo, producer), controller.signal, LIMITS.operationMs);
            snapshot.events.set(key, event);
            seen.set(event.key, Date.parse(producer.created_at));
            retry.delete(key);
            undelivered.delete(key);
          } catch (error) {
            if (controller.signal.aborted) break;
            const message = `Producer ${producer.id}/${producer.run_attempt}: ${agentErrorMessage(error, "Feedback collection failed; check access, transport and operation budgets.")}`;
            retry.set(key, { at: now + 5 * 60_000, created: Date.parse(producer.created_at), message });
            fail(message);
            failed = true;
          }
        }
        if (snapshot.events.size === snapshot.keys.size) snapshot.ready = true;
        if (snapshot.ready) {
          for (const event of [...snapshot.events.values()].sort((a, b) => compareRuns(orderOf(a), orderOf(b)) || a.producer.id - b.producer.id || a.producer.run_attempt - b.producer.run_attempt)) {
            if (outbox.size >= MAX_PENDING) break;
            decide(event);
            snapshot.events.delete(event.key);
          }
          if (!snapshot.events.size) snapshots.delete(repo);
        }
        Object.assign(status, counters());
      }
      if (!failed) {
        status = { ...status, state: retry.size ? "error" : outbox.size >= MAX_PENDING ? "backpressure" : undelivered.size ? "catching-up" : "watching", pending: outbox.size,
          undelivered: undelivered.size,
          ...(retry.size ? { error: [...retry.values()][0]!.message } : {}) };
        if (!retry.size) { errorResource?.remove(); errorResource = undefined; lastError = ""; }
      }
    } catch (error) {
      if (!controller.signal.aborted) fail(agentErrorMessage(error, "Feedback inventory failed; check access, transport and operation budgets."));
    } finally {
      if (!controller.signal.aborted) {
        timer = setTimeout(() => { void tick(); }, (options.pollMs ?? 60_000) * remote.allow.length);
        timer.unref();
      }
    }
  };
  const initialized = server.server.oninitialized;
  server.server.oninitialized = () => { initialized?.(); void tick(); };
  const closed = server.server.onclose;
  server.server.onclose = () => { controller.abort(); clearTimeout(timer); closed?.(); };
}
