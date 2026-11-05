import { describe, expect, it, vi } from "vitest";
import { startWorkers } from "../../src/webhooks/worker.js";
import type { Delivery, DeliveryQueue } from "../../src/webhooks/postgres-queue.js";

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("webhook workers", () => {
  it("reports a queue failure and stops idle polling promptly", async () => {
    const logger = log();
    const processNext = vi.fn<DeliveryQueue["processNext"]>()
      .mockRejectedValueOnce(new Error("Database unavailable"))
      .mockResolvedValue({ status: "idle" });
    const workers = startWorkers({ enqueue: async () => undefined, processNext }, async () => undefined, logger);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
    await workers.stop();
    expect(processNext).toHaveBeenCalledTimes(2);
  });

  it("waits for an active handler to finish on shutdown", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const logger = log();
    let first = true;
    const queue: DeliveryQueue = {
      enqueue: async () => undefined,
      processNext: async (handler) => {
        if (!first) return { status: "idle" };
        first = false;
        await handler({ id: "test", name: "push", payload: {} } as Delivery);
        return { status: "completed", id: "test", scope: "acme/web:mutations", attempts: 1 };
      },
    };
    const workers = startWorkers(queue, () => gate, logger);
    let stopped = false;
    const stopping = workers.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(logger.info).toHaveBeenCalledOnce();
  });
});
