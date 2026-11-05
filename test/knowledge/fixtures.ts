import type { AnalysisInput } from "../../src/lint/types.js";
import { extractKnowledge } from "../../src/knowledge/extract.js";

export const repository = { host: "https://github.com", repositoryId: "42", owner: "acme", repo: "widgets" };
export const revision = "a".repeat(40);
export const now = new Date("2026-11-01T12:00:00.000Z");
export const files = {
  "package.json": { name: "root", workspaces: ["packages/*"], devDependencies: { turbo: "^2.0.0" }, packageManager: "pnpm@10.0.0" },
  "packages/a/package.json": { name: "@acme/a", dependencies: { "@acme/b": "workspace:*" } },
  "packages/b/package.json": { name: "@acme/b", devDependencies: { "@nx/js": "^20.0.0" } },
};
export const input = (values: Record<string, unknown> = files): AnalysisInput => ({
  files: Object.entries(values).map(([path, content]) => ({ path, content: typeof content === "string" ? content : JSON.stringify(content) })),
  mode: "repository", inventoryComplete: true,
});
export const snapshot = () => extractKnowledge(repository, revision, input(), { now });
