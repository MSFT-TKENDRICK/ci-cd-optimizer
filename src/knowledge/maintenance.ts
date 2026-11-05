import { identity, validateScope } from "./identity.js";
import type { KnowledgeMaintenancePlan, KnowledgeMaintenanceRequest } from "./types.js";

export const MAINTENANCE_LIMIT = 10_000;
export const MAINTENANCE_KINDS = ["definitions", "applications", "events", "evaluations", "runs", "snapshots", "executions"] as const;
export type MaintenanceTargets = Record<typeof MAINTENANCE_KINDS[number], string[]> & { crossRepositoryApplications: number };

export function validateMaintenanceRequest(request: KnowledgeMaintenanceRequest): void {
  validateScope(request);
  if (request.mode !== "prune" && request.mode !== "purge") throw new Error("Knowledge maintenance requires prune or purge mode");
  if (request.mode === "prune") {
    if (typeof request.before !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(request.before) ||
        !Number.isFinite(Date.parse(request.before)) || new Date(request.before).toISOString() !== request.before ||
        Date.parse(request.before) > Date.now()) {
      throw new Error("Pruning requires a valid, nonfuture UTC cutoff in YYYY-MM-DDTHH:mm:ss.sssZ form");
    }
  } else if (request.before !== undefined) throw new Error("Purge does not accept a retention cutoff");
  if (request.confirmation !== undefined && !/^[a-f0-9]{64}$/.test(request.confirmation)) {
    throw new Error("Maintenance confirmation must be the preview's SHA-256 digest");
  }
}

export function planMaintenance(request: KnowledgeMaintenanceRequest, targets: MaintenanceTargets): KnowledgeMaintenancePlan {
  validateMaintenanceRequest(request);
  for (const kind of MAINTENANCE_KINDS) {
    if (targets[kind].length > MAINTENANCE_LIMIT) {
      throw new Error(`Maintenance exceeds ${MAINTENANCE_LIMIT} ${kind}; use a smaller pruning window or an operator-reviewed bulk erasure procedure`);
    }
    if (new Set(targets[kind]).size !== targets[kind].length || targets[kind].some((id) => !/^[a-f0-9]{64}$/.test(id))) {
      throw new Error("Maintenance encountered invalid or duplicate stored evidence identities");
    }
  }
  const scope = { host: request.host, repositoryId: request.repositoryId };
  const policy = { version: 1 as const, scope, mode: request.mode, ...(request.before ? { before: request.before } : {}) };
  const digest = identity(["knowledge-maintenance-v1", policy,
    MAINTENANCE_KINDS.map((kind) => [kind, [...targets[kind]].sort()]), targets.crossRepositoryApplications]);
  if (request.confirmation !== undefined && request.confirmation !== digest) {
    throw new Error("Maintenance plan changed or confirmation does not match; review a fresh preview");
  }
  return {
    ...policy, digest, applied: request.confirmation !== undefined,
    counts: {
      definitions: targets.definitions.length, applications: targets.applications.length,
      events: targets.events.length, evaluations: targets.evaluations.length,
      runs: targets.runs.length, snapshots: targets.snapshots.length,
      executions: targets.executions.length,
    },
    crossRepositoryApplications: targets.crossRepositoryApplications,
    limitations: [
      "Knowledge tables only; legacy telemetry, webhook jobs, backups, logs, exports and GitHub items are not deleted.",
      "Pause all App workers and scheduled/CLI knowledge writers before applying; subsequent ingestion can recreate evidence.",
      "Counts cover evidence records; deleting a snapshot also removes its normalized project, technology and relationship rows.",
    ],
  };
}
