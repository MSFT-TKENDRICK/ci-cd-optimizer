import type { KnowledgeStore } from "../knowledge/types.js";
import { UsageError, type CliIO } from "./io.js";

/** Connections are lazy so dry runs and opted-out targets never initialize or query a database. */
export async function usingKnowledgeStore<T>(
  io: CliIO, enabled: boolean, action: (factory: (() => Promise<KnowledgeStore>) | undefined) => Promise<T>,
): Promise<T> {
  let owned: KnowledgeStore | undefined;
  let pending: Promise<KnowledgeStore> | undefined;
  let operationFailed = false;
  let operationError: unknown;
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
  try { return await action(enabled ? get : undefined); }
  catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    try { await owned?.close?.(); }
    catch (error) {
      if (operationFailed) {
        const message = (value: unknown) => value instanceof Error ? value.message : String(value);
        throw new AggregateError([operationError, error],
          `${message(operationError)}; database cleanup also failed: ${message(error)}`, { cause: operationError });
      }
      throw error;
    }
  }
}
