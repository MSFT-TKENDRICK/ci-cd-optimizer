import type { KnowledgeStore } from "../knowledge/types.js";
import { UsageError, type CliIO } from "./io.js";

/** Connections are lazy so dry runs and opted-out targets never initialize or query a database. */
export async function usingKnowledgeStore<T>(
  io: CliIO, enabled: boolean, action: (factory: (() => Promise<KnowledgeStore>) | undefined) => Promise<T>,
): Promise<T> {
  let owned: KnowledgeStore | undefined;
  let pending: Promise<KnowledgeStore> | undefined;
  const get = () => {
    pending ??= (async () => {
      if (io.knowledgeStore) return io.knowledgeStore();
      if (!io.env.DATABASE_URL) throw new UsageError("Knowledge persistence requires DATABASE_URL; no database URL is accepted on the command line.");
      const { PostgresKnowledgeStore } = await import("../knowledge/postgres-store.js");
      owned = new PostgresKnowledgeStore(io.env.DATABASE_URL);
      await owned.initialize();
      return owned;
    })();
    return pending;
  };
  let result: T;
  try { result = await action(enabled ? get : undefined); }
  catch (operationError) {
    try { await owned?.close?.(); }
    catch (cleanupError) {
      const message = (value: unknown) => value instanceof Error ? value.message : String(value);
      throw new AggregateError([operationError, cleanupError],
        `${message(operationError)}; database cleanup also failed: ${message(cleanupError)}`, { cause: cleanupError });
    }
    throw operationError;
  }
  await owned?.close?.();
  return result;
}
