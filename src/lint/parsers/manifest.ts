export interface PackageManifest {
  path: string;
  dir: string;
  json: Record<string, unknown>;
  name?: string;
  private: boolean;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  lineOf(key: string): number;
}

export function isManifestPath(path: string): boolean {
  return /(^|\/)package\.json$/i.test(path);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** Parses package.json strictly as JSON (JSON.parse) and resolves key lines by text search. */
export function parseManifest(path: string, content: string): PackageManifest {
  const json = JSON.parse(content) as unknown;
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("package.json must contain a JSON object");
  }
  const record = json as Record<string, unknown>;
  const lines = content.split(/\r?\n/);
  const slash = path.lastIndexOf("/");
  return {
    path,
    dir: slash >= 0 ? path.slice(0, slash) : "",
    json: record,
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    private: record.private === true,
    dependencies: stringRecord(record.dependencies),
    devDependencies: stringRecord(record.devDependencies),
    lineOf(key: string): number {
      const pattern = new RegExp(`^\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`);
      const index = lines.findIndex((line) => pattern.test(line));
      return index >= 0 ? index + 1 : 1;
    },
  };
}
