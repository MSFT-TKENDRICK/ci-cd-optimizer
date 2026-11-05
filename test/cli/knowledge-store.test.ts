import { beforeEach, describe, expect, it, vi } from "vitest";
import { usingKnowledgeStore } from "../../src/cli/knowledge-store.js";
import type { CliIO } from "../../src/cli/io.js";
import { MemoryKnowledgeStore } from "../../src/knowledge/store.js";

const mocks = vi.hoisted(() => ({ initialize: vi.fn(), close: vi.fn() }));
vi.mock("../../src/knowledge/postgres-store.js", () => ({
  PostgresKnowledgeStore: class {
    initialize = mocks.initialize;
    close = mocks.close;
  },
}));

const io = (): CliIO => ({ cwd: ".", env: { DATABASE_URL: "test-database" }, stdout: vi.fn(), stderr: vi.fn() });

describe("CLI knowledge connection ownership", () => {
  beforeEach(() => { mocks.initialize.mockReset(); mocks.close.mockReset(); });

  it("keeps disabled and unused connections lazy", async () => {
    await usingKnowledgeStore(io(), false, async (factory) => expect(factory).toBeUndefined());
    await usingKnowledgeStore(io(), true, async () => undefined);
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("initializes one owned connection and closes it once", async () => {
    await usingKnowledgeStore(io(), true, async (factory) => {
      expect(await factory!()).toBe(await factory!());
    });
    expect(mocks.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("does not initialize or close caller-owned stores", async () => {
    const store = new MemoryKnowledgeStore();
    const initialize = vi.spyOn(store, "initialize");
    const close = vi.fn();
    const injected = Object.assign(store, { close });
    await usingKnowledgeStore({ ...io(), knowledgeStore: async () => injected }, true, async (factory) => {
      expect(await factory!()).toBe(injected);
    });
    expect(initialize).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("can open an owned maintenance connection without running schema initialization", async () => {
    await usingKnowledgeStore(io(), true, async (factory) => factory!(), { initialize: false });
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("cleans up failed initialization and preserves both operation and cleanup errors", async () => {
    const failure = new Error("initialization failed");
    mocks.initialize.mockRejectedValue(failure);
    await expect(usingKnowledgeStore(io(), true, async (factory) => factory!())).rejects.toBe(failure);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    const cleanup = new Error("close failed");
    mocks.close.mockRejectedValue(cleanup);
    await expect(usingKnowledgeStore(io(), true, async (factory) => factory!())).rejects.toMatchObject({
      message: "initialization failed; database cleanup also failed: close failed", errors: [failure, cleanup],
    });
  });
});
