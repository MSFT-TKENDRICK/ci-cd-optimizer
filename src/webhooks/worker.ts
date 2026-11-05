import { setTimeout } from "node:timers/promises";
import type { Probot } from "probot";
import { APP_EVENTS } from "../app.js";
import type { Delivery, DeliveryQueue } from "./postgres-queue.js";

/** Probot verifies the signature before invoking this handler; success means the insert committed. */
export function registerDurableIngress(probot: Probot, queue: Pick<DeliveryQueue, "enqueue">): void {
  probot.on([
    ...APP_EVENTS.pullRequest, APP_EVENTS.checkRun, APP_EVENTS.push, ...APP_EVENTS.installation,
    APP_EVENTS.workflowRun, APP_EVENTS.comment,
  ], async (context) => {
    // Reconstruct the discriminated union from fields of the same verified event.
    await queue.enqueue({ id: context.id, name: context.name, payload: context.payload } as Delivery);
  });
}

export function startWorkers(queue: DeliveryQueue, handler: (delivery: Delivery) => Promise<void>, log: Pick<Probot["log"], "info" | "warn" | "error">): { stop: () => Promise<void> } {
  const stop = new AbortController();
  const loop = async () => {
    while (!stop.signal.aborted) {
      let idle = true;
      try {
        const result = await queue.processNext(handler);
        idle = result.status === "idle";
        if (result.status === "completed") log.info(result, "Webhook job completed");
        else if (result.status === "retrying") log.warn(result, "Webhook job will retry");
        else if (result.status === "failed") log.error(result, "Webhook job exhausted retries; redeliver after resolving the cause");
      } catch (error) {
        log.error({ error }, "Webhook queue unavailable; polling will retry");
      }
      if (idle && !stop.signal.aborted) {
        try {
          await setTimeout(1000, undefined, { signal: stop.signal });
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "AbortError") throw error;
        }
      }
    }
  };
  const workers = [loop(), loop()];
  return { stop: async () => { stop.abort(); await Promise.all(workers); } };
}
