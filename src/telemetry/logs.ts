import { httpStatus, type GitHubClient, type RepoRef } from "../github/client.js";

/**
 * Job logs explain *why* a step took the time the jobs API reports. This module fetches a bounded copy of one job's
 * log and parses the structure the Actions runner, BuildKit and common toolchains print, without executing or
 * trusting anything in it. Every field is derived from timestamps or fixed-format summary lines; anything the parser
 * does not recognise is ignored, never guessed.
 */

export const MAX_JOB_LOG_BYTES = 4 * 1024 * 1024;
export const MAX_JOB_LOG_LINES = 50_000;
const MAX_TEXT = 200;

export interface FetchedJobLog {
  text: string;
  /** True when the log exceeded the byte or line budget and only its head was kept. */
  truncated: boolean;
  bytes: number;
}

export interface LogSubGroup {
  title: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export type VertexKind =
  | "cache-import" | "cache-export" | "image-export" | "image-load" | "push"
  | "run" | "copy" | "base-image" | "builder-boot" | "internal" | "other";

export interface BuildOperation {
  name: string;
  durationMs: number;
}

export interface BuildTransfer {
  digest: string;
  progress: string;
  firstMs: number;
  lastMs: number;
  elapsedMs: number;
  /** Repeated unchanged progress, bounded by both log and transfer clocks. */
  unchangedMs: number;
}

export interface BuildVertex {
  id: number;
  name: string;
  kind: VertexKind;
  firstMs: number;
  lastMs: number;
  /** BuildKit's own `DONE n.ns`, the authoritative vertex duration. */
  durationMs?: number;
  cached: boolean;
  /** Timed RUN command output was observed; absence does not prove that the command did not execute. */
  executionOutput?: true;
  error: boolean;
  operations: BuildOperation[];
  /** Incomplete transfers at the end of the retained log; not proof of their backend cause. */
  transfers?: BuildTransfer[];
}

export interface CacheSpec {
  type?: string;
  mode?: string;
  scope?: string;
  raw: string;
}

export interface BuildInvocation {
  startMs: number;
  driver?: string;
  cacheFrom: CacheSpec[];
  cacheTo: CacheSpec[];
  load: boolean;
  push: boolean;
  vertices: BuildVertex[];
}

export interface TestFileTiming {
  /** Reported file label, including the project name when present. */
  label: string;
  durationMs: number;
}

export interface TestSummary {
  framework: "vitest" | "jest" | "node-test" | "pytest";
  files?: number;
  tests?: number;
  durationMs?: number;
  /** Phase shares in percent (Vitest prints e.g. `import 25%`), keyed by phase name. */
  phases: Record<string, number>;
  /** Up to three longest reported file durations; concurrent files are not additive. */
  slowFiles?: TestFileTiming[];
}

export interface LogStep {
  /** Order among steps at the same level, starting at 0. */
  index: number;
  title: string;
  kind: "action" | "script";
  uses?: string;
  command?: string;
  inputs: Record<string, string>;
  envKeys: string[];
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Steps of a composite action, delimited by the runner's start-action/end-action markers. */
  children: LogStep[];
  subGroups: LogSubGroup[];
  builds: BuildInvocation[];
  toolCache?: "hit" | "download";
  /** Set when the downloaded toolchain came from a pinned release archive rather than a runner tool cache. */
  toolSource?: "release";
  packageCache?: "hit" | "miss";
  /** At most three recognized access entries printed by the build action, not an authorization decision. */
  cacheAccess?: {
    entries: { scope: string; permission: "read" | "write" | "read/write" }[];
    omittedEntries: number;
  };
  installedPackages?: number;
  /**
   * On top-level steps, the longest stretch between consecutive log lines while the step ran, including the tail up to
   * the next step. A quiet step shows missing instrumentation, not what the time was spent on.
   */
  silence?: { startMs: number; endMs: number; durationMs: number };
  tests: TestSummary[];
}

export interface ServiceStartup {
  name: string;
  image?: string;
  startMs: number;
  endMs: number;
  pullMs?: number;
  pulled?: boolean;
  healthWaitMs?: number;
  polls: number;
}

export interface RepeatedCommand {
  command: string;
  steps: number[];
  durationsMs: number[];
}

export interface JobLogEvidence {
  firstMs?: number;
  lastMs?: number;
  setup: { durationMs: number; services: ServiceStartup[] };
  steps: LogStep[];
  post: { startMs?: number; durationMs: number; subGroups: LogSubGroup[]; cacheSaveFailures: string[] };
  repeatedCommands: RepeatedCommand[];
  generatedArtifactFailures?: { artifact: string; evidence: string }[];
  truncated: boolean;
  lines: number;
}

/** Fetches one job's log; undefined when GitHub no longer has it (404/410). */
export async function fetchJobLog(
  client: GitHubClient, repo: RepoRef, jobId: number, limits: { maxBytes?: number; maxLines?: number } = {},
): Promise<FetchedJobLog | undefined> {
  let data: unknown;
  try {
    data = (await client.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", { ...repo, job_id: jobId })).data;
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404 || status === 410) return undefined;
    throw error;
  }
  return boundJobLog(data, limits.maxBytes ?? MAX_JOB_LOG_BYTES, limits.maxLines ?? MAX_JOB_LOG_LINES);
}

/** Keeps at most `maxBytes` (cut at a line boundary) and `maxLines` of a log response body. */
export function boundJobLog(data: unknown, maxBytes = MAX_JOB_LOG_BYTES, maxLines = MAX_JOB_LOG_LINES): FetchedJobLog {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data)
    : data instanceof Uint8Array ? data
      : data instanceof ArrayBuffer ? new Uint8Array(data)
        : undefined;
  if (!bytes) throw new Error("GitHub returned a job log that is not text");
  let view = bytes;
  let truncated = false;
  if (view.length > maxBytes) {
    const cut = view.lastIndexOf(0x0a, maxBytes);
    view = view.subarray(0, cut > 0 ? cut : maxBytes);
    truncated = true;
  }
  let text = new TextDecoder("utf-8").decode(view);
  const lines = text.split("\n", maxLines + 1);
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  return { text, truncated, bytes: bytes.length };
}

