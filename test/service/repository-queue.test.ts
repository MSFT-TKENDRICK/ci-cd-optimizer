import { describe, expect, it } from "vitest";
import { RepositoryQueue } from "../../src/service/repository-queue.js";
import { repo } from "../experiments/fixtures.js";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("repository operation queue", () => {
  it("runs same-repository operations in arrival order, including case variants", async () => {
    const queue = new RepositoryQueue();
    const gate = latch();
    const started = latch();
    const order: number[] = [];
    const first = queue.run(repo, async () => {
      order.push(1);
      started.release();
      await gate.promise;
      return "first";
    });
    const second = queue.run({ owner: "ACME", repo: "Widgets" }, async () => { order.push(2); return "second"; });
    const third = queue.run(repo, async () => { order.push(3); return "third"; });
    await started.promise;
    expect(order).toEqual([1]);
    gate.release();
    expect(await Promise.all([first, second, third])).toEqual(["first", "second", "third"]);
    expect(order).toEqual([1, 2, 3]);
    expect(await queue.run(repo, async () => "later")).toBe("later");
  });

  it("does not block independent repositories or owners", async () => {
    const queue = new RepositoryQueue();
    const gate = latch();
    const first = queue.run(repo, () => gate.promise);
    try {
      expect(await queue.run({ ...repo, repo: "another" }, async () => 2)).toBe(2);
      expect(await queue.run({ ...repo, owner: "another" }, async () => 3)).toBe(3);
    } finally {
      gate.release();
      await first;
    }
  });

  it.each([false, true])("propagates a failure and releases subsequent work (async: %s)", async (asyncFailure) => {
    const queue = new RepositoryQueue();
    const failure = new Error("GitHub unavailable");
    const first = queue.run(repo, () => {
      if (asyncFailure) return Promise.reject(failure);
      throw failure;
    });
    const second = queue.run(repo, async () => "recovered");
    await expect(first).rejects.toBe(failure);
    expect(await second).toBe("recovered");
    expect(await queue.run(repo, async () => "still usable")).toBe("still usable");
  });
});
