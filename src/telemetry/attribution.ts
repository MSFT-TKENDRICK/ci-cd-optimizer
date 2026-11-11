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
  | "toolchain-download" | "repeated-command" | "service-startup" | "test-runtime" | "repeated-setup";

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
    evidence: draft.evidence.map((line) => clip(line, MAX_EVIDENCE)),
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

function buildFindings(ctx: JobContext, entry: LocatedStep, build: BuildInvocation, index: number): Bottleneck[] {
  const findings: Bottleneck[] = [];
  const detail = `s${entry.path}b${index}`;
  const covers = [entry.top];

  const exports = build.vertices.filter((vertex) => vertex.kind === "cache-export");
  const exportMs = sum(exports.map(vertexMs));
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
    const loadMs = sum(loads.map(vertexMs));
    if (loadMs >= MIN_FINDING_MS) {
      findings.push(finding(ctx, {
        category: "image-load",
        detail,
        step: entry.label,
        observedMs: loadMs,
        observation: `${entry.label}: exporting the image and loading it into the runner's Docker engine (load: true) took ${formatMs(loadMs)}.`,
        recommendation: "Keep load: true only when later steps run the image locally; otherwise drop it (or push instead). When local use is required, the docker driver builds straight into the engine but supports different cache backends, so measure both before switching.",
        evidence: [...loads.map(describeVertex), "load: true"],
        covers,
      }));
    }
  }

  if (build.cacheFrom.length > 0) {
    const misses = build.vertices.filter((vertex) => vertex.kind === "run" && !vertex.cached && !vertex.error);
    const missMs = unionMs(misses.map((vertex) => [vertex.lastMs - vertexMs(vertex), vertex.lastMs] as const));
    if (missMs >= MIN_FINDING_MS) {
      const restored = build.vertices.filter((vertex) => (vertex.kind === "run" || vertex.kind === "copy") && vertex.cached).length;
      const source = build.cacheFrom.map((spec) => spec.raw).join("; ");
      const cause = restored === 0
        ? "No RUN or COPY layer was restored, which points to a cache scope that was evicted or never exported for these inputs rather than to changed inputs; the log alone cannot confirm which."
        : `${restored} other layer(s) were restored, so the cache was reachable; these layers' inputs (or an earlier layer) changed, or their entries were evicted.`;
      findings.push(finding(ctx, {
        category: "layer-cache-miss",
        detail,
        step: entry.label,
        observedMs: missMs,
        observation: `${entry.label}: ${misses.length} RUN layer(s) were rebuilt for ${formatMs(missMs)} although the build restores a cache (cache-from ${source}). ${cause}`,
        recommendation: "Check that a default-branch run exports this cache scope, that the repository's Actions cache is not evicting it at the size limit, and compare layer cache hits across consecutive runs before restructuring the Dockerfile.",
        evidence: [
          ...[...misses].sort((a, b) => vertexMs(b) - vertexMs(a) || a.id - b.id).slice(0, MAX_LISTED).map(describeVertex),
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
  let builderMs = sum([...pulling, ...booting].map((group) => group.durationMs));
  if (parts.length === 0) {
    const boots = step.builds.flatMap((build) => build.vertices.filter((vertex) => vertex.kind === "builder-boot"));
    builderMs = sum(boots.map(vertexMs));
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
    findings.push(finding(ctx, {
      category: "toolchain-download",
      detail: `s${entry.path}`,
      step: label,
      observedMs: step.durationMs,
      observation: `${label} downloaded its toolchain instead of finding it in the runner's tool cache (${formatMs(step.durationMs)}).`,
      recommendation: "Use a version the hosted runner image already caches, or cache the toolchain directory; a cache restore also takes time, so measure before and after.",
      evidence: [`${label}: tool cache miss, ${formatMs(step.durationMs)}`],
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
    const importShare = Math.max(0, ...step.tests.map((summary) => summary.phases.import ?? 0));
    findings.push(finding(ctx, {
      category: "test-runtime",
      detail: `s${entry.path}`,
      step: label,
      observedMs: step.durationMs,
      observation: `${label} ran tests for ${formatMs(step.durationMs)} (${frameworks.join("; ")}).`,
      recommendation: [
        "Split the suite across parallel jobs (for example vitest --shard=<i>/<n> or jest --shard=<i>/<n>); sharding trades extra runner time, including setup repeated per shard, for elapsed time.",
        ...(importShare >= 20 ? [`Imports take ${importShare}% of the test time, so trimming heavy imports from the module graph would cut work in every shard.`] : []),
        ...(!ctx.timing.critical ? ["This job is off the critical path, so it only shortens the run once the critical path is reduced."] : []),
      ].join(" "),
      evidence: [...frameworks, ...phaseLines],
      covers: [entry.top],
    }));
  }
  return findings;
}

function jobFindings(ctx: JobContext): Bottleneck[] {
  const { evidence, located } = ctx;
  const findings = located.flatMap((entry) => stepFindings(ctx, entry));

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
      recommendation: "Run the service only in jobs that use it, prefer a smaller image, and tune the health-check interval; or start it with docker run --detach early in the job so it boots while other steps run instead of blocking the first step.",
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
      recommendation: "Cache what this setup produces (dependencies, toolchains) so each repeat is shorter, or merge short jobs that share it; merging parallel jobs can lengthen the run, so only merge jobs that have slack.",
      evidence: list.slice(0, MAX_LISTED * 2).map((use) => `${clip(use.timed.job.name, MAX_LABEL)}: ${formatMs(use.ms)}`),
    });
  }
  return findings;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
        gaps.push({
          kind: "unexplained-time", jobKey: job.key, jobName: job.name, ms: entry.step.durationMs,
          detail: `${entry.label} took ${formatMs(entry.step.durationMs)} on the critical path and no recognised bottleneck pattern explains it.`,
        });
      }
    }
  }

  bottlenecks.push(...repeatedSetup(shape, evidenceById));
  bottlenecks.sort((a, b) => b.elapsedSavingsBoundMs - a.elapsedSavingsBoundMs
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
 * Fetches and parses a bounded number of job logs, critical and longest jobs first. A failure for one job becomes a
 * coverage gap for that job; it never aborts the others.
 */
export async function collectJobLogs(
  client: GitHubClient, repo: RepoRef, snapshot: WorkflowSnapshot, options: JobLogOptions = {},
): Promise<Map<number, JobLogResult>> {
  const shape = analyzeRun(snapshot);
  const budget = Math.max(0, Math.floor(options.maxJobLogs ?? DEFAULT_MAX_JOB_LOGS));
  const ordered = [...shape.measured].sort((a, b) =>
    Number(shape.timing.get(b.job.id)?.critical ?? false) - Number(shape.timing.get(a.job.id)?.critical ?? false)
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
      detail: `Skipped to stay within the ${budget}-log budget (critical and longest jobs are fetched first), so log-based causes were not examined.`,
    });
  }
  return results;
}
