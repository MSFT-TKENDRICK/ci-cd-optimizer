import { httpStatus, type GitHubClient, type RepoRef } from "../github/client.js";
import { mapLimit } from "../utils.js";
import { fetchJobLog, parseJobLog, type BuildInvocation, type BuildVertex, type JobLogEvidence, type LogStep } from "./logs.js";
import type { JobSnapshot, StepSnapshot, WorkflowSnapshot } from "./types.js";

/**
 * Attributes a run's time to recognisable causes found in job logs and step timings. Every saving is an upper bound
 * computed from observed durations — the most that removing that time could save — never a measured or predicted
 * speedup, and bounds of different findings overlap, so they must not be added up. Elapsed (wall-clock) bounds only
 * exist on the critical path and are capped by the headroom before another job would set the run's end; runner-time
 * bounds apply wherever the time was spent. Time no finding or step explains is reported as a coverage gap.
 */

const MIN_FINDING_MS = 3_000;
const MIN_TEST_RUNTIME_MS = 15_000;
const UNEXPLAINED_MIN_MS = 10_000;
const UNEXPLAINED_SHARE = 0.1;
const REPEATED_SETUP_MIN_JOBS = 3;
const REPEATED_SETUP_MIN_MS = 30_000;
const STEP_MATCH_MS = 3_000;
const DEFAULT_MAX_JOB_LOGS = 8;
const DEFAULT_LOG_CONCURRENCY = 4;
const MAX_LABEL = 80;
const MAX_EVIDENCE = 200;
const MAX_LISTED = 5;

const INFRA_STEP = /^(?:set up job|complete job|initialize containers|stop containers|post\b)/i;
const CHECKOUT_STEP = /\bactions\/checkout\b/i;
const SETUP_STEP = /\b(?:set\s*up|setup|install|restore|cache|dependenc|deps|bootstrap|toolchain|prepare)/i;
const INSTALL_COMMAND =
  /\b(?:npm\s+(?:ci|install|i)|pnpm\s+(?:install|i)|yarn\s+install|pip3?\s+install|poetry\s+install|bundle\s+install|composer\s+install|go\s+mod\s+download|dotnet\s+restore)\b/i;

export type BottleneckCategory =
  | "cache-export" | "image-load" | "layer-cache-miss" | "builder-setup" | "builder-teardown" | "package-cache"
  | "toolchain-download" | "repeated-command" | "service-startup" | "test-runtime" | "repeated-setup"
  | "generated-artifact-drift" | "queue-pressure" | "interrupted-transfer" | "layer-cache-unknown";

export interface Bottleneck {
  id: string;
  category: BottleneckCategory;
  jobKey: string;
  jobName: string;
  step?: string;
  /** Time observed for this cause in the run. */
  observedMs: number;
  /** Upper bound on wall-clock savings: 0 off the critical path, otherwise capped by the job's headroom. */
  elapsedSavingsBoundMs: number;
  /** Upper bound on runner-time savings if the removable part of the observed time disappeared. */
  runnerSavingsBoundMs: number;
  onCriticalPath: boolean;
  summary: string;
  recommendation: string;
  evidence: string[];
}

export type CoverageGapKind =
  | "log-unavailable" | "log-truncated" | "log-not-fetched" | "log-error" | "unexplained-time" | "no-step-data";

export interface CoverageGap {
  kind: CoverageGapKind;
  jobKey: string;
  jobName?: string;
  ms?: number;
  detail: string;
}

export interface AttributedJob {
  id: number;
  key: string;
  name: string;
  durationMs: number;
  /** How much later the job (with the jobs it gates) could have finished without moving the run's end. */
  slackMs: number;
  critical: boolean;
  /** Critical jobs only: how much the run's end can move before another job sets it. */
  headroomMs?: number;
  /** Critical jobs only: the job that would set the run's end once the headroom is used up. */
  limitedBy?: string;
}

export interface RunAttribution {
  elapsedMs: number;
  /** Slack threshold used for critical-path classification; exact criticality uses zero slack. */
  criticalSlackMs: number;
  jobs: AttributedJob[];
  bottlenecks: Bottleneck[];
  gaps: CoverageGap[];
  coverage: {
    jobs: number;
    jobsWithLogs: number;
    /** Job time covered by steps reported by the jobs API or the job log. */
    explainedMs: number;
    /** Total job (runner) time. */
    observedMs: number;
    unexplainedMs: number;
  };
}

/** A parsed job log, or the reason there is none. */
export type JobLogResult = JobLogEvidence | CoverageGap;

export interface JobLogOptions {
  maxJobLogs?: number;
  maxBytes?: number;
  maxLines?: number;
  concurrency?: number;
}

export function isCoverageGap(value: JobLogResult | undefined): value is CoverageGap {
  return value !== undefined && typeof (value as Partial<CoverageGap>).kind === "string"
    && typeof (value as Partial<CoverageGap>).detail === "string";
}