interface Line {
  ms: number;
  text: string;
}

const LINE = /^\uFEFF?(?:[^\t]*\t[^\t]*\t)?\uFEFF?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z ?(.*)$/;
// eslint-disable-next-line no-control-regex -- job logs carry terminal colour escapes, raw or caret-escaped
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\^\[\[[0-9;?]*[A-Za-z]/g;

/** Timestamped, colour-free lines; accepts both the API format and `gh run view --log` (job and step columns). */
export function normalizeLogLines(text: string): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split("\n")) {
    const match = LINE.exec(raw.replace(/\r$/, ""));
    if (!match) continue;
    const fraction = (match[2] ?? "").padEnd(3, "0").slice(0, 3);
    const ms = Date.parse(`${match[1]}.${fraction}Z`);
    if (Number.isNaN(ms)) continue;
    lines.push({ ms, text: (match[3] ?? "").replace(ANSI, "") });
  }
  return lines;
}

function clip(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
}

function seconds(value: string, unit = "s"): number {
  const amount = Number(value);
  return Math.round(unit === "ms" ? amount : unit === "m" ? amount * 60_000 : amount * 1000);
}

export function vertexKind(name: string): VertexKind {
  if (/^importing cache manifest/i.test(name)) return "cache-import";
  if (/^exporting (?:to GitHub Actions Cache|cache\b)/i.test(name)) return "cache-export";
  if (/^exporting to (?:docker image format|image|oci image format)/i.test(name)) return "image-export";
  if (/^importing to docker/i.test(name)) return "image-load";
  if (/^pushing\b|^exporting to registry/i.test(name)) return "push";
  if (/^\[[^\]]+\] RUN\b/.test(name)) return "run";
  if (/^\[[^\]]+\] (?:COPY|ADD)\b/.test(name)) return "copy";
  if (/^\[[^\]]+\] FROM\b|^docker-image:\/\//.test(name)) return "base-image";
  if (/booting buildkit/i.test(name)) return "builder-boot";
  if (/^\[(?:internal|auth)\]|^resolve image config/i.test(name)) return "internal";
  return "other";
}

