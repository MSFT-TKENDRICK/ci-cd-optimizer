import type { JobSnapshot, WorkflowBaseline, WorkflowSnapshot } from "../types.js";

interface CriticalPath {
  durationMs: number;
  jobKeys: string[];
}

export function createTelemetryReport(
  snapshot: WorkflowSnapshot,
  baseline?: WorkflowBaseline,
): string {
  const criticalPath = calculateCriticalPath(snapshot.jobs);
  const slowest = [...snapshot.jobs].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
  const comparison = baseline
    ? compare(snapshot.durationMs, baseline.medianDurationMs, baseline.sampleCount)
    : "No historical baseline exists yet; this run establishes the first snapshot.";

  return [
    `## ${snapshot.workflowName} performance snapshot`,
    "",
    `**Run:** ${formatDuration(snapshot.durationMs)} · **Queue:** ${formatDuration(snapshot.queueMs)} · **Jobs:** ${snapshot.jobs.length}`,
    "",
    comparison,
    "",
    `**Estimated critical path:** ${formatDuration(criticalPath.durationMs)} — ${criticalPath.jobKeys.join(" → ") || "unavailable"}`,
    "",
    "### Timeline",
    "",
    createGantt(snapshot),
    "",
    "### Job dependencies",
    "",
    createDependencyGraph(snapshot.jobs, criticalPath.jobKeys),
    "",
    "### Longest jobs",
    "",
    "| Job | Duration | Share of run |",
    "|---|---:|---:|",
    ...slowest.map(
      (job) =>
        `| ${escapeCell(job.name)} | ${formatDuration(job.durationMs)} | ${percentage(job.durationMs, snapshot.durationMs)} |`,
    ),
    "",
    ...recommendations(snapshot, criticalPath, baseline),
  ].join("\n");
}

export function calculateCriticalPath(jobs: JobSnapshot[]): CriticalPath {
  const byKey = new Map(jobs.map((job) => [job.key, job]));
  const memo = new Map<string, CriticalPath>();
  const visiting = new Set<string>();

  function visit(key: string): CriticalPath {
    const cached = memo.get(key);
    if (cached) return cached;
    const job = byKey.get(key);
    if (!job || visiting.has(key)) return { durationMs: 0, jobKeys: [] };
    visiting.add(key);
    const parentPaths = job.needs.map(visit);
    const longestParent = parentPaths.reduce<CriticalPath>(
      (longest, candidate) => (candidate.durationMs > longest.durationMs ? candidate : longest),
      { durationMs: 0, jobKeys: [] },
    );
    visiting.delete(key);
    const result = {
      durationMs: longestParent.durationMs + job.durationMs,
      jobKeys: [...longestParent.jobKeys, key],
    };
    memo.set(key, result);
    return result;
  }

  return jobs.reduce<CriticalPath>(
    (longest, job) => {
      const candidate = visit(job.key);
      return candidate.durationMs > longest.durationMs ? candidate : longest;
    },
    { durationMs: 0, jobKeys: [] },
  );
}

function createGantt(snapshot: WorkflowSnapshot): string {
  const jobs = [...snapshot.jobs].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
  );
  return [
    "```mermaid",
    "gantt",
    `    title ${sanitizeMermaid(snapshot.workflowName)} run ${snapshot.runId}`,
    "    dateFormat  YYYY-MM-DDTHH:mm:ss",
    "    axisFormat  %H:%M:%S",
    "    section Jobs",
    ...jobs.map(
      (job, index) =>
        `    ${sanitizeMermaid(job.name)} :${job.conclusion === "success" ? "done, " : ""}j${index}, ${withoutMillis(job.startedAt)}, ${withoutMillis(job.completedAt)}`,
    ),
    "```",
  ].join("\n");
}

function createDependencyGraph(jobs: JobSnapshot[], criticalKeys: string[]): string {
  const identifiers = new Map(jobs.map((job, index) => [job.key, `J${index}`]));
  const critical = new Set(criticalKeys);
  const nodes = jobs.map(
    (job) =>
      `    ${identifiers.get(job.key)}["${sanitizeMermaid(job.name)}<br/>${formatDuration(job.durationMs)}"]`,
  );
  const edges = jobs.flatMap((job) =>
    job.needs
      .filter((dependency) => identifiers.has(dependency))
      .map(
        (dependency) =>
          `    ${identifiers.get(dependency)} --> ${identifiers.get(job.key)}`,
      ),
  );
  const styles = jobs
    .filter((job) => critical.has(job.key))
    .map((job) => `    style ${identifiers.get(job.key)} stroke:#d1242f,stroke-width:3px`);
  return ["```mermaid", "flowchart LR", ...nodes, ...edges, ...styles, "```"].join("\n");
}

function recommendations(
  snapshot: WorkflowSnapshot,
  criticalPath: CriticalPath,
  baseline?: WorkflowBaseline,
): string[] {
  const messages: string[] = ["### Observations", ""];
  const longest = [...snapshot.jobs].sort((a, b) => b.durationMs - a.durationMs)[0];
  if (longest && longest.durationMs > snapshot.durationMs * 0.5) {
    messages.push(
      `- **${longest.name} dominates the run** at ${percentage(longest.durationMs, snapshot.durationMs)}. Profile its internal steps, then consider test sharding, incremental builds, or a larger runner.`,
    );
  }
  if (snapshot.queueMs > 60_000) {
    messages.push(
      `- **Runner queueing added ${formatDuration(snapshot.queueMs)}.** Review runner concurrency, autoscaling latency, labels, and peak utilization.`,
    );
  }
  if (criticalPath.durationMs > 0 && criticalPath.durationMs < snapshot.durationMs * 0.7) {
    messages.push(
      "- **The dependency graph leaves material orchestration overhead.** Inspect setup/teardown gaps and jobs not represented by explicit `needs` relationships.",
    );
  }
  if (baseline && snapshot.durationMs > baseline.medianDurationMs * 1.2) {
    messages.push(
      `- **This run regressed by more than 20%** versus the ${baseline.sampleCount}-run median. Compare changed build inputs, cache hits, and runner type.`,
    );
  }
  if (messages.length === 2) {
    messages.push(
      "- No strong timing anomaly was detected. Accumulate more snapshots to improve trend confidence.",
    );
  }
  return messages;
}

function compare(current: number, median: number, samples: number): string {
  if (median === 0) return `Compared with ${samples} prior successful runs.`;
  const delta = ((current - median) / median) * 100;
  const direction = delta > 0 ? "slower" : "faster";
  return `Compared with the median of ${samples} prior successful runs, this run is **${Math.abs(delta).toFixed(1)}% ${direction}** (${formatDuration(median)} baseline).`;
}

function percentage(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(0)}%` : "0%";
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function withoutMillis(value: string): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "");
}

function sanitizeMermaid(value: string): string {
  return value.replace(/["`:;#]/g, "").replace(/\r?\n/g, " ").slice(0, 120);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
