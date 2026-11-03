import type { RepositoryFile } from "./types.js";

export function lineOf(content: string, needle: string): number | undefined {
  const index = content.indexOf(needle);
  if (index < 0) return undefined;
  return content.slice(0, index).split("\n").length;
}

export function workflowFiles(files: RepositoryFile[]): RepositoryFile[] {
  return files.filter(
    (file) =>
      file.path.startsWith(".github/workflows/") &&
      (file.path.endsWith(".yml") || file.path.endsWith(".yaml")),
  );
}

export function dockerfiles(files: RepositoryFile[]): RepositoryFile[] {
  return files.filter((file) => /(^|\/)Dockerfile(?:\.[^/]+)?$/i.test(file.path));
}

export function hasAnyFile(files: RepositoryFile[], patterns: RegExp[]): boolean {
  return files.some((file) => patterns.some((pattern) => pattern.test(file.path)));
}

export function matchesGlob(path: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".");
  return new RegExp(`^${regex}$`).test(path);
}
