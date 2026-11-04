import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkflowSnapshot } from "./types.js";

export interface HistoryQuery {
  owner: string;
  repo: string;
  workflowId: number;
  /** `undefined` matches every branch; `null` matches runs without a branch. */
  branch?: string | null;
  limit: number;
}

/** Persists run snapshots between Actions runs so trends survive GitHub's log retention. */
export interface TelemetryStore {
  initialize(): Promise<void>;
  save(snapshot: WorkflowSnapshot): Promise<void>;
  /** The most recent completed runs of a workflow, returned oldest first. */
  history(query: HistoryQuery): Promise<WorkflowSnapshot[]>;
  close?(): Promise<void>;
}

export class MemoryTelemetryStore implements TelemetryStore {
  readonly snapshots: WorkflowSnapshot[] = [];

  async initialize(): Promise<void> {}

  async save(snapshot: WorkflowSnapshot): Promise<void> {
    const index = this.snapshots.findIndex((item) => item.runId === snapshot.runId);
    if (index >= 0) this.snapshots[index] = snapshot;
    else this.snapshots.push(snapshot);
  }

  async history(query: HistoryQuery): Promise<WorkflowSnapshot[]> {
    return selectHistory(this.snapshots, query);
  }
}

const byCompletion = (a: WorkflowSnapshot, b: WorkflowSnapshot) => a.completedAt.localeCompare(b.completedAt) || a.runId - b.runId;

function selectHistory(snapshots: readonly WorkflowSnapshot[], query: HistoryQuery): WorkflowSnapshot[] {
  return snapshots
    .filter(
      (item) =>
        item.owner === query.owner &&
        item.repo === query.repo &&
        item.workflowId === query.workflowId &&
        (query.branch === undefined || item.branch === query.branch),
    )
    .sort(byCompletion)
    .slice(-query.limit);
}

/**
 * Snapshots in a JSON Lines file, for persisting telemetry between Actions runs without a database (restore and save
 * the file with actions/cache, or commit it to a data branch). Keeps the newest `retain` runs per workflow and branch.
 */
export class FileTelemetryStore implements TelemetryStore {
  private snapshots: WorkflowSnapshot[] | undefined;

  constructor(
    private readonly path: string,
    private readonly retain = 200,
  ) {}

  async initialize(): Promise<void> {
    await this.load();
  }

  async save(snapshot: WorkflowSnapshot): Promise<void> {
    const all = (await this.load()).filter((item) => item.runId !== snapshot.runId);
    all.push(snapshot);
    const groups = new Map<string, WorkflowSnapshot[]>();
    for (const item of all) {
      const key = `${item.owner}/${item.repo}#${item.workflowId}@${item.branch ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    this.snapshots = [...groups.values()].flatMap((items) => items.sort(byCompletion).slice(-this.retain)).sort(byCompletion);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, this.snapshots.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf8");
    await rename(temporary, this.path);
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
