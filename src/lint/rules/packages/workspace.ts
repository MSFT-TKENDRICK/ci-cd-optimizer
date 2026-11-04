import type { PackageManifest } from "../../parsers/manifest.js";
import type { ProjectModel } from "../../project.js";

const NON_PACKAGE_DIR = /(^|\/)(fixtures?|__fixtures__|examples?|test|tests|__tests__|testdata|e2e)(\/|$)/;

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function stringField(manifest: PackageManifest, key: string): string | undefined {
  const value = manifest.json[key];
  return typeof value === "string" ? value : undefined;
}

/** A package.json that only declares a workspace (root with `workspaces`, or the root of a pnpm/lerna workspace). */
export function isWorkspaceRoot(project: ProjectModel, manifest: PackageManifest): boolean {
  if (manifest.json.workspaces !== undefined) return true;
  return manifest.dir === "" && project.facts.workspaceGlobs.value.length > 0;
}

/**
 * The repository's own package manifests, sorted by path: the root plus workspace packages when the workspace layout is
 * known, otherwise every manifest outside fixture, example, and test directories.
 */
export function packageManifests(project: ProjectModel): PackageManifest[] {
  const { workspacePackages, workspaceGlobs } = project.facts;
  const list =
    workspacePackages.status === "known"
      ? [
          ...(project.rootManifest ? [project.rootManifest] : []),
          ...workspacePackages.value.filter((manifest) => workspaceGlobs.value.length > 0 || !NON_PACKAGE_DIR.test(manifest.dir)),
        ]
      : project.manifests.filter((manifest) => !NON_PACKAGE_DIR.test(manifest.dir));
  return [...new Set(list)].sort((a, b) => a.path.localeCompare(b.path));
}

/** Names of every package declared in the repository. */
export function internalNames(project: ProjectModel): Set<string> {
  return new Set(project.manifests.map((manifest) => manifest.name).filter((name): name is string => name !== undefined));
}

function looseJson(content: string): unknown {
  try {
    return JSON.parse(content.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return undefined;
  }
}

/** Entries a `files` allowlist should contain: the build output directories (or files) the entry points live in. */
export function publishedEntries(project: ProjectModel, manifest: PackageManifest): string[] {
  const paths: string[] = [];
  for (const key of ["main", "module", "types", "typings", "browser"]) {
    const value = stringField(manifest, key);
    if (value) paths.push(value);
  }
  const bin = manifest.json.bin;
  if (typeof bin === "string") paths.push(bin);
  else if (bin && typeof bin === "object") paths.push(...Object.values(bin).filter((value): value is string => typeof value === "string"));
  const entries = new Set<string>();
  for (const path of paths) {
    const clean = path.replace(/^\.?\/+/, "");
    if (!clean || clean.startsWith("..")) continue;
    const [first, ...rest] = clean.split("/");
    if (first) entries.add(rest.length > 0 ? first : clean);
  }
  if (entries.size > 0) return [...entries];
  const tsconfig = looseJson(project.files.get(joinPath(manifest.dir, "tsconfig.json"))?.content ?? "") as
    | { compilerOptions?: { outDir?: unknown } }
    | undefined;
  const outDir = tsconfig?.compilerOptions?.outDir;
  if (typeof outDir === "string") {
    const first = outDir.replace(/^\.?\/+/, "").split("/")[0];
    if (first && !first.startsWith("..")) return [first];
  }
  return ["dist"];
}
