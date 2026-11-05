import type { Probot } from "probot";
import type { PostgresWebhookQueue } from "./postgres-queue.js";

export const READINESS_TIMEOUT_MS = 1000;
export const READINESS_CACHE_MS = 1000;

export function createReadinessCheck(
  queue: Pick<PostgresWebhookQueue, "checkReadiness">,
  log: Pick<Probot["log"], "error">,
): () => Promise<boolean> {
  let pending = false;
  let inFlight: Promise<boolean> | undefined;
  let cached: { ready: boolean; expiresAt: number } | undefined;

  return async () => {
    if (cached && Date.now() < cached.expiresAt) return cached.ready;
    if (inFlight) return await inFlight;
    // A timed-out database operation may still own a connection. Do not accumulate more probes.
    if (pending) return false;
    pending = true;
    let timedOut = false;
    const operation = Promise.resolve().then(() => queue.checkReadiness()).catch((error: unknown) => {
      if (timedOut) log.error({ error }, "Readiness query failed after its response deadline");
      throw error;
    }).finally(() => { pending = false; });
    inFlight = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ready = false;
      try {
        await Promise.race([
          operation,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error("Webhook queue readiness deadline exceeded"));
            }, READINESS_TIMEOUT_MS);
          }),
        ]);
        ready = true;
      } catch (error) {
        log.error({ error }, "Durable ingress is not ready");
      } finally {
        clearTimeout(timer);
      }
      cached = { ready, expiresAt: Date.now() + READINESS_CACHE_MS };
      inFlight = undefined;
      return ready;
    })();
    return await inFlight;
  };
}
