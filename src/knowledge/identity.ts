import { createHash } from "node:crypto";
import type { KnowledgeScope, KnowledgeSnapshot } from "./types.js";
import type { LintConfig } from "../lint/config.js";

export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export const identity = (value: unknown): string => hash(JSON.stringify(canonical(value)));

export const inventoryPolicyDigest = (config: Pick<LintConfig, "ignorePaths" | "limits">): string =>
  identity(["knowledge-inventory-v2", [...new Set(config.ignorePaths)].sort(), config.limits]);

export function validateScope(scope: KnowledgeScope): void {
  const host = new URL(scope.host);
  if (host.protocol !== "https:" || host.origin !== scope.host || !/^[1-9]\d*$/.test(scope.repositoryId)) {
    throw new Error("Knowledge scope requires a canonical HTTPS origin and a positive repository ID");
  }
}

export function validateRevision(revision: string): void {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision)) throw new Error("Knowledge requires an immutable commit SHA");
}

export function snapshotIdentity(snapshot: Omit<KnowledgeSnapshot, "id"> | KnowledgeSnapshot): string {
  return identity({
    version: snapshot.version, repository: snapshot.repository, revision: snapshot.revision, coverage: snapshot.coverage,
    projects: snapshot.projects, technologies: snapshot.technologies, relationships: snapshot.relationships,
  });
}
