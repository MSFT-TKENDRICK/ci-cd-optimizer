import { describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/index.js";
import { MemoryKnowledgeStore } from "../../src/knowledge/store.js";
import { MAINTENANCE_LIMIT, planMaintenance } from "../../src/knowledge/maintenance.js";
import { identity } from "../../src/knowledge/identity.js";
import { repository, snapshot } from "../knowledge/fixtures.js";

describe("operator knowledge maintenance", () => {
  it("requires explicit reviewed confirmation and paused-writer acknowledgement", async () => {
    const store = new MemoryKnowledgeStore();
    await store.save(snapshot());
    const stdout: string[] = [];
    const stderr: string[] = [];
    const factory = vi.fn(async () => store);
    const github = vi.fn(() => { throw new Error("Operator maintenance must not rely on repository API access"); });
    const io = { cwd: ".", env: {}, knowledgeStore: factory, github,
      stdout: (value: string) => stdout.push(value), stderr: (value: string) => stderr.push(value) };
    const command = ["maintenance", "purge", "--host", repository.host, "--repository-id", repository.repositoryId];
    expect(await run([...command, "--apply"], io)).toBe(2);
    expect(factory).not.toHaveBeenCalled();
    expect(await run(command, io)).toBe(0);
    const plan = JSON.parse(stdout[0]!) as { digest: string; applied: boolean };
    expect(plan.applied).toBe(false);
    expect(await store.load(repository, snapshot().id)).toBeDefined();
    expect(await run([...command, "--confirm", plan.digest], io)).toBe(2);
    expect(await run([...command, "--apply", "--confirm", plan.digest, "--writers-paused"], io)).toBe(0);
    expect(await store.load(repository, snapshot().id)).toBeUndefined();
    expect(github).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain("require --apply");
  });

  it("rejects oversized plans rather than silently deleting a partial selection", () => {
    expect(() => planMaintenance({ ...repository, mode: "purge" }, {
      definitions: [], applications: [], events: [], evaluations: [], snapshots: [], crossRepositoryApplications: 0,
      runs: Array.from({ length: MAINTENANCE_LIMIT + 1 }, (_, index) => identity(index)),
    })).toThrow("Maintenance exceeds");
  });
});