/** `22.5 s` below a minute, `2 min 5 s` above. */
export function formatMs(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

interface Timed {
  job: JobSnapshot;
  start: number;
  end: number;
}

interface JobTiming {
  slackMs: number;
  critical: boolean;
  headroomMs?: number;
  limitedBy?: Timed;
}

interface RunShape {
  elapsedMs: number;
  measured: Timed[];
  timing: Map<number, JobTiming>;
  criticalNames: string[];
}

function measure(job: JobSnapshot): Timed | undefined {
  if (job.conclusion === "skipped") return undefined;
  const start = Date.parse(job.startedAt);
  const end = Date.parse(job.completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { job, start, end } : undefined;
}

function latest(items: Iterable<Timed>): Timed | undefined {
  let best: Timed | undefined;
  for (const item of items) {
    if (!best || item.end > best.end || (item.end === best.end && item.job.id < best.job.id)) best = item;
  }
  return best;
}

/**
 * A job's slack counts the jobs it gates (those whose latest-ending `needs` dependency it is). Only a zero-slack
 * chain can reduce elapsed time; a critical job's headroom is how far the run's end can move before another job sets it.
 */
function analyzeRun(snapshot: WorkflowSnapshot): RunShape {
  const measured = snapshot.jobs.map(measure).filter((timed): timed is Timed => timed !== undefined);
  const runStart = measured.reduce((min, timed) => Math.min(min, timed.start), Infinity);
  const runEnd = measured.reduce((max, timed) => Math.max(max, timed.end), -Infinity);
  const elapsedMs = measured.length > 0 ? runEnd - runStart : 0;
  const byKey = new Map<string, Timed[]>();
  for (const timed of measured) byKey.set(timed.job.key, [...(byKey.get(timed.job.key) ?? []), timed]);
  const gated = new Map<Timed, Timed[]>();
  for (const timed of measured) {
    const parent = latest(timed.job.needs.flatMap((key) => byKey.get(key) ?? []).filter((other) => other !== timed));
    if (parent) gated.set(parent, [...(gated.get(parent) ?? []), timed]);
  }
  const timing = new Map<number, JobTiming>();
  for (const timed of measured) {
    const chain = new Set<Timed>([timed]);
    const queue = [timed];
    for (let index = 0; index < queue.length; index += 1) {
      for (const child of gated.get(queue[index] as Timed) ?? []) {
        if (!chain.has(child)) {
          chain.add(child);
          queue.push(child);
        }
      }
    }
    const slackMs = runEnd - (latest(chain)?.end ?? timed.end);
    if (slackMs > 0) {
      timing.set(timed.job.id, { slackMs, critical: false });
      continue;
    }
    const limitedBy = latest(measured.filter((other) => !chain.has(other)));
    timing.set(timed.job.id, {
      slackMs,
      critical: true,
      headroomMs: limitedBy ? Math.max(0, runEnd - limitedBy.end) : elapsedMs,
      ...(limitedBy ? { limitedBy } : {}),
    });
  }
  const criticalNames = measured.filter((timed) => timing.get(timed.job.id)?.critical)
    .sort((a, b) => b.end - a.end || a.job.id - b.job.id)
    .map((timed) => timed.job.name);
  return { elapsedMs, measured, timing, criticalNames };
}

interface LocatedStep {
  step: LogStep;
  label: string;
  /** Unique position, for example `3` or `1.0` for the first step of composite step 1. */
  path: string;
  top: LogStep;
  siblings: readonly LogStep[];
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function display(title: string): string {
  return clip(title.replace(/@([0-9a-f]{40})\b/gi, (_match, sha: string) => `@${sha.slice(0, 7)}`), MAX_LABEL);
}

function stepMs(step: StepSnapshot): [number, number] | undefined {
  const start = Date.parse(step.startedAt);
  const end = Date.parse(step.completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? [start, end] : undefined;
}

/**
 * The jobs API renumbers steps around composite actions and post steps and its timestamps have one-second resolution,
 * so log steps are matched to API steps in order by start time rather than by name.
 */
function locateSteps(evidence: JobLogEvidence, apiSteps: readonly StepSnapshot[] = []): LocatedStep[] {
  const candidates = apiSteps
    .filter((step) => step.conclusion !== "skipped" && !INFRA_STEP.test(step.name))
    .flatMap((step) => {
      const range = stepMs(step);
      return range ? [{ step, start: range[0] }] : [];
    })
    .sort((a, b) => a.step.number - b.step.number);
  const located: LocatedStep[] = [];
  let cursor = 0;
  for (const step of evidence.steps) {
    let best: number | undefined;
    let bestCost = Infinity;
    for (let index = cursor; index < candidates.length; index += 1) {
      const diff = step.startMs - (candidates[index]?.start ?? 0);
      if (Math.abs(diff) > STEP_MATCH_MS) continue;
      const cost = diff >= 0 && diff < 1000 ? diff : Math.abs(diff) + 1000;
      if (cost < bestCost) {
        best = index;
        bestCost = cost;
      }
    }
    if (best !== undefined) cursor = best + 1;
    const label = display(best !== undefined ? candidates[best]?.step.name ?? step.title : step.title);
    addLocated(located, step, label, String(located.filter((entry) => entry.step === entry.top).length), step, evidence.steps);
  }
  return located;
}

function addLocated(
  out: LocatedStep[], step: LogStep, label: string, path: string, top: LogStep, siblings: readonly LogStep[],
): void {
  out.push({ step, label, path, top, siblings });
  step.children.forEach((child, index) => {
    addLocated(out, child, clip(`${label} › ${display(child.title)}`, MAX_LABEL), `${path}.${index}`, top, step.children);
  });
}

interface JobContext {
  job: JobSnapshot;
  timing: JobTiming;
  shape: RunShape;
  evidence: JobLogEvidence;
  located: LocatedStep[];
  covered: Set<LogStep>;
}

interface Draft {
  category: BottleneckCategory;
  detail: string;
  step?: string;
  observedMs: number;
  /** Part of the observed time that removing the cause could save; defaults to all of it. */
  removableMs?: number;
  observation: string;
  recommendation: string;
  evidence: string[];
  covers?: LogStep[];
}

function boundSentence(shape: RunShape, jobName: string, timing: JobTiming, elapsedMs: number, runnerMs: number): string {
  if (runnerMs === 0) return "No time saving is bounded from this observation on its own.";
  if (timing.critical) {
    const capped = elapsedMs < runnerMs
      ? `; the elapsed bound is capped by ${formatMs(timing.headroomMs ?? 0)} of headroom before ${timing.limitedBy?.job.name ?? "another job"} would set the run's end`
      : "";
    return `Bound: removing this time could save up to ${formatMs(elapsedMs)} of elapsed time and up to ${formatMs(runnerMs)} of runner time${capped}.`;
  }
  const critical = shape.criticalNames.slice(0, 3).join(", ") || "another job";
  return `Bound: up to ${formatMs(runnerMs)} of runner time and no elapsed time, because ${jobName} has ${formatMs(timing.slackMs)} of slack behind ${critical}.`;
}

function finding(ctx: JobContext, draft: Draft): Bottleneck {
  const observedMs = Math.max(0, Math.round(draft.observedMs));
  const runnerSavingsBoundMs = Math.max(0, Math.round(draft.removableMs ?? observedMs));
  const elapsedSavingsBoundMs = ctx.timing.critical ? Math.min(runnerSavingsBoundMs, Math.round(ctx.timing.headroomMs ?? 0)) : 0;
  for (const step of draft.covers ?? []) ctx.covered.add(step);
  return {
    id: `${draft.category}:${ctx.job.id}:${draft.detail}`,
    category: draft.category,
    jobKey: ctx.job.key,
    jobName: ctx.job.name,
    ...(draft.step !== undefined ? { step: draft.step } : {}),
    observedMs,
    elapsedSavingsBoundMs,
    runnerSavingsBoundMs,
    onCriticalPath: ctx.timing.critical,
    summary: `${draft.observation} ${boundSentence(ctx.shape, ctx.job.name, ctx.timing, elapsedSavingsBoundMs, runnerSavingsBoundMs)}`,
    recommendation: draft.recommendation,
    evidence: draft.evidence.map((line) => clip(line, 1_200)),
  };
}

function vertexMs(vertex: BuildVertex): number {
  return vertex.durationMs ?? Math.max(0, vertex.lastMs - vertex.firstMs);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function unionMs(intervals: ReadonlyArray<readonly [number, number]>, clamp?: readonly [number, number]): number {
  const sorted = intervals
    .map(([start, end]) => clamp ? [Math.max(start, clamp[0]), Math.min(end, clamp[1])] as const : [start, end] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let current: [number, number] | undefined;
  for (const [start, end] of sorted) {
    if (current && start <= current[1]) current[1] = Math.max(current[1], end);
    else {
      if (current) total += current[1] - current[0];
      current = [start, end];
    }
  }
  return current ? total + current[1] - current[0] : total;
}

function describeVertex(vertex: BuildVertex): string {
  const operations = vertex.operations.length > 0
    ? ` (${vertex.operations.map((operation) => `${operation.name} ${formatMs(operation.durationMs)}`).join(", ")})`
    : "";
  return `#${vertex.id} ${clip(vertex.name, MAX_LABEL)}: ${formatMs(vertexMs(vertex))}${operations}`;
}

function vertexUnionMs(vertices: readonly BuildVertex[]): number {
  return unionMs(vertices.map((vertex) => [vertex.lastMs - vertexMs(vertex), vertex.lastMs] as const));
}

function buildFindings(ctx: JobContext, entry: LocatedStep, build: BuildInvocation, index: number): Bottleneck[] {
  const findings: Bottleneck[] = [];
  const detail = `s${entry.path}b${index}`;
  const covers = [entry.top];

  const stalled = ["failure", "cancelled", "timed_out"].includes(ctx.job.conclusion ?? "")
    ? build.vertices.flatMap((vertex) => (vertex.transfers ?? [])
      .filter((transfer) => transfer.unchangedMs >= UNEXPLAINED_MIN_MS)
      .map((transfer) => ({ vertex, transfer })))
    : [];
  const stalledMs = unionMs(stalled.map(({ transfer }) =>
    [transfer.lastMs - transfer.unchangedMs, transfer.lastMs] as const), [entry.step.startMs, entry.step.endMs]);
  if (stalledMs >= UNEXPLAINED_MIN_MS) {
    findings.push(finding(ctx, {
      category: "interrupted-transfer", detail, step: entry.label, observedMs: stalledMs, removableMs: 0,
      observation: `${entry.label}: the ${ctx.job.conclusion} job's retained BuildKit log contains ${stalled.length} layer transfer(s) without observed completion, with repeated unchanged reported progress over ${formatMs(stalledMs)} of non-overlapping observed time. A CACHED vertex does not imply its layers finished transferring. The log does not establish the backend cause or removable cost.`,
      recommendation: "Investigate the exact digest and transfer interval, cache/registry availability, network and BuildKit worker diagnostics before changing the Dockerfile or cache policy. Compare the same immutable build inputs after diagnosis. Preserve deadlines, retry limits, permissions, cache integrity, cleanup and downstream image assertions; do not treat a successful rerun as an erased failure or the stalled interval as guaranteed savings.",
      evidence: [
        ...stalled.slice(0, MAX_LISTED).map(({ vertex, transfer }) =>
          `#${vertex.id}${vertex.cached ? " CACHED" : ""} ${transfer.digest}: ${transfer.progress}; unchanged reports ${formatMs(transfer.unchangedMs)}; transfer counter ${(transfer.elapsedMs / 1000).toFixed(1)} s; completion not observed`),
        "Intervals stop at the last progress observation, not the job deadline; concurrent transfers are counted once.",
        ...(stalled.length > MAX_LISTED ? [`${stalled.length - MAX_LISTED} additional transfer details not listed; their intervals are included.`] : []),
      ],
      covers,
    }));
  }

  const exports = build.vertices.filter((vertex) => vertex.kind === "cache-export");
  const exportMs = vertexUnionMs(exports);
  if (exportMs >= MIN_FINDING_MS) {
    const modeMax = build.cacheTo.some((spec) => spec.mode === "max");
    const target = build.cacheTo.map((spec) => spec.raw).join("; ") || "the configured cache";
    findings.push(finding(ctx, {
      category: "cache-export",
      detail,
      step: entry.label,
      observedMs: exportMs,
      observation: `${entry.label}: BuildKit spent ${formatMs(exportMs)} exporting the build cache${modeMax ? " with mode=max, which exports the layers of every stage" : ""} (cache-to ${target}).`,
      recommendation: modeMax
        ? "Export the cache only where later runs reuse it (for example on default-branch runs; caches written by a pull request are only restored by that pull request), consider mode=min as a trade-off (intermediate stages are no longer cached; see the containers/gha-cache-mode-min lint rule) or a type=registry cache, and compare export time and layer cache hits before and after."
        : "Export the cache only where later runs reuse it (for example on default-branch runs), or use a type=registry cache, and compare export time and layer cache hits before and after.",
      evidence: [...exports.map(describeVertex), ...build.cacheTo.map((spec) => `cache-to: ${spec.raw}`)],
      covers,
    }));
  }

  if (build.load) {
    const loads = build.vertices.filter((vertex) => vertex.kind === "image-export" || vertex.kind === "image-load");
    const loadMs = vertexUnionMs(loads);
    const incomplete = loads.some((vertex) => vertex.durationMs === undefined);
    if (loadMs >= MIN_FINDING_MS) {
      findings.push(finding(ctx, {
        category: "image-load",
        detail,
        step: entry.label,
        observedMs: loadMs,
        ...(incomplete ? { removableMs: 0 } : {}),
        observation: incomplete
          ? `${entry.label}: the retained log spans ${formatMs(loadMs)} of image export/load output (load: true), but completion was not observed for every vertex. This is not the completed phase duration.`
          : `${entry.label}: exporting the image and loading it into the runner's Docker engine (load: true) took ${formatMs(loadMs)}.`,
        recommendation: "Keep load: true only when later steps run the image locally; otherwise drop it (or push instead). When local use is required, the docker driver builds straight into the engine but supports different cache backends, so measure both before switching.",
        evidence: [...loads.map(describeVertex), "load: true"],
        covers,
      }));
    }
  }

  for (const executionOutput of [true, false]) {
    const vertices = build.vertices.filter((vertex) => vertex.kind === "run" && !vertex.cached && !vertex.error
      && (vertex.executionOutput === true) === executionOutput);
    const observedMs = vertexUnionMs(vertices);
    if (build.cacheFrom.length > 0 && observedMs >= MIN_FINDING_MS) {
      const restored = build.vertices.filter((vertex) => (vertex.kind === "run" || vertex.kind === "copy") && vertex.cached).length;
      const source = build.cacheFrom.map((spec) => spec.raw).join("; ");
      const access = build.cacheFrom.some((spec) => spec.type === "gha") ? entry.step.cacheAccess : undefined;
      const cause = restored === 0
        ? "No RUN or COPY vertex was marked CACHED; this alone does not distinguish changed inputs from missing or inaccessible cache entries."
        : `${restored} other RUN or COPY vertex/vertices were marked CACHED, but that does not prove that matching entries for these vertices were published or accessible.`;
      findings.push(finding(ctx, {
        category: executionOutput ? "layer-cache-miss" : "layer-cache-unknown",
        detail,
        step: entry.label,
        observedMs,
        ...(!executionOutput ? { removableMs: 0 } : {}),
        observation: executionOutput
          ? `${entry.label}: ${vertices.length} RUN vertex/vertices produced timed command output without a CACHED marker, spanning ${formatMs(observedMs)} of vertex time despite cache-from ${source}. Vertex time can include materialization, not just command execution. ${cause} The log alone does not establish the cause.`
          : `${entry.label}: ${vertices.length} RUN vertex/vertices span ${formatMs(observedMs)} without a CACHED marker or timed command output (cache-from ${source}). They may be materializing cached layers or executing silently; the retained log does not establish a rebuild or removable cost. ${cause}`,
        recommendation: [
          ...(!executionOutput ? ["Inspect the build record's cache status and execution trace before treating these vertices as misses. Missing output is not proof of either a cache hit or a rebuild, and layer-transfer output alone is not command execution. Do not expose credentials or signed URLs from build records."] : []),
          "Compare consecutive runs with identical build inputs, including resolved base-image digests, build arguments and context contents, not just the same commit. Check successful cache publication, matching import/export scopes, branch visibility and eviction.",
          ...(access?.entries.length ? ["Use the action's logged runtime cache access as branch-permission evidence only: it does not prove publication, a matching entry or successful restoration. Missing or omitted entries do not prove denied access. Do not broaden permissions merely because a layer missed."] : []),
          "If misses persist, investigate cache lookup and backend behavior before restructuring the Dockerfile or changing permissions.",
        ].join(" "),
        evidence: [
          ...(access?.entries.length ? [
            `Action-reported runtime cache access: ${access.entries.map((entry) => `${entry.scope}: ${entry.permission}`).join("; ")}${access.omittedEntries ? `; ${access.omittedEntries} additional recognized access line(s) not retained` : ""}`,
          ] : []),
          ...[...vertices].sort((a, b) => vertexMs(b) - vertexMs(a) || a.id - b.id).slice(0, MAX_LISTED).map(describeVertex),
          ...build.vertices.filter((vertex) => vertex.kind === "cache-import").map(describeVertex),
          ...build.cacheFrom.map((spec) => `cache-from: ${spec.raw}`),
        ],
        covers,
      }));
    }
  }
  return findings;
}

function cacheSaveFailure(evidence: JobLogEvidence) {
  const failures = evidence.post.cacheSaveFailures;
  if (failures.length === 0) return undefined;
  const conflicts = failures.filter((failure) => /^Unable to reserve cache with key\b/i.test(failure));
  return {
    observation: [
      "The post-job cache save failed.",
      conflicts.length > 0
        ? "The log reports a cache-key reservation conflict, indicating a possible cache-save race."
        : "The cause is not classified; inspect the logged error.",
      ...(conflicts.length > 0 && conflicts.length < failures.length ? ["Other save failures also occurred; their causes are not classified."] : []),
    ].join(" "),
    recommendation: conflicts.length > 0
      ? "Check for shared-key contention; if confirmed, have one job (or a default-branch run) save the cache and let parallel jobs only restore it. Investigate any other save errors separately."
      : "Investigate the cache service and the logged save error before changing cache keys or job structure.",
    evidence: failures.map((failure) => `post-job cache save: ${failure}`),
  };
}

function stepFindings(ctx: JobContext, entry: LocatedStep): Bottleneck[] {
  const { step, label } = entry;
  const findings: Bottleneck[] = [];
  step.builds.forEach((build, index) => findings.push(...buildFindings(ctx, entry, build, index)));

  const pulling = step.subGroups.filter((group) => /^Pulling BuildKit image/i.test(group.title));
  const booting = step.subGroups.filter((group) => /^Booting builder/i.test(group.title));
  const parts = [...pulling, ...booting].map((group) => `${clip(group.title, MAX_LABEL)}: ${formatMs(group.durationMs)}`);
  let builderMs = unionMs([...pulling, ...booting].map((group) => [group.startMs, group.endMs] as const));
  if (parts.length === 0) {
    const boots = step.builds.flatMap((build) => build.vertices.filter((vertex) => vertex.kind === "builder-boot"));
    builderMs = vertexUnionMs(boots);
    parts.push(...boots.map(describeVertex));
  }
  if (builderMs >= MIN_FINDING_MS) {
    findings.push(finding(ctx, {
      category: "builder-setup",
      detail: `s${entry.path}`,
      step: label,
      observedMs: builderMs,
      observation: `${label}: setting up the BuildKit builder (pulling its image and booting it) took ${formatMs(builderMs)}.`,
      recommendation: "This is a fixed cost of a docker-container builder on a fresh runner. It matters only when the build itself is short; the docker driver needs no builder container where its features suffice, and a persistent runner can reuse a builder.",
      evidence: parts,
      covers: [entry.top],
    }));
  }

  if (step.toolCache === "download" && step.durationMs >= MIN_FINDING_MS) {
    const release = step.toolSource === "release";
    findings.push(finding(ctx, {
      category: "toolchain-download",
      detail: `s${entry.path}`,
      step: label,
      observedMs: step.durationMs,
      observation: release
        ? `${label} downloaded and unpacked a pinned release archive with no reused install (${formatMs(step.durationMs)}).`
        : `${label} downloaded its toolchain instead of finding it in the runner's tool cache (${formatMs(step.durationMs)}).`,
      recommendation: release
        ? "Cache the extracted toolchain directory keyed by its version pin or lock file plus runner OS and architecture, and keep integrity verification before reusing it; a cache restore also takes time, so measure before and after."
        : "Use a version the hosted runner image already caches, or cache the toolchain directory; a cache restore also takes time, so measure before and after.",
      evidence: [release
        ? `${label}: release archive download with no reused install, ${formatMs(step.durationMs)}`
        : `${label}: tool cache miss, ${formatMs(step.durationMs)}`],
      covers: [entry.top],
    }));
  }

  if (step.packageCache === "miss") {
    const position = entry.siblings.indexOf(step);
    const install = entry.siblings.slice(position + 1).find((sibling) => INSTALL_COMMAND.test(sibling.command ?? sibling.title));
    const installed = install?.installedPackages !== undefined ? ` ${install.installedPackages} packages` : "";
    const firstMiss = ctx.located.find((other) => other.step.packageCache === "miss");
    const failure = firstMiss === entry ? cacheSaveFailure(ctx.evidence) : undefined;
    const save = failure ? ` ${failure.observation}` : "";
    findings.push(finding(ctx, {
      category: "package-cache",
      detail: `s${entry.path}`,
      step: label,
      observedMs: install?.durationMs ?? 0,
      observation: install
        ? `${label}: the dependency cache missed, so ${clip(install.command ?? install.title, MAX_LABEL)} installed${installed} from the network in ${formatMs(install.durationMs)}.${save}`
        : `${label}: the dependency cache missed.${save}`,
      recommendation: [
        failure?.recommendation ?? "Check whether a matching cache was saved and remains available; compare restore keys and cache scope across runs.",
        "A warm cache only shortens the download part of an install, not the install itself.",
      ].join(" "),
      evidence: [
        `${label}: package cache miss (${formatMs(step.durationMs)})`,
        ...(install ? [`${clip(install.command ?? install.title, MAX_LABEL)}: ${formatMs(install.durationMs)}${installed ? `,${installed}` : ""}`] : []),
        ...(failure?.evidence ?? []),
      ],
      covers: [entry.top],
    }));
  }

  if (step.packageCache === "hit") {
    const install = entry.siblings[entry.siblings.indexOf(step) + 1];
    const rawCommand = install?.kind === "script" ? install.command : undefined;
    if (install && rawCommand !== undefined && INSTALL_COMMAND.exec(rawCommand.trim())?.index === 0
      && !/[\r\n;&|`$<>\u2026]/.test(rawCommand) && install.durationMs >= MIN_FINDING_MS) {
      const command = clip(rawCommand, MAX_LABEL);
      findings.push(finding(ctx, {
        category: "package-cache",
        detail: `s${entry.path}`,
        step: label,
        observedMs: install.durationMs,
        observation: `${label}: the dependency cache hit, but the following ${command} still spent ${formatMs(install.durationMs)} installing dependencies. The setup/cache step separately took ${formatMs(step.durationMs)}.`,
        recommendation: "A download-cache hit does not eliminate installation and does not prove that no network access occurred. Profile restoration, extraction and lifecycle scripts separately before adding another cache. Compare prepared dependencies only with matching lockfile, toolchain and OS; preserve integrity checks, lifecycle scripts and isolation, and include transfer costs and total runner work.",
        evidence: [
          `${display(step.title)}: setup/cache step ${formatMs(step.durationMs)}`,
          `${command}: installation ${formatMs(install.durationMs)}`,
        ],
        covers: [step, install],
      }));
    }
  }

  if (step.tests.length > 0 && step.durationMs >= MIN_TEST_RUNTIME_MS) {
    const frameworks = step.tests.map((summary) => {
      const counts = [
        summary.tests !== undefined ? `${summary.tests} tests` : undefined,
        summary.files !== undefined ? `${summary.files} files` : undefined,
        summary.durationMs !== undefined ? formatMs(summary.durationMs) : undefined,
      ].filter((part): part is string => part !== undefined);
      return `${summary.framework}${counts.length > 0 ? `: ${counts.join(", ")}` : ""}`;
    });
    const phaseLines = step.tests
      .filter((summary) => Object.keys(summary.phases).length > 0)
      .map((summary) => `${summary.framework} phase shares: ${Object.entries(summary.phases)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([phase, share]) => `${phase} ${share}%`).join(", ")}`);
    const hotspotLines = step.tests.filter((summary) => summary.framework === "vitest")
      .flatMap((summary, index) => summary.slowFiles?.length
        ? [`vitest invocation ${index + 1} slowest reported files (durations may overlap): ${summary.slowFiles
          .map((file) => `${file.label}: ${formatMs(file.durationMs)}`).join("; ")}`]
        : []);
    const importShare = Math.max(0, ...step.tests.map((summary) => summary.phases.import ?? 0));
    const spareJobs = ctx.timing.critical && ctx.job.needs.length === 0
      ? ctx.shape.measured.filter(({ job }) => job.id !== ctx.job.id && job.needs.length === 0
        && (ctx.shape.timing.get(job.id)?.slackMs ?? 0) >= MIN_TEST_RUNTIME_MS)
        .sort((a, b) => (ctx.shape.timing.get(b.job.id)?.slackMs ?? 0) - (ctx.shape.timing.get(a.job.id)?.slackMs ?? 0))
        .slice(0, MAX_LISTED)
      : [];
    const spareEvidence = spareJobs.length ? [
      `Observed spare-job slack (workload compatibility is unverified): ${spareJobs.map(({ job }) =>
        `${clip(job.name, MAX_LABEL)}: ${formatMs(ctx.shape.timing.get(job.id)?.slackMs ?? 0)}`).join("; ")}`,
    ] : [];
    findings.push(finding(ctx, {
      category: "test-runtime",
      detail: `s${entry.path}`,
      step: label,
      observedMs: step.durationMs,
      observation: `${label} ran tests for ${formatMs(step.durationMs)} (${frameworks.join("; ")}).`,
      recommendation: [
        ...(hotspotLines.length ? ["Profile the reported file hotspots before repartitioning; their durations can overlap and are not additive savings. Separate fixture setup, test bodies and teardown; trace idle connection waits before changing shutdown. File timings alone do not identify their cause. Preserve assertions, isolation, active-request draining and intentional timeout/polling coverage."] : []),
        ...(ctx.timing.critical ? [
          ...(spareJobs.length > 0 ? [
            `Before adding runners, measure moving an independent test partition into an already-prepared compatible job with slack (${spareJobs.map(({ job }) => clip(job.name, MAX_LABEL)).join(", ")}). Verify matching runtime/dependencies, isolation, acyclic dependencies and identical coverage on every trigger, including drafts and failure paths; the observed slack does not prove compatibility or future capacity.`,
          ] : []),
          "If existing capacity cannot be reused, measure test sharding; include repeated setup and total runner work, not only the test job's duration.",
          ...((ctx.timing.headroomMs ?? 0) === 0 ? ["Another job currently finishes at the same time; shortening this job alone has no elapsed-time bound, so evaluate both critical workloads together."] : []),
        ] : [
          "Do not add shards solely to shorten this off-critical job: that can increase runner work without reducing elapsed time. Profile slow tests and setup while preserving assertions and isolation.",
        ]),
        ...(importShare >= 20 ? [`Imports take ${importShare}% of the test time, so trimming heavy imports from the module graph would cut work in every shard.`] : []),
        ...(!ctx.timing.critical ? ["This job is off the critical path, so it only shortens the run once the critical path is reduced."] : []),
      ].join(" "),
      evidence: [...frameworks, ...phaseLines, ...hotspotLines, ...spareEvidence],
      covers: [entry.top],
    }));
  }
  return findings;
}

function jobFindings(ctx: JobContext): Bottleneck[] {
  const { evidence, located } = ctx;
  const findings = located.flatMap((entry) => stepFindings(ctx, entry));
  if (ctx.job.conclusion === "failure" && evidence.generatedArtifactFailures?.length) {
    findings.push(finding(ctx, {
      category: "generated-artifact-drift",
      detail: "parity",
      observedMs: ctx.job.durationMs,
      removableMs: 0,
      observation: `Generated output parity failed (${evidence.generatedArtifactFailures.map((failure) => failure.artifact).join(", ")}). This job consumed ${formatMs(ctx.job.durationMs)} in a failed attempt; that is rework exposure, not proven removable work.`,
      recommendation: "Run deterministic generated-output preparation and parity checks before pushing, in dependency order (proof provenance before bundles). Keep the CI parity gates; commit the generated outputs together with their sources rather than weakening verification.",
      evidence: evidence.generatedArtifactFailures.map((failure) => failure.evidence),
    }));
  }

  const saveFailure = cacheSaveFailure(evidence);
  if (saveFailure && !located.some((entry) => entry.step.packageCache === "miss")) {
    findings.push(finding(ctx, {
      category: "package-cache",
      detail: "save",
      step: "Post-job steps",
      observedMs: 0,
      ...saveFailure,
    }));
  }

  const removing = evidence.post.subGroups.filter((group) => /^Removing builder/i.test(group.title));
  const records = evidence.post.subGroups.filter((group) => /build (?:summary|record)/i.test(group.title));
  const teardownMs = sum([...removing, ...records].map((group) => group.durationMs));
  if (teardownMs >= MIN_FINDING_MS) {
    findings.push(finding(ctx, {
      category: "builder-teardown",
      detail: "post",
      step: "Post-job steps",
      observedMs: teardownMs,
      observation: `Post-job steps spent ${formatMs(teardownMs)} removing the BuildKit builder and generating the build summary or record.`,
      recommendation: [
        ...(removing.length > 0 ? ["On ephemeral hosted runners the builder disappears with the VM, so cleanup: false on docker/setup-buildx-action skips removing it."] : []),
        ...(records.length > 0 ? ["If the build summary and record artifact are not used, set DOCKER_BUILD_SUMMARY: false and DOCKER_BUILD_RECORD_UPLOAD: false on the build step."] : []),
      ].join(" "),
      evidence: [...removing, ...records].map((group) => `${clip(group.title, MAX_LABEL)}: ${formatMs(group.durationMs)}`),
    }));
  }

  for (const repeated of evidence.repeatedCommands) {
    const entries = repeated.steps.map((index) => located.find((entry) => entry.step === evidence.steps[index]));
    const total = sum(repeated.durationsMs);
    const removable = total - Math.max(0, ...repeated.durationsMs);
    if (removable < MIN_FINDING_MS) continue;
    const labels = entries.map((entry, position) => entry?.label ?? `step ${(repeated.steps[position] ?? 0) + 1}`);
    const envSets = entries.map((entry) => [...(entry?.step.envKeys ?? [])].sort().join(","));
    const differ = new Set(envSets).size > 1;
    findings.push(finding(ctx, {
      category: "repeated-command",
      detail: repeated.steps.join("-"),
      step: clip(labels.join(" + "), MAX_LABEL),
      observedMs: total,
      removableMs: removable,
      observation: `The same command (${clip(repeated.command, MAX_LABEL)}) ran in ${repeated.steps.length} sequential steps for ${formatMs(total)} in total${differ ? "; the steps set different environment variables, so they likely exercise different configurations" : ""}. Running them side by side could save at most the time of all but the longest run (${formatMs(removable)}).`,
      recommendation: "If the runs are independent, start them concurrently (for example in the background within one step, or as separate jobs), or cover every configuration in a single invocation.",
      evidence: entries.map((entry, position) => {
        const env = entry && entry.step.envKeys.length > 0 ? ` (env: ${[...entry.step.envKeys].sort().join(", ")})` : "";
        return `${labels[position]}: ${formatMs(repeated.durationsMs[position] ?? 0)}${env}`;
      }),
      covers: entries.flatMap((entry) => entry ? [entry.top] : []),
    }));
  }

  for (const service of evidence.setup.services) {
    const startupMs = (service.pullMs ?? 0) + (service.healthWaitMs ?? 0);
    if (startupMs < MIN_FINDING_MS) continue;
    const parts = [
      ...(service.pullMs !== undefined ? [`image pull ${formatMs(service.pullMs)}`] : []),
      ...(service.healthWaitMs !== undefined ? [`health checks ${formatMs(service.healthWaitMs)} over ${service.polls} poll(s)`] : []),
    ];
    findings.push(finding(ctx, {
      category: "service-startup",
      detail: clip(service.name, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      step: "Initialize containers",
      observedMs: startupMs,
      observation: `Starting service container ${clip(service.name, MAX_LABEL)}${service.image ? ` (${clip(service.image, MAX_LABEL)})` : ""} took ${formatMs(startupMs)} before the first step could run (${parts.join(", ")}).`,
      recommendation: "Use the service only in jobs that need it. Measure a compatible smaller image or overlap the entire pull/create/start command with independent work using a bounded background worker: docker run --detach still waits for the image pull. Preserve the health policy and gate every consumer on readiness. Join startup before cleanup; always attempt container and anonymous-volume removal, including failed startups, and propagate startup and cleanup errors. Compare whole-run latency and total runner work before accepting a change.",
      evidence: [`${clip(service.name, MAX_LABEL)}${service.image ? ` ${clip(service.image, MAX_LABEL)}` : ""}: ${parts.join(", ")}`],
    }));
  }
  return findings;
}

interface SetupUse {
  timed: Timed;
  ms: number;
  label: string;
}

function normalizeSetup(name: string): string {
  return name.replace(/^Run\s+/i, "").replace(/@\S+/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function setupSteps(timed: Timed, evidence: JobLogEvidence | undefined): { name: string; ms: number }[] {
  const apiSteps = (timed.job.steps ?? []).filter((step) => step.conclusion !== "skipped");
  const steps = apiSteps.length > 0
    ? apiSteps.map((step) => ({ name: step.name, ms: step.durationMs }))
    : (evidence?.steps ?? []).map((step) => ({ name: step.title, ms: step.durationMs }));
  return steps.filter((step) => !INFRA_STEP.test(step.name) && !CHECKOUT_STEP.test(step.name)
    && (SETUP_STEP.test(step.name) || INSTALL_COMMAND.test(step.name)));
}

function repeatedSetup(shape: RunShape, evidenceById: Map<number, JobLogEvidence>): Bottleneck[] {
  const groups = new Map<string, Map<Timed, SetupUse>>();
  for (const timed of shape.measured) {
    for (const step of setupSteps(timed, evidenceById.get(timed.job.id))) {
      const key = normalizeSetup(step.name);
      if (!key) continue;
      const uses = groups.get(key) ?? new Map<Timed, SetupUse>();
      const use = uses.get(timed) ?? { timed, ms: 0, label: display(step.name) };
      use.ms += Math.max(0, step.ms);
      uses.set(timed, use);
      groups.set(key, uses);
    }
  }
  const findings: Bottleneck[] = [];
  for (const [key, uses] of groups) {
    const list = [...uses.values()].sort((a, b) => b.ms - a.ms || a.timed.job.id - b.timed.job.id);
    const total = sum(list.map((use) => use.ms));
    const longest = list[0]?.ms ?? 0;
    const removable = total - longest;
    if (list.length < REPEATED_SETUP_MIN_JOBS || total < REPEATED_SETUP_MIN_MS || removable < MIN_FINDING_MS) continue;
    const critical = list.filter((use) => shape.timing.get(use.timed.job.id)?.critical);
    const elapsed = Math.round(Math.min(removable, Math.max(0, ...critical.map((use) =>
      Math.min(use.ms, shape.timing.get(use.timed.job.id)?.headroomMs ?? 0)))));
    const runner = Math.round(removable);
    const names = list.map((use) => use.timed.job.name);
    const listed = names.length > MAX_LISTED ? `${names.slice(0, MAX_LISTED).join(", ")} and ${names.length - MAX_LISTED} more` : names.join(", ");
    const label = list[0]?.label ?? key;
    const cacheHits = list.filter((use) => {
      const log = evidenceById.get(use.timed.job.id);
      const hit = (step: LogStep): boolean => step.packageCache === "hit" || step.children.some(hit);
      return log?.steps.some(hit);
    }).length;
    const bound = critical.length > 0
      ? `Bound: up to ${formatMs(elapsed)} of elapsed time (removing it from the critical job) and up to ${formatMs(runner)} of runner time (every instance but the longest).`
      : `Bound: up to ${formatMs(runner)} of runner time (every instance but the longest) and no elapsed time, because none of these jobs is on the critical path.`;
    findings.push({
      id: `repeated-setup:${key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "step"}`,
      category: "repeated-setup",
      jobKey: clip([...new Set(list.map((use) => use.timed.job.key))].sort().join(", "), MAX_EVIDENCE),
      jobName: clip(listed, MAX_EVIDENCE),
      step: label,
      observedMs: Math.round(total),
      elapsedSavingsBoundMs: elapsed,
      runnerSavingsBoundMs: runner,
      onCriticalPath: critical.length > 0,
      summary: `${list.length} jobs each ran ${label} (${formatMs(total)} in total, longest ${formatMs(longest)}). ${bound}`,
      recommendation: cacheHits > 0
        ? `${cacheHits}/${list.length} jobs already show a dependency cache hit. Measure download-cache restoration separately from dependency installation, extraction and lifecycle scripts before adding another cache. Compare a lockfile/toolchain/OS-keyed prepared dependency image or shared preparation artifact including its upload/download cost; merge jobs only when slack and isolation permit.`
        : "Cache what this setup produces (dependencies, toolchains) so each repeat is shorter, or merge short jobs that share it; merging parallel jobs can lengthen the run, so only merge jobs that have slack.",
      evidence: list.slice(0, MAX_LISTED * 2).map((use) => `${clip(use.timed.job.name, MAX_LABEL)}: ${formatMs(use.ms)}`),
    });
  }
  return findings;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Job creation can precede `needs`; do not label dependency waiting as runner contention. */
export function readyQueueMs(job: JobSnapshot, jobs: readonly JobSnapshot[]): number | undefined {
  const start = Date.parse(job.startedAt);
  const queued = job.queuedAt ? Date.parse(job.queuedAt) : start - (job.queueMs ?? NaN);
  if (!Number.isFinite(start) || !Number.isFinite(queued) || queued > start) return undefined;
  const parents = job.needs.flatMap((key) => jobs.filter((candidate) => candidate.key === key));
  if (job.needs.some((key) => !parents.some((parent) => parent.key === key))) return undefined;
  const ends = parents.map((parent) => Date.parse(parent.completedAt));
  if (ends.some((end) => !Number.isFinite(end) || end > start)) return undefined;
  return Math.max(0, start - Math.max(queued, ...ends));
}

function queueFindings(snapshot: WorkflowSnapshot, shape: RunShape): Bottleneck[] {
  return shape.measured.flatMap(({ job }) => {
    const wait = readyQueueMs(job, snapshot.jobs);
    if (wait === undefined || wait < 10_000 || wait < 0.2 * (wait + job.durationMs)) return [];
    return [{
      id: `queue-pressure:${job.id}`,
      category: "queue-pressure" as const,
      jobKey: job.key, jobName: job.name, observedMs: wait,
      elapsedSavingsBoundMs: 0, runnerSavingsBoundMs: 0,
      onCriticalPath: shape.timing.get(job.id)?.critical ?? false,
      summary: `${job.name} waited ${formatMs(wait)} after its recorded queue entry and dependencies completed, then executed for ${formatMs(job.durationMs)}. This wait is not runner work or a measured code speedup.`,
      recommendation: "Report queue-inclusive latency and job execution separately. Use interleaved, matched control/arm trials with the same runner context; do not rank a code change from a queue-heavy cohort or discard slow samples after seeing the outcome. Investigate capacity and concurrency independently.",
      evidence: [`Ready-to-start wait: ${formatMs(wait)}; job execution: ${formatMs(job.durationMs)}.`],
    }];
  });
}

/** Attributes a run's time to bottlenecks; pure and deterministic for the same snapshot and logs. */
export function attributeRun(snapshot: WorkflowSnapshot, logs: ReadonlyMap<number | string, JobLogResult> = new Map()): RunAttribution {
  const shape = analyzeRun(snapshot);
  const bottlenecks: Bottleneck[] = [];
  const gaps: CoverageGap[] = [];
  const evidenceById = new Map<number, JobLogEvidence>();
  let jobsWithLogs = 0;
  let explainedMs = 0;
  let observedMs = 0;

  for (const timed of shape.measured) {
    const { job } = timed;
    const durationMs = timed.end - timed.start;
    const timing = shape.timing.get(job.id) ?? { slackMs: 0, critical: false };
    const result = logs.get(job.id) ?? logs.get(job.key);
    const apiSteps = (job.steps ?? []).filter((step) => step.conclusion !== "skipped");
    let evidence: JobLogEvidence | undefined;
    let logGap: CoverageGap | undefined;
    if (result === undefined) {
      logGap = {
        kind: "log-not-fetched", jobKey: job.key, jobName: job.name, ms: durationMs,
        detail: "The job log was not fetched, so log-based causes (build, cache, test and service evidence) were not examined.",
      };
    } else if (isCoverageGap(result)) {
      logGap = { ...result, jobKey: job.key, jobName: job.name, ms: result.ms ?? durationMs };
    } else {
      evidence = result;
      jobsWithLogs += 1;
      evidenceById.set(job.id, evidence);
      if (evidence.truncated) {
        gaps.push({
          kind: "log-truncated", jobKey: job.key, jobName: job.name,
          detail: `Only the first ${evidence.lines} log lines fit the size budget, so causes in later steps may be missing.`,
        });
      }
    }

    const located = evidence ? locateSteps(evidence, apiSteps) : [];
    const covered = new Set<LogStep>();
    if (evidence) bottlenecks.push(...jobFindings({ job, timing, shape, evidence, located, covered }));

    const intervals: Array<readonly [number, number]> = apiSteps.flatMap((step) => {
      const range = stepMs(step);
      return range ? [range] : [];
    });
    if (evidence) {
      if (evidence.firstMs !== undefined) intervals.push([evidence.firstMs, evidence.firstMs + evidence.setup.durationMs]);
      for (const step of evidence.steps) intervals.push([step.startMs, step.endMs]);
      if (evidence.post.startMs !== undefined) intervals.push([evidence.post.startMs, evidence.post.startMs + evidence.post.durationMs]);
    }
    const explained = Math.min(durationMs, unionMs(intervals, [timed.start, timed.end]));
    observedMs += durationMs;
    explainedMs += explained;
    const threshold = Math.max(UNEXPLAINED_MIN_MS, UNEXPLAINED_SHARE * durationMs);
    const hasSteps = apiSteps.length > 0 || (evidence?.steps.length ?? 0) > 0;
    if (logGap) {
      // One gap per job: a missing log already covers a job that has no step data either.
      if (!hasSteps) logGap.detail += " The jobs API reported no steps either, so none of this job's time can be attributed.";
      gaps.push(logGap);
    }
    if (!hasSteps) {
      if (!logGap) {
        gaps.push({
          kind: "no-step-data", jobKey: job.key, jobName: job.name, ms: durationMs,
          detail: "Neither the jobs API nor the job log reported steps, so none of this job's time can be attributed.",
        });
      }
    } else if (durationMs - explained >= threshold) {
      gaps.push({
        kind: "unexplained-time", jobKey: job.key, jobName: job.name, ms: Math.round(durationMs - explained),
        detail: `${formatMs(durationMs - explained)} of the job's ${formatMs(durationMs)} is not covered by any step in the jobs API or the job log.`,
      });
    }
    if (evidence && timing.critical) {
      for (const entry of located) {
        if (entry.step !== entry.top || covered.has(entry.step) || entry.step.durationMs < threshold) continue;
        const recognized = unionMs(located.filter((other) => other.top === entry.top && covered.has(other.step))
          .map(({ step }) => [step.startMs, step.endMs] as const), [entry.step.startMs, entry.step.endMs]);
        const unknown = Math.max(0, entry.step.durationMs - recognized);
        if (unknown < threshold) continue;
        gaps.push({
          kind: "unexplained-time", jobKey: job.key, jobName: job.name, ms: Math.round(unknown),
          detail: recognized > 0
            ? `${formatMs(unknown)} of ${entry.label} (${formatMs(entry.step.durationMs)} total) on the critical path is not explained by recognised bottleneck patterns.`
            : `${entry.label} took ${formatMs(entry.step.durationMs)} on the critical path and no recognised bottleneck pattern explains it.`,
        });
      }
    }
  }

  bottlenecks.push(...repeatedSetup(shape, evidenceById), ...queueFindings(snapshot, shape));
  const priority = (finding: Bottleneck) => finding.category === "interrupted-transfer" ? 3
    : finding.category === "generated-artifact-drift" ? 2 : finding.category === "queue-pressure" ? 1 : 0;
  bottlenecks.sort((a, b) => priority(b) - priority(a) || b.elapsedSavingsBoundMs - a.elapsedSavingsBoundMs
    || b.runnerSavingsBoundMs - a.runnerSavingsBoundMs || compareText(a.id, b.id));
  gaps.sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0) || compareText(a.kind, b.kind) || compareText(a.jobKey, b.jobKey)
    || compareText(a.detail, b.detail));

  const jobs: AttributedJob[] = shape.measured.map((timed) => {
    const timing = shape.timing.get(timed.job.id) ?? { slackMs: 0, critical: false };
    return {
      id: timed.job.id,
      key: timed.job.key,
      name: timed.job.name,
      durationMs: timed.end - timed.start,
      slackMs: timing.slackMs,
      critical: timing.critical,
      ...(timing.headroomMs !== undefined ? { headroomMs: timing.headroomMs } : {}),
      ...(timing.limitedBy ? { limitedBy: timing.limitedBy.job.name } : {}),
    };
  }).sort((a, b) => Number(b.critical) - Number(a.critical) || a.slackMs - b.slackMs || b.durationMs - a.durationMs || a.id - b.id);

  return {
    elapsedMs: shape.elapsedMs,
    criticalSlackMs: 0,
    jobs,
    bottlenecks,
    gaps,
    coverage: {
      jobs: shape.measured.length,
      jobsWithLogs,
      explainedMs: Math.round(explainedMs),
      observedMs: Math.round(observedMs),
      unexplainedMs: Math.round(observedMs - explainedMs),
    },
  };
}

function failureReason(error: unknown): string {
  const status = httpStatus(error);
  if (status !== undefined) return `HTTP ${status}`;
  return clip(error instanceof Error ? error.message : String(error), 120) || "unknown error";
}

/**
 * Fetches and parses a bounded number of job logs, failed jobs then critical and longest jobs first. A failure for one job becomes a
 * coverage gap for that job; it never aborts the others.
 */
export async function collectJobLogs(
  client: GitHubClient, repo: RepoRef, snapshot: WorkflowSnapshot, options: JobLogOptions = {},
): Promise<Map<number, JobLogResult>> {
  const shape = analyzeRun(snapshot);
  const budget = Math.max(0, Math.floor(options.maxJobLogs ?? DEFAULT_MAX_JOB_LOGS));
  const ordered = [...shape.measured].sort((a, b) =>
    Number(b.job.conclusion === "failure") - Number(a.job.conclusion === "failure")
    || Number(shape.timing.get(b.job.id)?.critical ?? false) - Number(shape.timing.get(a.job.id)?.critical ?? false)
    || (b.end - b.start) - (a.end - a.start) || a.job.id - b.job.id);
  const selected = ordered.slice(0, budget);
  const limits = {
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    ...(options.maxLines !== undefined ? { maxLines: options.maxLines } : {}),
  };
  const fetched = await mapLimit(selected, Math.max(1, options.concurrency ?? DEFAULT_LOG_CONCURRENCY), async (timed): Promise<JobLogResult> => {
    const base = { jobKey: timed.job.key, jobName: timed.job.name };
    try {
      const log = await fetchJobLog(client, repo, timed.job.id, limits);
      if (!log) {
        return { ...base, kind: "log-unavailable", detail: "GitHub returned no log for this job (HTTP 404 or 410); it may have expired or be inaccessible, so log-based causes were not examined." };
      }
      return parseJobLog(log.text, { truncated: log.truncated });
    } catch (error) {
      return { ...base, kind: "log-error", detail: `Fetching or parsing the job log failed (${failureReason(error)}), so log-based causes were not examined.` };
    }
  });
  const results = new Map<number, JobLogResult>();
  selected.forEach((timed, index) => {
    const result = fetched[index];
    if (result) results.set(timed.job.id, result);
  });
  for (const timed of ordered.slice(budget)) {
    results.set(timed.job.id, {
      kind: "log-not-fetched", jobKey: timed.job.key, jobName: timed.job.name,
      detail: `Skipped to stay within the ${budget}-log budget (failed, critical and longest jobs are fetched first), so log-based causes were not examined.`,
    });
  }
  return results;
}
