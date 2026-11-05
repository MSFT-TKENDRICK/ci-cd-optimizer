import { identity, validateRevision, validateScope } from "./identity.js";
import type { ExecutionObservation, ExecutionReport, RunObservation } from "./types.js";

export const MAX_EXECUTION_BYTES = 64 * 1024;
const tools = ["node", "npm", "pnpm", "yarn", "bun", "typescript", "nx", "turborepo", "docker", "git", "python", "dotnet", "java", "gradle", "bazel", "pants"] as const;
const caches = ["actions-cache", "turborepo", "nx", "docker", "bazel", "gradle", "custom"] as const;
const states = ["hit", "miss", "partial", "unknown"] as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Execution evidence must be an object");
  return value as Record<string, unknown>;
}
function string(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      !pattern.test(value)) throw new Error(`Execution ${field} is invalid`);
  return value;
}
function integer(value: unknown, field: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`Execution ${field} must be a safe integer >= ${minimum}`);
  return Number(value);
}
function time(value: unknown): string {
  const result = string(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "timestamp");
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error("Execution timestamp is invalid");
  return result;
}
function enumeration<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`Execution ${field} is unsupported`);
  return value as T;
}
export function executionProjectPath(value: unknown): string {
  const path = string(value, /^(?:\.|[^\\:]{1,1024})$/, "project path");
  if (path !== "." && path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Execution project path must be a canonical repository-relative directory");
  }
  return path;
}

export function executionTools(value: unknown): ExecutionReport["tools"] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Execution tools must be a bounded list");
  const result = value.map((entry) => {
    const item = object(entry);
    return {
      name: enumeration(item.name, tools, "tool"),
      version: string(item.version, /^v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]{1,60})?$/, "installed tool version"),
      basis: enumeration(item.basis, ["recorder-runtime", "workflow-report"] as const, "tool basis"),
    };
  });
  if (new Set(result.map(({ name }) => name)).size !== result.length) throw new Error("Execution tools must be unique");
  if (result.some((item) => item.basis === "recorder-runtime" && item.name !== "node")) throw new Error("Only Node is directly observed by this recorder");
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function executionCaches(value: unknown): ExecutionReport["caches"] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("Execution caches must be a bounded list");
  const result = value.map((entry) => {
    const item = object(entry);
    return { tool: enumeration(item.tool, caches, "cache tool"), result: enumeration(item.result, states, "cache result"), basis: "workflow-report" as const };
  });
  if (new Set(result.map(({ tool }) => tool)).size !== result.length) throw new Error("Execution cache tools must be unique");
  return result.sort((a, b) => a.tool.localeCompare(b.tool));
}

/** Reconstructs an allowlisted report; commands, environment variables, cache keys and unknown fields are never stored. */
export function parseExecutionReport(value: unknown): ExecutionReport {
  const input = object(value);
  if (input.version !== 1 || input.coverage !== "single-command") throw new Error("Execution report version/coverage is unsupported");
  const scope = object(input.repository);
  const repository = {
    host: string(scope.host, /^https:\/\/.{1,253}$/, "host"),
    repositoryId: string(scope.repositoryId, /^[1-9]\d{0,19}$/, "repository ID"),
  };
  validateScope(repository);
  const headSha = string(input.headSha, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/, "run revision");
  const checkoutSha = string(input.checkoutSha, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/, "checkout revision");
  const startedAt = time(input.startedAt);
  const completedAt = time(input.completedAt);
  const durationMs = input.durationMs;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 14 * 86400_000 ||
      Date.parse(completedAt) < Date.parse(startedAt) || Math.abs(Date.parse(completedAt) - Date.parse(startedAt) - durationMs) > 1000) {
    throw new Error("Execution duration is invalid or disagrees with wall-clock timestamps");
  }
  const exitCode = input.exitCode === null ? null : integer(input.exitCode, "exit code", 0);
  const signal = input.signal === null ? null : string(input.signal, /^SIG[A-Z0-9]{1,12}$/, "signal");
  if (exitCode !== null && exitCode > 0xffffffff || (exitCode === null) === (signal === null)) throw new Error("Execution requires either an exit code or termination signal");
  return {
    version: 1, repository, runId: integer(input.runId, "run ID"), runAttempt: integer(input.runAttempt, "attempt"),
    headSha, checkoutSha, jobKey: string(input.jobKey, /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/, "workflow job key"),
    projectPath: executionProjectPath(input.projectPath),
    task: string(input.task, /^[A-Za-z0-9][A-Za-z0-9_.: -]{0,127}$/, "task label"),
    startedAt, completedAt, durationMs, exitCode, signal,
    tools: executionTools(input.tools), caches: executionCaches(input.caches), coverage: "single-command",
  };
}

export function executionObservationIdentity(item: Omit<ExecutionObservation, "id"> | ExecutionObservation): string {
  return identity(["execution-observation-v1", item.repository, item.runObservationId, item.jobId, item.report, item.provenance]);
}

export function createExecutionObservation(
  report: ExecutionReport, runObservationId: string, jobId: number, now = new Date(),
): ExecutionObservation {
  const normalized = parseExecutionReport(report);
  const body = {
    version: 1 as const, repository: normalized.repository, runObservationId, jobId,
    report: normalized, provenance: "operator-supplied" as const, recordedAt: now.toISOString(),
  };
  const result = { ...body, id: executionObservationIdentity(body) };
  validateExecutionObservation(result);
  return result;
}

export function validateExecutionObservation(item: ExecutionObservation, observation?: RunObservation): void {
  validateScope(item.repository);
  if (item.version !== 1 || item.provenance !== "operator-supplied" || !/^[a-f0-9]{64}$/.test(item.runObservationId)) throw new Error("Execution observation identity/provenance is invalid");
  integer(item.jobId, "job ID");
  time(item.recordedAt);
  const report = parseExecutionReport(item.report);
  if (identity(report) !== identity(item.report) || item.id !== executionObservationIdentity(item) ||
      report.repository.host !== item.repository.host || report.repository.repositoryId !== item.repository.repositoryId) {
    throw new Error("Execution observation does not match its content");
  }
  if (Date.parse(item.recordedAt) < Date.parse(report.completedAt)) throw new Error("Execution observation cannot predate task completion");
  if (!observation) return;
  const run = observation.run;
  const job = run.jobs.find(({ id }) => id === item.jobId);
  validateRevision(report.checkoutSha);
  if (observation.id !== item.runObservationId || observation.repository.host !== item.repository.host ||
      observation.repository.repositoryId !== item.repository.repositoryId || run.runId !== report.runId ||
      run.runAttempt !== report.runAttempt || run.headSha !== report.headSha || !job || job.key !== report.jobKey) {
    throw new Error("Execution report does not match the exact repository/run/attempt/job evidence");
  }
  if (Date.parse(report.startedAt) < Date.parse(job.startedAt) || Date.parse(report.completedAt) > Date.parse(job.completedAt)) {
    throw new Error("Execution report is outside its recorded job interval");
  }
}
