import { validateRunObservation, validateRunObservationQuery } from "./run-observation.js";
import type { RunEvidenceWindow, RunEvidenceWindowQuery, RunObservation } from "./types.js";

export const MAX_RUN_OBSERVATIONS = 8;
export const MAX_RUN_OBSERVATION_BYTES = 65_536;

export function validateRunWindowQuery(query: RunEvidenceWindowQuery): void {
  validateRunObservationQuery({ ...query, runId: query.referenceRunId });
  if (!Number.isSafeInteger(query.workflowId) || query.workflowId < 1) throw new Error("Workflow ID must be a positive safe integer");
  if (query.branch !== null && (typeof query.branch !== "string" || !query.branch)) throw new Error("Run window branch must be a nonempty string or null");
}

export interface RunWindowRow {
  runId: number;
  id: string;
  observation: RunObservation | null;
}

/** Rows are ordered by pinned reference, latest observation, run ID, and observation recency. */
export function runWindowFromRows(query: RunEvidenceWindowQuery, rows: readonly RunWindowRow[]): RunEvidenceWindow {
  validateRunWindowQuery(query);
  const grouped = new Map<number, RunWindowRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.runId) ?? [];
    group.push(row);
    grouped.set(row.runId, group);
  }
  const groups = [...grouped].slice(0, query.limit).map(([runId, entries]) => {
    const observations: RunObservation[] = [];
    for (const { id, observation } of entries) {
      if (!observation) continue;
      validateRunObservation(observation);
      if (observation.id !== id || observation.run.runId !== runId ||
          observation.repository.host !== query.host || observation.repository.repositoryId !== query.repositoryId) {
        throw new Error("Stored run window evidence does not match its indexed identity");
      }
      observations.push(observation);
    }
    const complete = entries.length <= MAX_RUN_OBSERVATIONS && observations.length === entries.length;
    return { runId, complete, observations: complete ? structuredClone(observations) : [] };
  });
  return { complete: grouped.size <= query.limit, groups };
}
