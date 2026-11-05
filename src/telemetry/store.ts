import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkflowSnapshot } from "./types.js";
import { attemptIdentity, byCompletion, latestAttempts, runIdentity, selectHistory, validateRunAttempt, type HistoryQuery } from "./history.js";
export type { HistoryQuery } from "./history.js";

/** Persists run snapshots between Actions runs so trends survive GitHub's log retention. */
export interface TelemetryStore {
  initialize(): Promise<void>;
  save(snapshot: WorkflowSnapshot): Promise<void>;
  /** Most recent runs (or explicit attempts), returned oldest first. Failed attempts remain available. */
  history(query: HistoryQuery): Promise<WorkflowSnapshot[]>;
  close?(): Promise<void>;
}

export class MemoryTelemetryStore implements TelemetryStore {
  readonly snapshots: WorkflowSnapshot[] = [];

  async initialize(): Promise<void> {}

  async save(snapshot: WorkflowSnapshot): Promise<void> {
    validateRunAttempt(snapshot.runAttempt);
    const index = this.snapshots.findIndex((item) => attemptIdentity(item) === attemptIdentity(snapshot));
    if (index >= 0) this.snapshots[index] = snapshot;
    else this.snapshots.push(snapshot);
  }

  async history(query: HistoryQuery): Promise<WorkflowSnapshot[]> {
    return selectHistory(this.snapshots, query);
  }
}

/**
 * Snapshots in a JSON Lines file, for persisting telemetry between Actions runs without a database (restore and save
 * the file with actions/cache, or commit it to a data branch). Keeps all observed attempts of the newest `retain`
 * runs per workflow and branch, grouped by each run's latest attempt. This remains a single-writer store.
 */
export class FileTelemetryStore implements TelemetryStore {
  private snapshots: WorkflowSnapshot[] | undefined;

  constructor(
    private readonly path: string,
    private readonly retain = 200,
  ) {
    if (!Number.isSafeInteger(retain) || retain < 1) throw new Error("Telemetry retention must be a positive safe integer");
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async save(snapshot: WorkflowSnapshot): Promise<void> {
    validateRunAttempt(snapshot.runAttempt);
    const all = (await this.load()).filter((item) => attemptIdentity(item) !== attemptIdentity(snapshot));
    all.push(snapshot);
    const groups = new Map<string, WorkflowSnapshot[]>();
    for (const item of latestAttempts(all)) {
      const key = JSON.stringify([item.owner, item.repo, item.workflowId, item.branch]);
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    const retained = new Set([...groups.values()].flatMap((items) => items.sort(byCompletion).slice(-this.retain)).map(runIdentity));
    const next = all.filter((item) => retained.has(runIdentity(item))).sort(byCompletion);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, next.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf8");
    await rename(temporary, this.path);
    this.snapshots = next;
  }

  async history(query: HistoryQuery): Promise<WorkflowSnapshot[]> {
    return selectHistory(await this.load(), query);
  }

  private async load(): Promise<WorkflowSnapshot[]> {
    if (this.snapshots) return this.snapshots;
    const text = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    // A partially written or hand-edited line is dropped rather than failing the run.
    this.snapshots = text.split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const parsed = JSON.parse(line) as Partial<WorkflowSnapshot>;
        return typeof parsed.runId === "number" && typeof parsed.completedAt === "string" ? [parsed as WorkflowSnapshot] : [];
      } catch {
        return [];
      }
    });
    return this.snapshots;
  }
}