export function parseCacheSpec(raw: string): CacheSpec {
  const spec: CacheSpec = { raw: clip(raw.trim()) };
  for (const part of raw.split(",")) {
    const [key, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (key === "type") spec.type = value;
    else if (key === "mode") spec.mode = value;
    else if (key === "scope") spec.scope = value;
  }
  return spec;
}

function buildFromCommand(command: string, ms: number): BuildInvocation {
  const tokens = command.split(/\s+/);
  const build: BuildInvocation = { startMs: ms, cacheFrom: [], cacheTo: [], load: false, push: false, vertices: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const [flag, inline] = token.includes("=") && token.startsWith("--") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, undefined];
    const value = (): string => (inline ?? tokens[++index] ?? "").replace(/^["']|["']$/g, "");
    if (flag === "--cache-from") build.cacheFrom.push(parseCacheSpec(value()));
    else if (flag === "--cache-to") build.cacheTo.push(parseCacheSpec(value()));
    else if (flag === "--load") build.load = true;
    else if (flag === "--push") build.push = true;
    else if (flag === "--output" || flag === "-o") {
      const output = value();
      if (/type=docker\b/.test(output)) build.load = true;
      if (/push=true|type=registry\b/.test(output)) build.push = true;
    }
  }
  return build;
}

function newStep(index: number, title: string, ms: number): LogStep {
  return {
    index, title: clip(title), kind: "action", inputs: {}, envKeys: [], startMs: ms, endMs: ms, durationMs: 0,
    children: [], subGroups: [], builds: [], tests: [],
  };
}

function finishStep(step: LogStep, endMs: number): void {
  step.endMs = Math.max(step.startMs, endMs);
  step.durationMs = step.endMs - step.startMs;
  if (step.kind === "action") step.uses = clip(step.title.replace(/^Run /, ""));
}

function firstAtLeast(sorted: readonly number[], target: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] as number) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Finds each step's longest gap between log lines; the earliest gap wins a tie and a step without any gap has none. */
function annotateSilence(steps: readonly LogStep[], lines: readonly Line[]): void {
  const stamps = lines.map((line) => line.ms).sort((a, b) => a - b);
  for (const step of steps) {
    const inside = stamps.slice(firstAtLeast(stamps, step.startMs), firstAtLeast(stamps, step.endMs + 1));
    let previous = step.startMs;
    let silence: LogStep["silence"];
    for (const ms of [...inside, step.endMs]) {
      if (ms - previous > (silence?.durationMs ?? 0)) silence = { startMs: previous, endMs: ms, durationMs: ms - previous };
      previous = ms;
    }
    if (silence) step.silence = silence;
  }
}

function testLine(step: LogStep, text: string, pending: WeakMap<LogStep, TestFileTiming[]>): void {
  let match: RegExpExecArray | null;
  const last = step.tests.at(-1);
  if (/^\s*RUN\s+v\d+\.\d+\.\d+(?:[-+][\w.-]+)?(?:\s|$)/.test(text)) {
    pending.set(step, []);
  } else if (pending.has(step) && (match = /^\s*[✓✔×❯]\s+(.{1,200}?\.[cm]?[jt]sx?)\s+\(\d+ tests?(?: \| \d+ (?:failed|skipped|todo))*\)\s+(\d+(?:\.\d+)?)\s*(ms|s)\s*$/.exec(text))) {
    const label = (match[1] as string).trim();
    const durationMs = seconds(match[2] as string, match[3]);
    if (label.length > MAX_TEXT || !Number.isSafeInteger(durationMs) || durationMs <= 0) return;
    const files = pending.get(step)!;
    const existing = files.find((file) => file.label === label);
    if (existing) existing.durationMs = Math.max(existing.durationMs, durationMs);
    else files.push({ label, durationMs });
    files.sort((a, b) => b.durationMs - a.durationMs || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    files.splice(3);
  } else if ((match = /^\s*Test Files\s+.*\((\d+)\)\s*$/.exec(text))) {
    const slowFiles = pending.get(step);
    step.tests.push({ framework: "vitest", files: Number(match[1]), phases: {}, ...(slowFiles?.length ? { slowFiles } : {}) });
    pending.delete(step);
  } else if (last?.framework === "vitest" && (match = /^\s*Tests\s+.*\((\d+)\)\s*$/.exec(text))) {
    last.tests = Number(match[1]);
  } else if (last?.framework === "vitest" && last.durationMs === undefined && (match = /^\s*Duration\s+([\d.]+)(ms|s|m)\b(?:\s*\((.*)\))?/.exec(text))) {
    last.durationMs = seconds(match[1] as string, match[2]);
    for (const phase of (match[3] ?? "").matchAll(/([a-z]+) ([\d.]+)%/g)) last.phases[phase[1] as string] = Number(phase[2]);
  } else if ((match = /^\s*Test Suites:.*?(\d+) total/.exec(text))) {
    pending.delete(step);
    step.tests.push({ framework: "jest", files: Number(match[1]), phases: {} });
  } else if (last?.framework === "jest" && (match = /^\s*Tests:.*?(\d+) total/.exec(text))) {
    last.tests = Number(match[1]);
  } else if (last?.framework === "jest" && last.durationMs === undefined && (match = /^\s*Time:\s+([\d.]+) ?(ms|s|m)\b/.exec(text))) {
    last.durationMs = seconds(match[1] as string, match[2]);
  } else if ((match = /^[#ℹ] tests (\d+)$/.exec(text))) {
    pending.delete(step);
    step.tests.push({ framework: "node-test", tests: Number(match[1]), phases: {} });
  } else if (last?.framework === "node-test" && last.durationMs === undefined && (match = /^[#ℹ] duration_ms ([\d.]+)$/.exec(text))) {
    last.durationMs = Math.round(Number(match[1]));
  } else if ((match = /^=+ (.*\d+ (?:passed|failed).*) in ([\d.]+)s\b.*=+$/.exec(text))) {
    pending.delete(step);
    const tests = [...(match[1] as string).matchAll(/(\d+) (?:passed|failed|skipped|errors?|xfailed|xpassed)/g)].reduce((sum, item) => sum + Number(item[1]), 0);
    step.tests.push({ framework: "pytest", tests, durationMs: seconds(match[2] as string), phases: {} });
  }
}

const BUILD_START_VERTEX = /^\[internal\] load (?:build definition|\.dockerignore|local bake definitions|remote build context)\b/;
const DOCKER_BUILD = /(?:^|[\s/;&|(])docker(?:\s+buildx)?\s+(?:build|bake)\b/;

/** The build receiving BuildKit output: the latest one with vertices or a driver banner, else the first declared one. */
function activeBuild(step: LogStep): number {
  for (let index = step.builds.length - 1; index >= 0; index -= 1) {
    if (step.builds[index]?.vertices.length || step.builds[index]?.driver) return index;
  }
  return step.builds.length ? 0 : -1;
}

type PendingTransfer = Omit<BuildTransfer, "unchangedMs"> & { firstElapsedMs: number };
type PendingTransfers = WeakMap<BuildVertex, Map<string, PendingTransfer>>;

function transferLine(vertex: BuildVertex, text: string, ms: number, pending: PendingTransfers): void {
  const digest = /^(sha256:[a-f0-9]{64})\b/.exec(text)?.[1];
  if (!digest) return;
  const match = text.length <= MAX_TEXT
    ? /^sha256:[a-f0-9]{64} (\d+(?:\.\d+)?)([kMGT]?B) \/ (\d+(?:\.\d+)?)([kMGT]?B) (\d+(?:\.\d+)?)s( done)?$/.exec(text) : null;
  const transfers = pending.get(vertex) ?? new Map<string, PendingTransfer>();
  const bytes = (value: string, unit: string): number => Number(value) * 1000 ** ["B", "kB", "MB", "GB", "TB"].indexOf(unit);
  const current = match ? bytes(match[1]!, match[2]!) : NaN;
  const total = match ? bytes(match[3]!, match[4]!) : NaN;
  const elapsedMs = match ? seconds(match[5]!) : NaN;
  if (!match || !Number.isSafeInteger(elapsedMs) || !Number.isFinite(current) || !Number.isFinite(total)
    || current < 0 || total <= 0 || total > Number.MAX_SAFE_INTEGER || current >= total || match[6]) {
    transfers.delete(digest);
    return;
  }
  const progress = `${match[1]}${match[2]} / ${match[3]}${match[4]}`;
  const previous = transfers.get(digest);
  const restart = !previous || previous.progress !== progress || elapsedMs < previous.elapsedMs || ms < previous.lastMs;
  transfers.set(digest, {
    digest, progress, firstMs: restart ? ms : previous.firstMs, lastMs: ms, elapsedMs,
    firstElapsedMs: restart ? elapsedMs : previous.firstElapsedMs,
  });
  pending.set(vertex, transfers);
}

function vertexLine(step: LogStep, id: number, text: string, ms: number, pending: PendingTransfers): void {
  const active = activeBuild(step);
  let build = step.builds[active];
  // BuildKit restarts its numbering for every build. A later build in the same step starts with a `#0` banner or,
  // without one, with a fresh `#1 [internal] load …` after other vertices. BuildKit also reprints finished vertices
  // while it pulls and extracts their layers, so a reprinted vertex alone does not start a new build.
  const restarted = id === 1 && BUILD_START_VERTEX.test(text) && build?.vertices.some((vertex) => vertex.id > 1) === true;
  if (!build || (build.vertices.length > 0 && (id === 0 || restarted))) {
    const declared = step.builds.slice(active + 1).find((candidate) => candidate.vertices.length === 0);
    if (declared) build = declared;
    else {
      build = { startMs: ms, cacheFrom: [], cacheTo: [], load: false, push: false, vertices: [] };
      step.builds.push(build);
    }
  }
  if (id === 0) {
    const driver = /instance using ([\w-]+) driver/.exec(text)?.[1];
    if (driver) build.driver = driver;
    return;
  }
  let vertex = build.vertices.find((candidate) => candidate.id === id);
  if (!vertex) {
    vertex = { id, name: clip(text), kind: vertexKind(text), firstMs: ms, lastMs: ms, cached: false, error: false, operations: [] };
    build.vertices.push(vertex);
    transferLine(vertex, text, ms, pending);
    return;
  }
  vertex.lastMs = ms;
  transferLine(vertex, text, ms, pending);
  let match: RegExpExecArray | null;
  if ((match = /^DONE ([\d.]+)s$/.exec(text))) {
    vertex.durationMs = seconds(match[1] as string);
    pending.delete(vertex);
  } else if (text === "CACHED") vertex.cached = true;
  else if (/^(?:ERROR|CANCELED)\b/.test(text)) vertex.error = true;
  else if (vertex.kind === "run" && /^\d+\.\d+ /.test(text)) vertex.executionOutput = true;
  else if (!/^\d+\.\d+ /.test(text) && (match = /^(.+?) ([\d.]+)s done$/.exec(text))
    && !/^(?:sha256:|extracting |loading layer |writing layer )/.test(match[1] as string)) {
    vertex.operations.push({ name: clip(match[1] as string), durationMs: seconds(match[2] as string) });
  }
}

/** Parses a job log into setup, step, BuildKit, cache, install, test and post-job evidence. */
export function parseJobLog(text: string, options: { truncated?: boolean } = {}): JobLogEvidence {
  const lines = normalizeLogLines(text);
  const evidence: JobLogEvidence = {
    ...(lines.length ? { firstMs: (lines[0] as Line).ms, lastMs: (lines.at(-1) as Line).ms } : {}),
    setup: { durationMs: 0, services: [] }, steps: [],
    post: { durationMs: 0, subGroups: [], cacheSaveFailures: [] },
    repeatedCommands: [], truncated: options.truncated ?? false, lines: lines.length,
  };
  let phase: "setup" | "steps" | "post" = "setup";
  let top: LogStep | undefined;
  const actions: Array<{ id: string; parent: LogStep | undefined; step?: LogStep; display: string; startMs: number }> = [];
  let header: { step: LogStep; mode: "command" | "with" | "env" | "done"; commands: string[]; lastInput?: string } | undefined;
  const groups: Array<{ title: string; startMs: number; header: boolean; owner: LogStep | "setup" | "post" }> = [];
  let service: ServiceStartup | undefined;
  let pullStartMs: number | undefined;
  const declaredOnly = new Set<BuildInvocation>();
  const pendingTests = new WeakMap<LogStep, TestFileTiming[]>();
  const pendingTransfers: PendingTransfers = new WeakMap();
  let waitStartMs: number | undefined;

  const innermost = (): LogStep | undefined => {
    for (let index = actions.length - 1; index >= 0; index -= 1) if (actions[index]?.step) return actions[index]?.step;
    return top;
  };

  for (const { ms, text: line } of lines) {
    if (line.startsWith("##[start-action ")) {
      const id = /;id=([^;\]]+)/.exec(line)?.[1] ?? "";
      const display = /display=(.*?);id=/.exec(line)?.[1] ?? "";
      actions.push({ id, parent: innermost(), display, startMs: ms });
      continue;
    }
    if (line.startsWith("##[end-action ")) {
      const id = /id=([^;\]]+)/.exec(line)?.[1];
      const index = actions.map((action) => action.id).lastIndexOf(id ?? "");
      const action = index >= 0 ? actions.splice(index)[0] : undefined;
      if (action) {
        const reported = Number(/duration_ms=(\d+)/.exec(line)?.[1]);
        const durationMs = Number.isFinite(reported) ? reported : ms - action.startMs;
        if (action.step) {
          finishStep(action.step, ms);
          action.step.durationMs = durationMs;
        } else if (phase === "post") {
          evidence.post.subGroups.push({ title: clip(`Post ${action.display}`), startMs: action.startMs, endMs: ms, durationMs });
        }
      }
      continue;
    }
    if (line.startsWith("##[group]")) {
      const title = line.slice("##[group]".length);
      if (phase !== "post" && title.startsWith("Run ")) {
        const open = actions.at(-1);
        let step: LogStep;
        if (open && !open.step) {
          const parent = open.parent;
          step = newStep(parent?.children.length ?? 0, title, ms);
          parent?.children.push(step);
          open.step = step;
        } else {
          if (top) finishStep(top, ms);
          step = newStep(evidence.steps.length, title, ms);
          evidence.steps.push(step);
          top = step;
          phase = "steps";
        }
        header = { step, mode: "command", commands: [] };
        groups.push({ title, startMs: ms, header: true, owner: step });
        continue;
      }
      const owner = phase === "setup" ? "setup" : phase === "post" ? "post" : innermost() ?? "post";
      groups.push({ title, startMs: ms, header: false, owner });
      const starting = /^Starting (?:(.+) service container|(job) container)$/.exec(title);
      if (phase === "setup" && starting) {
        service = { name: clip((starting[1] ?? starting[2]) as string), startMs: ms, endMs: ms, polls: 0 };
        evidence.setup.services.push(service);
      }
      if (phase === "setup" && title === "Waiting for all services to be ready") waitStartMs = ms;
      continue;
    }
    if (line.startsWith("##[endgroup]")) {
      const group = groups.pop();
      if (!group) continue;
      if (group.header) {
        if (header) {
          if (header.commands.length) header.step.command = clip(header.commands.join("\n"));
          if (header.step.kind === "action") {
            header.step.uses = clip(header.step.title.replace(/^Run /, ""));
          } else {
            // A `run:` script is not echoed as `[command]`, so its builds are declared from the script itself.
            for (const logical of header.commands.join("\n").replace(/\\\n/g, " ").split("\n")) {
              if (!DOCKER_BUILD.test(logical)) continue;
              const build = buildFromCommand(logical.slice(logical.search(DOCKER_BUILD)), ms);
              header.step.builds.push(build);
              declaredOnly.add(build);
            }
          }
        }
        header = undefined;
        continue;
      }
      const entry = { title: clip(group.title), startMs: group.startMs, endMs: ms, durationMs: ms - group.startMs };
      if (group.owner === "post") evidence.post.subGroups.push(entry);
      else if (group.owner !== "setup") group.owner.subGroups.push(entry);
      if (service && group.title.startsWith("Starting ")) {
        service.endMs = ms;
        service = undefined;
      }
      continue;
    }
    if (header) {
      const step = header.step;
      if (line === "with:") header.mode = "with";
      else if (line === "env:") header.mode = "env";
      else if (line.startsWith("shell: ")) {
        step.kind = "script";
        header.mode = "done";
      } else if (header.mode === "with") {
        const input = /^ {2}([A-Za-z0-9_.-]+): ?(.*)$/.exec(line);
        if (input) {
          header.lastInput = input[1] as string;
          step.inputs[header.lastInput] = clip(input[2] as string);
        } else if (header.lastInput) step.inputs[header.lastInput] = clip(`${step.inputs[header.lastInput]}\n${line.trim()}`);
      } else if (header.mode === "env") {
        const key = /^ {2}([A-Za-z_][A-Za-z0-9_]*):/.exec(line)?.[1];
        if (key && !step.envKeys.includes(key)) step.envKeys.push(key);
      } else if (header.mode === "command") header.commands.push(line);
      continue;
    }
    const artifact = /^##\[error\]dist-action is stale\b/.test(line) ? "action-bundle"
      : /^##\[error\]Agent bundle is stale\b/.test(line) ? "agent-bundle"
        : /^(?:Error: )?Stale generated proof artifact: [\w./-]+\. Run npm run formal:generate\.$/.test(line) ? "proof-artifact"
          : /^(?:##\[error\])?dist-setup is out of date\b/.test(line) ? "setup-ui" : undefined;
    if (artifact && !(evidence.generatedArtifactFailures ?? []).some((failure) => failure.artifact === artifact)) {
      (evidence.generatedArtifactFailures ??= []).push({ artifact, evidence: clip(line) });
    }
    if (phase === "setup") {
      let match: RegExpExecArray | null;
      if (service && (match = /^##\[command\]\S*docker pull (\S+)/.exec(line))) {
        service.image = clip(match[1] as string);
        pullStartMs = ms;
      } else if (service && pullStartMs !== undefined && /^Status: (?:Downloaded newer image|Image is up to date) for /.test(line)) {
        service.pulled = line.startsWith("Status: Downloaded");
        service.pullMs = ms - pullStartMs;
        pullStartMs = undefined;
      } else if ((match = /^(.+) service is starting, waiting \d+ seconds before checking again\.$/.exec(line))) {
        const name = match[1];
        const target = evidence.setup.services.find((candidate) => candidate.name === name);
        if (target) target.polls += 1;
      } else if ((match = /^(.+) service is healthy\.$/.exec(line))) {
        const name = match[1];
        const target = evidence.setup.services.find((candidate) => candidate.name === name);
        if (target && waitStartMs !== undefined) target.healthWaitMs = ms - waitStartMs;
      }
      continue;
    }
    if (phase === "steps" && line === "Post job cleanup.") {
      for (const action of actions.splice(0)) if (action.step) finishStep(action.step, ms);
      if (top) finishStep(top, ms);
      top = undefined;
      phase = "post";
      evidence.post.startMs = ms;
      continue;
    }
    if (phase === "post") {
      const failure = /^Failed to save: (.*)$/.exec(line)?.[1];
      if (failure) evidence.post.cacheSaveFailures.push(clip(failure));
      continue;
    }
    const step = innermost();
    if (!step) continue;
    const group = groups.at(-1);
    if (group?.owner === step && group.title === "GitHub Actions runtime token ACs"
      && /^docker\/build-push-action@/.test(step.uses ?? "") && line.length <= MAX_TEXT) {
      const access = /^(refs\/(?:heads|tags|pull)\/[A-Za-z0-9._/-]+): (read\/write|read|write)$/.exec(line);
      const scope = access?.[1];
      const permission = access?.[2];
      if (scope && (permission === "read" || permission === "write" || permission === "read/write")) {
        const reported = step.cacheAccess ??= { entries: [], omittedEntries: 0 };
        if (!reported.entries.some((entry) => entry.scope === scope && entry.permission === permission)) {
          if (reported.entries.length < 3) reported.entries.push({ scope, permission });
          else reported.omittedEntries += 1;
        }
      }
      continue;
    }
    const command = /^(?:##)?\[command\](.*)$/.exec(line)?.[1];
    if (command !== undefined) {
      if (DOCKER_BUILD.test(command)) step.builds.push(buildFromCommand(command.slice(command.search(DOCKER_BUILD)), ms));
      continue;
    }
    const vertex = /^#(\d+) (.+)$/.exec(line);
    if (vertex) {
      vertexLine(step, Number(vertex[1]), vertex[2] as string, ms, pendingTransfers);
      continue;
    }
    if (line.startsWith("Found in cache @ ") || /^Reusing verified (?:[\w-]+ )?toolchain at \S/.test(line)) step.toolCache = "hit";
    else if (/^(?:Attempting to download|Acquiring) \S/.test(line)) step.toolCache ??= "download";
    else if (/^Downloading https:\/\/\S+\/releases\/download\/\S+\.(?:zip|tar\.gz|tgz|tar\.xz)$/.test(line)) {
      step.toolCache ??= "download";
      if (step.toolCache === "download") step.toolSource = "release";
    }
    else if (/^Cache restored from key: |^Cache hit for: |^Cache restored successfully/.test(line)) step.packageCache = "hit";
    else if (/^(?:\S+ )?cache is not found$|^Cache not found for (?:input )?keys?:/i.test(line)) step.packageCache = "miss";
    else {
      const added = /^added (\d+) packages?\b/.exec(line);
      if (added) step.installedPackages = Number(added[1]);
      else testLine(step, line, pendingTests);
    }
  }

  const endMs = evidence.post.startMs ?? evidence.lastMs ?? 0;
  // A script that merely mentions `docker build` (or skips it) produced no BuildKit output; keep only builds that ran.
  const prune = (step: LogStep): void => {
    step.builds = step.builds.filter((build) => !declaredOnly.has(build) || build.vertices.length > 0);
    for (const vertex of step.builds.flatMap((build) => build.vertices)) {
      const transfers = pendingTransfers.get(vertex);
      if (transfers?.size) vertex.transfers = [...transfers.values()].map(({ firstElapsedMs, ...transfer }) => ({
        ...transfer, unchangedMs: Math.min(transfer.lastMs - transfer.firstMs, transfer.elapsedMs - firstElapsedMs),
      }));
    }
    step.children.forEach(prune);
  };
  evidence.steps.forEach(prune);
  if (top) finishStep(top, endMs);
  for (const action of actions) if (action.step) finishStep(action.step, endMs);
  annotateSilence(evidence.steps, lines);
  const firstStep = evidence.steps[0];
  if (evidence.firstMs !== undefined) evidence.setup.durationMs = (firstStep?.startMs ?? endMs) - evidence.firstMs;
  if (evidence.post.startMs !== undefined && evidence.lastMs !== undefined) evidence.post.durationMs = evidence.lastMs - evidence.post.startMs;
  evidence.repeatedCommands = repeatedCommands(evidence.steps);
  return evidence;
}

function repeatedCommands(steps: readonly LogStep[]): RepeatedCommand[] {
  const byCommand = new Map<string, LogStep[]>();
  for (const step of steps) {
    if (step.kind !== "script") continue;
    const command = (step.command ?? step.title.replace(/^Run /, "")).replace(/\s+/g, " ").trim();
    if (!command) continue;
    byCommand.set(command, [...(byCommand.get(command) ?? []), step]);
  }
  return [...byCommand].filter(([, list]) => list.length > 1)
    .map(([command, list]) => ({ command: clip(command), steps: list.map((step) => step.index), durationsMs: list.map((step) => step.durationMs) }));
}
