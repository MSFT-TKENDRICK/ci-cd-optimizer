import { createHash } from "node:crypto";
import type { McpServer, RegisteredResource } from "@modelcontextprotocol/server";
import { z } from "zod";
import { decodeBenchmark, type RunBenchmark } from "../telemetry/benchmark.js";
import { operationAccess, repositoryReader, resolveRepository, type RemoteAccess, type RemoteOptions } from "./remote.js";
import { LIMITS, operation } from "./safety.js";
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
export interface FeedbackEvent {
  key: string;
  repository: string;
  repositoryId: number;
  producer: FeedbackProducer;
  benchmark: RunBenchmark;
}
export interface FeedbackOptions {
  /** Explicit start of the replay scope; this is never an inferred authorization boundary. */
  since: string;
  pollMs?: number;
}

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
  })).data as { id?: number; run_attempt?: number; head_sha?: string; workflow_id?: number; repository?: { id?: number }; status?: string; conclusion?: string | null; path?: string };
  if (source.id !== benchmark.runId || source.run_attempt !== benchmark.runAttempt || source.head_sha !== benchmark.headSha ||
    source.workflow_id !== benchmark.workflowId || source.repository?.id !== target.id || source.status !== "completed" ||
    source.path !== benchmark.workflowPath || source.conclusion !== benchmark.conclusion) {
    throw new AgentError("Benchmark source run provenance does not match GitHub.");
  }
  return {
    key: `${target.id}:${producer.id}:${producer.run_attempt}`, repository: target.fullName, repositoryId: target.id,
    producer, benchmark,
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
  const lastInventory = new Map(remote.allow.map((repo) => [repo.toLowerCase(), sinceMs]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: Record<string, unknown> = { state: "starting", since: options.since, replayDays: 7, pending: 0 };
  let errorResource: RegisteredResource | undefined;
  let lastError = "";
  let replayGap: string | undefined;
  const resource = (uri: URL, value: unknown) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }] });
  server.registerResource("feedback-status", "cicd://feedback/status", {
    title: "CI benchmark feed status", mimeType: "application/json",
    description: "Replay scope, pending events, backpressure and collection errors. Empty findings are not a completeness guarantee.",
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
  const tick = async () => {
    const now = Date.now();
    const cutoff = Math.max(sinceMs, now - FEEDBACK_REPLAY_MS);
    status = { state: "polling", since: new Date(cutoff).toISOString(), replayDays: 7, pending: outbox.size, checkedAt: new Date(now).toISOString() };
    let failed = false;
    if ([...lastInventory.values()].some((at) => now - at > FEEDBACK_REPLAY_MS)) {
      replayGap = "No complete inventory was obtained within the seven-day replay window; historical delivery is incomplete.";
    }
    for (const [key, created] of seen) if (created < cutoff && !outbox.has(key)) seen.delete(key);
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
        const eligible = producers.filter((producer) => {
          const key = `${repoId}:${producer.id}:${producer.run_attempt}`;
          return producer.status === "completed" && !seen.has(key) && (retry.get(key)?.at ?? 0) <= now;
        });
        let oldest = 0;
        let newest = eligible.length - 1;
        // Share the bounded budget between current results and historical replay without starving either.
        for (let fetched = 0; fetched < 4 && oldest <= newest && outbox.size < MAX_PENDING; fetched++) {
          const takeNewest = newestNext.get(repo) ?? true;
          const producer = eligible[takeNewest ? newest-- : oldest++]!;
          newestNext.set(repo, !takeNewest);
          const key = `${repoId}:${producer.id}:${producer.run_attempt}`;
          try {
            const event = await operation((signal) => readFeedback(access(signal), repo, producer), controller.signal, LIMITS.operationMs);
            const uri = `cicd://feedback/runs/${event.key}`;
            const handle = server.registerResource(`feedback-${event.key}`, uri, {
              title: `CI benchmark ${event.benchmark.runId}, attempt ${event.benchmark.runAttempt}`, mimeType: "application/json",
              description: "Untrusted benchmark evidence from the authorized default-branch telemetry producer.",
            }, (url) => resource(url, event));
            outbox.set(event.key, { event, resource: handle });
            seen.set(event.key, Date.parse(producer.created_at));
            retry.delete(key);
            undelivered.delete(key);
          } catch (error) {
            if (controller.signal.aborted) break;
            const message = `Producer ${producer.id}/${producer.run_attempt}: ${error instanceof AgentError ? error.message : "Feedback collection failed; check access, transport and operation budgets."}`;
            retry.set(key, { at: now + 5 * 60_000, created: Date.parse(producer.created_at), message });
            fail(message);
            failed = true;
          }
        }
      }
      if (!failed) {
        status = { ...status, state: retry.size ? "error" : outbox.size >= MAX_PENDING ? "backpressure" : undelivered.size ? "catching-up" : "watching", pending: outbox.size,
          undelivered: undelivered.size,
          ...(retry.size ? { error: [...retry.values()][0]!.message } : {}) };
        if (!retry.size) { errorResource?.remove(); errorResource = undefined; lastError = ""; }
      }
    } catch (error) {
      if (!controller.signal.aborted) fail(error instanceof AgentError ? error.message : "Feedback inventory failed; check access, transport and operation budgets.");
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
