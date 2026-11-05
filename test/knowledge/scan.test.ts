import { describe, expect, it, vi } from "vitest";
import { scanRepository } from "../../src/service/scan.js";
import { loadKnowledgeIdentity } from "../../src/knowledge/repository.js";
import { MemoryKnowledgeStore } from "../../src/knowledge/store.js";
import { fakeApi, TIMEOUT_ONLY, writes } from "../service/api.js";
import { files, repository, revision } from "./fixtures.js";

export const metadata = { id: 42, html_url: "https://github.com/acme/widgets", owner: { login: "acme" }, name: "widgets" };
const state = () => ({
  config: `${TIMEOUT_ONLY}ignorePaths: []\n`, repositoryMetadata: metadata, commitSha: revision,
  refs: { main: Object.fromEntries(Object.entries(files).map(([path, json]) => [path, JSON.stringify(json)])) },
});

describe("knowledge scan integration", () => {
  it("persists source-revision evidence before GitHub writes without changing default scan output", async () => {
    const store = new MemoryKnowledgeStore();
    const client = fakeApi(state());
    const original = await scanRepository(client, repository);
    expect(original.knowledge).toBeUndefined();
    const scan = await scanRepository(client, repository, { knowledgeStore: async () => store });
    expect(scan.knowledge?.persistence).toBe("saved");
    expect(scan.knowledge?.snapshot.revision).toBe(revision);
    expect(scan.result?.diagnostics).toEqual(original.result?.diagnostics);
    expect(await store.load(repository, scan.knowledge!.snapshot.id)).toEqual(scan.knowledge?.snapshot);
    expect(writes(client)).toEqual([]);
  });

  it("collects dry-run evidence without initializing or writing any store", async () => {
    const provider = vi.fn(async () => new MemoryKnowledgeStore());
    const client = fakeApi(state());
    const scan = await scanRepository(client, repository, { dryRun: true, knowledgeStore: provider });
    expect(provider).not.toHaveBeenCalled();
    expect(scan.knowledge?.persistence).toBe("dry-run");
    expect(writes(client)).toEqual([]);
  });

  it.each(["enabled: false\n", "rules:\n  unknown-rule: error\n"])("does not collect or initialize persistence for an inactive scan: %s", async (config) => {
    const provider = vi.fn(async () => new MemoryKnowledgeStore());
    const scan = await scanRepository(fakeApi({ ...state(), config }), repository, { knowledge: true, knowledgeStore: provider });
    expect(provider).not.toHaveBeenCalled();
    expect(scan.knowledge).toBeUndefined();
  });

  it("surfaces initialization and save failures without proceeding to GitHub publication", async () => {
    const store = new MemoryKnowledgeStore();
    vi.spyOn(store, "save").mockRejectedValue(new Error("persist failed"));
    const client = fakeApi(state());
    await expect(scanRepository(client, repository, { uploadSarif: true, knowledgeStore: async () => store })).rejects.toThrow("persist failed");
    await expect(scanRepository(client, repository, { knowledgeStore: () => Promise.reject(new Error("init failed")) })).rejects.toThrow("init failed");
    expect(writes(client)).toEqual([]);
  });

  it.each([
    {}, { ...metadata, id: 0 }, { ...metadata, id: 1.5 }, { ...metadata, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...metadata, html_url: "http://github.com/acme/widgets" },
    { ...metadata, html_url: "https://github.com/acme/not-widgets" },
    { ...metadata, html_url: "https://user:secret@github.com/acme/widgets" },
  ])("refuses untrustworthy repository identity metadata: %j", async (repositoryMetadata) => {
    await expect(loadKnowledgeIdentity(fakeApi({ repositoryMetadata }), repository)).rejects.toThrow();
  });
});
