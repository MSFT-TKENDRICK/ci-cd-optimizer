import type { BaselineDiagnostic, BaselineExclusion, JobBaseline, JobSnapshot, WorkflowBaseline, WorkflowSnapshot } from "./types.js";
import { comparisonProblem, EXCLUSION_DESCRIPTIONS } from "./context.js";
import type { RunAttribution } from "./attribution.js";

const QUEUE_THRESHOLD_MS = 5_000;
/** Per-job medians need this many samples before a slowdown is reported as a regression. */
const JOB_REGRESSION_MIN_SAMPLES = 3;

export interface TelemetryReportExtras {
  /** Why earlier runs could not form a run-level baseline. */
  diagnostic?: BaselineDiagnostic;
  /** Per-job medians that remain comparable when the run-level job set changed. */
  jobBaselines?: JobBaseline[];
  /** Observed log and step evidence for bottleneck candidates. */
  attribution?: RunAttribution;
  /** Why bottleneck attribution could not be computed for this run. */
  attributionUnavailable?: string;
}

export interface CriticalPath {
  durationMs: number;
  jobKeys: string[];
}

export function createTelemetryReport(
  snapshot: WorkflowSnapshot,
  baseline?: WorkflowBaseline,
  extras: TelemetryReportExtras = {},
): string {
  const criticalPath = calculateCriticalPath(snapshot.jobs);
  const slowest = [...snapshot.jobs].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
  const comparison = baseline
    ? compare(snapshot.durationMs, baseline.medianDurationMs, baseline.sampleCount)
    : comparisonProblem(snapshot)
      ? `Performance comparison withheld: ${comparisonProblem(snapshot)}`
      : describeMissingBaseline(extras.diagnostic);

  return [
    `## ${snapshot.workflowName} performance snapshot`,
    "",
    `**Run:** ${formatDuration(snapshot.durationMs)} · **Attempt:** ${snapshot.runAttempt} · **Queue:** ${snapshot.queueMs === null || snapshot.runAttempt !== 1 ? "unavailable" : formatDuration(snapshot.queueMs)} · **Jobs:** ${snapshot.jobs.length}`,
    "",
    comparison,
    "",
    `**Estimated critical path:** ${formatDuration(criticalPath.durationMs)} — ${criticalPath.jobKeys.join(" → ") || "unavailable"}`,
    "",
    "### Timeline",
    "",
    createGantt(snapshot, criticalPath.jobKeys),
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
    ...slowestSteps(snapshot),
    ...jobHistory(snapshot, baseline, extras.jobBaselines),
    ...jobRegressions(snapshot, baseline, extras.jobBaselines),
    ...attributionReport(extras.attribution, extras.attributionUnavailable),
    ...recommendations(snapshot, criticalPath, baseline),
  ].join("\n");
}

function attributionReport(attribution?: RunAttribution, unavailable?: string): string[] {
  if (!attribution) {
    return unavailable ? ["### Bottleneck evidence", "", unavailable, ""] : [];
  }
  const findings = attribution.bottlenecks.slice(0, 10);
  const gaps = attribution.gaps.slice(0, 10);
  return [
    "### Bottleneck evidence",
    "",
    `Observed ${formatDuration(attribution.coverage.observedMs)} across ${attribution.coverage.jobs} timed job(s); logs were parsed for ${attribution.coverage.jobsWithLogs}. Step timing explains ${formatDuration(attribution.coverage.explainedMs)}; ${formatDuration(attribution.coverage.unexplainedMs)} remains unexplained or unobserved.`,
    "",
    "_Savings are evidence-based upper bounds, not predicted speedups. Findings can overlap; do not add their bounds together._",
    "",
    ...(findings.length > 0
      ? [
          "| Candidate and next check | Job(s) | Observed | Elapsed upper bound | Runner upper bound | Evidence",
          "|---|---|---:|---:|---:|---|",
          ...findings.map((finding) =>
            `| ${escapeReportCell(`${finding.summary} ${finding.recommendation}`)} | ${escapeReportCell(finding.jobName)} | ${formatDuration(finding.observedMs)} | ${formatDuration(finding.elapsedSavingsBoundMs)} | ${formatDuration(finding.runnerSavingsBoundMs)} | ${escapeReportCell(finding.evidence.slice(0, 2).join("; "))} |`,
          ),
          ...(attribution.bottlenecks.length > findings.length
            ? [`| ${attribution.bottlenecks.length - findings.length} additional candidate(s) omitted | | | | | |`]
            : []),
        ]
      : ["No recognized bottleneck pattern was found in the examined evidence."]),
    ...(gaps.length > 0
      ? [
          "",
          "#### Evidence coverage gaps",
          "",
          "| Job | Gap | Time | Detail |",
          "|---|---|---:|---|",
          ...gaps.map((gap) =>
            `| ${escapeReportCell(gap.jobName ?? gap.jobKey)} | ${escapeReportCell(gap.kind)} | ${gap.ms === undefined ? "—" : formatDuration(gap.ms)} | ${escapeReportCell(gap.detail)} |`,
          ),
          ...(attribution.gaps.length > gaps.length
            ? [`| | ${attribution.gaps.length - gaps.length} additional gap(s) omitted | | |`]
            : []),
        ]
      : []),
    "",
  ];
}

function escapeReportCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/([`*_{}\x5B\x5D()<>])/g, "\\$1");
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

function createGantt(snapshot: WorkflowSnapshot, criticalKeys: readonly string[]): string {
  const critical = new Set(criticalKeys);
  const jobs = snapshot.jobs.filter((job) => job.conclusion !== "skipped").sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
  );
  const skippedCount = snapshot.jobs.length - jobs.length;
  const skippedNote = skippedCount > 0
    ? [`_${skippedCount} skipped job(s) omitted from the execution timeline; job inventory is unchanged._`]
    : [];
  if (jobs.length === 0) return ["No executed jobs to plot.", ...skippedNote].join("\n\n");
  const waits = jobs.filter((job) => job.queuedAt && (job.queueMs ?? 0) >= QUEUE_THRESHOLD_MS);
  const tags = (job: JobSnapshot) =>
    [critical.has(job.key) ? "crit" : "", job.conclusion === "success" ? "done" : job.conclusion === "failure" ? "active" : ""]
      .filter(Boolean)
      .map((tag) => `${tag}, `)
      .join("");
  return [
    "```mermaid",
    "gantt",
    `    title ${sanitizeMermaid(snapshot.workflowName)} run ${snapshot.runId}`,
    "    dateFormat  YYYY-MM-DDTHH:mm:ss",
    "    axisFormat  %H:%M:%S",
    ...(waits.length > 0
      ? [
          "    section Runner queue",
          ...waits.map(
            (job, index) =>
              `    ${sanitizeMermaid(job.name)} wait :q${index}, ${withoutMillis(job.queuedAt as string)}, ${withoutMillis(job.startedAt)}`,
          ),
        ]
      : []),
    "    section Jobs",
    ...jobs.map(
      (job, index) =>
        `    ${sanitizeMermaid(job.name)} :${tags(job)}j${index}, ${withoutMillis(job.startedAt)}, ${withoutMillis(job.completedAt)}`,
    ),
    "```",
    "",
    "_Red bars are on the critical path; the runner queue lane shows time jobs spent waiting for a runner._",
    ...skippedNote,
  ].join("\n");
}

function slowestSteps(snapshot: WorkflowSnapshot, limit = 10): string[] {
  const steps = snapshot.jobs
    .flatMap((job) => (job.steps ?? []).map((step) => ({ job, step })))
    .sort((a, b) => b.step.durationMs - a.step.durationMs)
    .slice(0, limit);
  if (steps.length === 0) return [];
  return [
    "### Slowest steps",
    "",
    "| Job | Step | Duration | Share of job |",
    "|---|---|---:|---:|",
    ...steps.map(
      ({ job, step }) =>
        `| ${escapeCell(job.name)} | ${escapeCell(step.name)} | ${formatDuration(step.durationMs)} | ${percentage(step.durationMs, job.durationMs)} |`,
    ),
    "",
  ];
}

