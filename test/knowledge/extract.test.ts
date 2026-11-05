import { describe, expect, it } from "vitest";
import { extractKnowledge, technologyStatus } from "../../src/knowledge/extract.js";
import { snapshotIdentity } from "../../src/knowledge/identity.js";
import { files, input, now, repository, revision, snapshot } from "./fixtures.js";

describe("revision-linked project evidence", () => {
  it("keeps declared tools, source pointers and version expressions distinct from runtime evidence", () => {
    const result = snapshot();
    const root = result.projects.find((project) => project.name === "root")!;
    const a = result.projects.find((project) => project.name === "@acme/a")!;
    const b = result.projects.find((project) => project.name === "@acme/b")!;
    expect(technologyStatus(result, root.id, "turborepo")).toMatchObject({
      scope: "direct-project-declarations", status: "observed",
      evidence: [{ basis: "dependency", spec: { kind: "version-expression", value: "^2.0.0" }, source: { path: "package.json", pointer: "/devDependencies/turbo" } }],
    });
    expect(technologyStatus(result, a.id, "turborepo").status).toBe("not-observed");
    expect(result.relationships.find((edge) => edge.from === a.id && edge.kind === "declares-dependency")).toMatchObject({
      to: b.id, resolution: "workspace-name", spec: { kind: "workspace-expression", value: "workspace:*" },
      source: { pointer: "/dependencies/@acme~1b" },
    });
    expect(technologyStatus(result, b.id, "nx").status).toBe("observed");
    expect(() => technologyStatus(result, "unknown-project", "nx")).toThrow("does not belong");
  });

  it("does not resolve ordinary registry declarations to a same-named local package", () => {
    const result = extractKnowledge(repository, revision, input({
      ...files, "packages/a/package.json": { name: "@acme/a", dependencies: { "@acme/b": "^1.0.0" } },
    }), { now });
    expect(result.relationships.find((edge) => edge.targetName === "@acme/b")).toMatchObject({ resolution: "unresolved" });
    expect(result.relationships.find((edge) => edge.targetName === "@acme/b")?.to).toBeUndefined();
  });

  it("retains explicit exclusions and duplicate-name ambiguity without choosing a target", () => {
    const duplicates = { ...files, "packages/c/package.json": { name: "@acme/b" } };
    const ambiguous = extractKnowledge(repository, revision, input(duplicates), { now });
    expect(ambiguous.relationships.find((edge) => edge.targetName === "@acme/b")?.resolution).toBe("ambiguous");
    const excluded = extractKnowledge(repository, revision, input({
      ...duplicates, "package.json": { ...files["package.json"], workspaces: ["packages/*", "!packages/b", "!packages/c"] },
    }), { now });
    expect(excluded.relationships.filter((edge) => edge.kind === "workspace-member")).toHaveLength(1);
    expect(excluded.relationships.find((edge) => edge.targetName === "@acme/b")?.resolution).toBe("unresolved");
  });

  it.each([
    { "pnpm-workspace.yaml": "packages: [packages/a]" },
    { "pnpm-workspace.yaml": "packages: [packages/*]\npackages: [packages/b]" },
    { "package.json": { ...files["package.json"], workspaces: ["packages/{a,b}"] } },
    { "package.json": { ...files["package.json"], workspaces: ["packages/*", "!"] } },
    { "packages/broken/package.json": "not json" },
  ])("abstains when workspace declarations conflict or discovery cannot establish unique targets: %j", (overrides) => {
    const result = extractKnowledge(repository, revision, input({ ...files, ...overrides }), { now });
    expect(result.coverage.declarationsComplete).toBe(false);
    expect(result.relationships.find((edge) => edge.targetName === "@acme/b")?.to).toBeUndefined();
  });

  it.each(["incomplete", "ignored", "truncated"] as const)("does not claim uniqueness or absence in %s discovery", (kind) => {
    const source = input();
    if (kind === "incomplete") source.inventoryComplete = false;
    const result = extractKnowledge(repository, revision, source, {
      now, ...(kind === "ignored" ? { ignorePaths: ["hidden/**"] } : {}), ...(kind === "truncated" ? { truncated: ["missing/package.json"] } : {}),
    });
    expect(result.relationships.find((edge) => edge.targetName === "@acme/b")?.to).toBeUndefined();
    expect(technologyStatus(result, result.projects.find((project) => project.name === "@acme/a")!.id, "nx").status).toBe("unknown");
  });

  it("records malformed declarations without copying arbitrary URLs or local paths", () => {
    const result = extractKnowledge(repository, revision, input({
      "package.json": {
        name: "safe", dependencies: { turbo: "https://user:secret@example.invalid/pkg", typescript: "file:../private" },
        devDependencies: [], optionalDependencies: { nx: 1 }, engines: { node: ">=22" },
        peerDependencies: { lerna: `workspace:1.0.0-${"s".repeat(300)}` },
      },
    }), { now });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("secret");
    expect(encoded).not.toContain("../private");
    expect(result.technologies.filter((fact) => fact.basis === "dependency").every((fact) => fact.spec?.kind === "opaque")).toBe(true);
    expect(result.coverage.declarationsComplete).toBe(false);
  });

  it("uses configuration-root identities rather than attributing nested config to the repository root", () => {
    const source = input({ "tools/turbo.json": {}, "tools/nx.json": {}, constructor: "" });
    const first = extractKnowledge(repository, revision, source, { now });
    const second = extractKnowledge(repository, revision, { ...source, files: [...source.files].reverse() }, { now: new Date(now.getTime() + 1000) });
    expect(first.id).toBe(second.id);
    const tools = first.projects.find((project) => project.path === "tools")!;
    expect(tools.kind).toBe("configuration-root");
    expect(first.technologies).toHaveLength(2);
    expect(first.technologies.every((fact) => fact.projectId === tools.id)).toBe(true);
  });

  it("keeps stable location identities through repository/package renames but not moves, hosts or repository IDs", () => {
    const original = snapshot();
    const renamed = extractKnowledge({ ...repository, owner: "new-owner", repo: "new-name" }, revision, input({
      ...files, "packages/a/package.json": { name: "renamed" },
    }), { now });
    expect(renamed.projects.find((project) => project.path === "packages/a")?.id).toBe(original.projects.find((project) => project.path === "packages/a")?.id);
    for (const scope of [{ ...repository, repositoryId: "43" }, { ...repository, host: "https://github.example.com" }]) {
      expect(extractKnowledge(scope, revision, input(), { now }).projects.map((project) => project.id)).not.toEqual(original.projects.map((project) => project.id));
    }
    const moved = extractKnowledge(repository, revision, input({ "moved/package.json": files["packages/a/package.json"] }), { now });
    expect(moved.projects.find((project) => project.name === "@acme/a")?.id).not.toBe(original.projects.find((project) => project.name === "@acme/a")?.id);
  });

  it("content-addresses canonical evidence and selection, not collection time or input order", () => {
    const first = snapshot();
    const reordered = { ...first, repository: { repo: repository.repo, owner: repository.owner, repositoryId: repository.repositoryId, host: repository.host } };
    expect(snapshotIdentity(reordered)).toBe(first.id);
    expect(extractKnowledge(repository, revision, { ...input(), files: input().files.reverse() }, { now: new Date(now.getTime() + 1000) }).id).toBe(first.id);
    expect(extractKnowledge(repository, revision, input(), { now, ignorePaths: ["hidden/**"] }).id).not.toBe(first.id);
  });

  it("bounds evidence growth and makes the omitted declarations explicit", () => {
    const dependencies = Object.fromEntries(Array.from({ length: 10_100 }, (_, i) => [`pkg-${i}`, "1"]));
    const result = extractKnowledge(repository, revision, input({ "package.json": { dependencies } }), { now });
    expect(result.relationships.length + result.technologies.length).toBe(10_000);
    expect(result.coverage.problems).toContainEqual({ path: "package.json", code: "evidence-limit" });
    expect(result.coverage.declarationsComplete).toBe(false);
  });

  it.each(["../package.json", "/package.json", "./package.json", "a//package.json", "C:\\package.json"])("rejects noncanonical path %s", (path) => {
    expect(() => extractKnowledge(repository, revision, input({ [path]: {} }), { now })).toThrow("repository-relative");
  });
  it("rejects mutable revisions, invalid scopes and duplicate source paths", () => {
    expect(() => extractKnowledge(repository, "main", input(), { now })).toThrow("immutable");
    expect(() => extractKnowledge({ ...repository, host: "http://github.com" }, revision, input(), { now })).toThrow("HTTPS");
    expect(() => extractKnowledge({ ...repository, repositoryId: "0" }, revision, input(), { now })).toThrow("repository ID");
    const source = input();
    expect(() => extractKnowledge(repository, revision, { ...source, files: [...source.files, source.files[0]!] }, { now })).toThrow("duplicate");
  });
});
