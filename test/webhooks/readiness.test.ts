import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadinessCheck, READINESS_CACHE_MS, READINESS_TIMEOUT_MS } from "../../src/webhooks/readiness.js";

function latch() {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  return { promise, release, fail };
}

afterEach(() => { vi.useRealTimers(); });

describe("bounded durable readiness", () => {
  it("coalesces concurrent probes and caches success only for the bounded interval", async () => {
    vi.useFakeTimers();
    const gate = latch();
    const queue = { checkReadiness: vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(undefined) };
    const log = { error: vi.fn() };
    const check = createReadinessCheck(queue, log);
    const requests = Array.from({ length: 20 }, () => check());
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.checkReadiness).toHaveBeenCalledOnce();
    gate.release();
    expect(await Promise.all(requests)).toEqual(Array(20).fill(true));
    await vi.advanceTimersByTimeAsync(READINESS_CACHE_MS - 1);
    expect(await check()).toBe(true);
    expect(queue.checkReadiness).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await check()).toBe(true);
    expect(queue.checkReadiness).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs failure, bounds retries, and observes recovery after cache expiry", async () => {
    vi.useFakeTimers();
    const failure = new Error("Database unavailable");
    const queue = { checkReadiness: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined) };
    const log = { error: vi.fn() };
    const check = createReadinessCheck(queue, log);
    expect(await check()).toBe(false);
    expect(log.error).toHaveBeenCalledWith({ error: failure }, "Durable ingress is not ready");
    expect(await Promise.all(Array.from({ length: 20 }, () => check()))).toEqual(Array(20).fill(false));
    expect(queue.checkReadiness).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(READINESS_CACHE_MS);
    expect(await check()).toBe(true);
    expect(queue.checkReadiness).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "failure"] as const)("does not pile up timed-out queries or accept a late %s as readiness", async (outcome) => {
    vi.useFakeTimers();
    const gate = latch();
    const queue = { checkReadiness: vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(undefined) };
    const log = { error: vi.fn() };
    const check = createReadinessCheck(queue, log);
    let resolved = false;
    const result = check().then((ready) => { resolved = true; return ready; });
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS - 1);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      { error: expect.objectContaining({ message: "Webhook queue readiness deadline exceeded" }) },
      "Durable ingress is not ready",
    );
    await vi.advanceTimersByTimeAsync(READINESS_CACHE_MS * 10);
    expect(await Promise.all(Array.from({ length: 50 }, () => check()))).toEqual(Array(50).fill(false));
    expect(queue.checkReadiness).toHaveBeenCalledOnce();
    const failure = new Error("Late database failure");
    if (outcome === "success") gate.release();
    else gate.fail(failure);
    await vi.advanceTimersByTimeAsync(0);
    if (outcome === "failure") expect(log.error).toHaveBeenCalledWith({ error: failure }, "Readiness query failed after its response deadline");
    queue.checkReadiness.mockRejectedValueOnce(new Error("Fresh verification fails"));
    expect(await check()).toBe(false);
    expect(queue.checkReadiness).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(READINESS_CACHE_MS);
    expect(await check()).toBe(true);
    expect(queue.checkReadiness).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles a synchronous probe failure without remaining permanently pending", async () => {
    vi.useFakeTimers();
    const queue = {
      checkReadiness: vi.fn<() => Promise<void>>().mockImplementationOnce(() => { throw new Error("Probe failed"); }).mockResolvedValue(undefined),
    };
    const log = { error: vi.fn() };
    const check = createReadinessCheck(queue, log);
    expect(await check()).toBe(false);
    expect(log.error).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(READINESS_CACHE_MS);
    expect(await check()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