function describeMissingBaseline(diagnostic?: BaselineDiagnostic): string {
  const fallback = "No comparable historical baseline is available in the retained/backfilled evidence window.";
  if (!diagnostic) return fallback;
  if (diagnostic.examined === 0) return `${fallback} No earlier runs of this workflow were found.`;
  const reasons = (Object.entries(diagnostic.excluded) as [BaselineExclusion, number][])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return [
    `No run-level baseline: ${diagnostic.examined} earlier run(s) examined, ${diagnostic.comparable} comparable.`,
    ...(reasons.length ? [""] : []),
    ...reasons.map(([reason, count]) => `- ${count} excluded — ${EXCLUSION_DESCRIPTIONS[reason]}`),
  ].join("\n");
}

/** Per-job history, shown only without a run-level baseline, where it is the remaining timing evidence. */
function jobHistory(snapshot: WorkflowSnapshot, baseline?: WorkflowBaseline, jobs?: JobBaseline[]): string[] {
  if (baseline || !jobs?.length) return [];
  const byKey = new Map(snapshot.jobs.map((job) => [job.key, job]));
  const rows = jobs.flatMap((entry) => {
    const job = byKey.get(entry.key);
    return job ? [{ job, entry }] : [];
  }).sort((a, b) => b.job.durationMs - a.job.durationMs);
  if (rows.length === 0) return [];
  return [
    "### Per-job history",
    "",
    "_Each job is compared only with earlier successful first attempts of the identical job (same name, needs, runner labels and group)._",
    "",
    "| Job | This run | Median | Samples | Delta |",
    "|---|---:|---:|---:|---:|",
    ...rows.map(({ job, entry }) => {
      const delta = job.durationMs - entry.medianDurationMs;
      return `| ${escapeCell(job.name)} | ${formatDuration(job.durationMs)} | ${formatDuration(entry.medianDurationMs)} | ${entry.sampleCount} | ${delta >= 0 ? "+" : "−"}${formatDuration(Math.abs(delta))} |`;
    }),
    "",
  ];
}

function jobRegressions(snapshot: WorkflowSnapshot, baseline?: WorkflowBaseline, jobs?: JobBaseline[]): string[] {
  const medians: Record<string, number> | undefined = baseline
    ? baseline.jobs
    : Object.fromEntries((jobs ?? [])
      .filter((entry) => entry.sampleCount >= JOB_REGRESSION_MIN_SAMPLES)
      .map((entry) => [entry.key, entry.medianDurationMs]));
  if (!medians) return [];
  const rows = snapshot.jobs
    .map((job) => ({ job, median: medians[job.key] }))
    .filter(
      (row): row is { job: JobSnapshot; median: number } =>
        row.median !== undefined && row.job.durationMs - row.median >= 30_000 && row.job.durationMs > row.median * 1.25,
    )
    .sort((a, b) => b.job.durationMs - b.median - (a.job.durationMs - a.median));
  if (rows.length === 0) return [];
  return [
    "### Jobs slower than baseline",
    "",
    "| Job | This run | Median | Delta |",
    "|---|---:|---:|---:|",
    ...rows.map(
      ({ job, median }) =>
        `| ${escapeCell(job.name)} | ${formatDuration(job.durationMs)} | ${formatDuration(median)} | +${formatDuration(job.durationMs - median)} |`,
    ),
    "",
  ];
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
  const waits = snapshot.jobs.filter((job) => (job.queueMs ?? 0) >= 60_000);
  if (waits.length > 0) {
    const worst = waits.reduce((a, b) => ((a.queueMs ?? 0) >= (b.queueMs ?? 0) ? a : b));
    messages.push(
      `- **${waits.length} job(s) waited over a minute for a runner** (worst: ${worst.name}, ${formatDuration(worst.queueMs ?? 0)}${worst.labels ? ` on \`${worst.labels.join(", ")}\`` : ""}). Check runner pool capacity or move short jobs to a less contended label.`,
    );
  }
  if (snapshot.runAttempt === 1 && snapshot.queueMs !== null && snapshot.queueMs > 60_000) {
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
      baseline
        ? "- No strong timing anomaly was detected in the comparable evidence."
        : "- Timing comparisons are unavailable; no recovery or optimization benefit is inferred.",
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

export function formatDuration(milliseconds: number): string {
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

export function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
