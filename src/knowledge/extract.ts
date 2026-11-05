import { hash, identity, snapshotIdentity, validateRevision, validateScope } from "./identity.js";
import { parseManifest, type PackageManifest } from "../lint/parsers/manifest.js";
import { parseDocument } from "yaml";
import type { AnalysisInput, SourceFile } from "../lint/types.js";
import { matchesGlob } from "../utils.js";
import type { DeclaredSpec, EvidenceSource, KnowledgeSnapshot, ProjectEvidence, ProjectRelationship, RepositoryIdentity, Technology, TechnologyEvidence } from "./types.js";

const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const managers = new Set(["npm", "pnpm", "yarn", "bun"]);
const toolFiles: Record<string, Technology> = {
  "turbo.json": "turborepo", "nx.json": "nx", "lerna.json": "lerna", "rush.json": "rush",
  "MODULE.bazel": "bazel", WORKSPACE: "bazel", "WORKSPACE.bazel": "bazel",
  "pants.toml": "pants", "settings.gradle": "gradle", "settings.gradle.kts": "gradle",
};
const scopes = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const pointer = (part: string): string => part.replaceAll("~", "~0").replaceAll("/", "~1");
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function isKnowledgePath(path: string): boolean {
  if (/(^|\/)node_modules\//.test(path)) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === "package.json" || path === "pnpm-workspace.yaml" || Object.hasOwn(toolFiles, name);
}

function spec(value: string): DeclaredSpec {
  // Preserve common declarations, but never copy arbitrary URLs, credentials or local paths into knowledge.
  const simple = /^(?:[~^]?\d+(?:\.(?:\d+|x|\*)){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|[x*])$/;
  if (value.length <= 256 && simple.test(value)) return { kind: "version-expression", value, digest: hash(value) };
  if (value.length <= 256 && value.startsWith("workspace:") && (["*", "^", "~"].includes(value.slice(10)) || simple.test(value.slice(10)))) {
    return { kind: "workspace-expression", value, digest: hash(value) };
  }
  return { kind: "opaque", digest: hash(value) };
}

function technology(name: string): Technology | undefined {
  if (name === "turbo") return "turborepo";
  if (name === "nx" || name.startsWith("@nx/") || name.startsWith("@nrwl/")) return "nx";
  if (name === "@microsoft/rush") return "rush";
  if (name === "typescript" || name === "lerna") return name;
  return undefined;
}

export function extractKnowledge(
  repository: RepositoryIdentity,
  revision: string,
  input: AnalysisInput,
  options: { ignorePaths?: readonly string[]; truncated?: readonly string[]; inventoryPolicyDigest?: string; now?: Date } = {},
): KnowledgeSnapshot {
  validateScope(repository);
  validateRevision(revision);
  const files = new Map(input.files.map((file) => [file.path, file]));
  if (files.size !== input.files.length) throw new Error("Knowledge inventory contains duplicate paths");
  if ([...files.keys()].some((path) => /[\\:]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..") || [...path].some((char) => char.charCodeAt(0) < 32))) {
    throw new Error("Knowledge inventory paths must be repository-relative");
  }
  const problems: KnowledgeSnapshot["coverage"]["problems"] = [];
  const problemKeys = new Set<string>();
  const problem = (path: string, code: string) => {
    const key = JSON.stringify([path, code]);
    if (!problemKeys.has(key)) { problemKeys.add(key); problems.push({ path, code }); }
  };
  const truncated = new Set(options.truncated ?? []);
  const projects: ProjectEvidence[] = [];
  const technologies: TechnologyEvidence[] = [];
  const relationships: ProjectRelationship[] = [];
  const projectId = (kind: ProjectEvidence["kind"], path: string) => identity([repository.host, repository.repositoryId, kind, path]);
  const root: ProjectEvidence = { id: projectId("repository", ""), kind: "repository", path: "" };
  projects.push(root);
  const manifests = new Map<string, PackageManifest>();
  const digests = new Map<string, string>();
  const source = (file: SourceFile, location = ""): EvidenceSource => {
    if (!digests.has(file.path)) digests.set(file.path, hash(file.content));
    return { path: file.path, pointer: location, digest: digests.get(file.path)! };
  };
  let limited = false;
  const reserve = (path: string) => {
    if (technologies.length + relationships.length < 10_000) return true;
    if (!limited) problem(path, "evidence-limit");
    limited = true;
    return false;
  };
  const addRelationship = (relation: Omit<ProjectRelationship, "id">) => {
    if (reserve(relation.source.path)) relationships.push({ id: identity(relation), ...relation });
  };
  const addTechnology = (fact: Omit<TechnologyEvidence, "id">) => {
    if (reserve(fact.source.path)) technologies.push({ id: identity(fact), ...fact });
  };

  const orderedFiles = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const file of orderedFiles) {
    if (limited) break;
    if (file.path !== "package.json" && !file.path.endsWith("/package.json")) continue;
    if (/(^|\/)node_modules\//.test(file.path)) continue;
    if (truncated.has(file.path)) { problem(file.path, "truncated-manifest"); continue; }
    let manifest: PackageManifest;
    try { manifest = parseManifest(file.path, file.content); }
    catch { problem(file.path, "invalid-manifest"); continue; }
    manifests.set(file.path, manifest);
    const named = manifest.name && packageName.test(manifest.name) ? manifest.name : undefined;
    if (manifest.json.name !== undefined && !named) problem(file.path, "invalid-package-name");
    const project: ProjectEvidence = { id: projectId("npm-package", manifest.dir), kind: "npm-package", path: manifest.dir, ...(named ? { name: named } : {}) };
    projects.push(project);
    addRelationship({ kind: "contains", from: root.id, to: project.id, source: source(file) });
  }

  const rootPackage = projects.find((project) => project.kind === "npm-package" && project.path === "") ?? root;
  const workspaceSets: Set<string>[] = [];
  const addWorkspace = (raw: unknown, file: SourceFile, location: string) => {
    if (!Array.isArray(raw) || raw.some((glob) => typeof glob !== "string" || !glob.replace(/^!/, "") ||
      [...glob].some((char) => char.charCodeAt(0) < 32) || /[[\]{}()\\]|(^|\/)\.\.(\/|$)|^\//.test(glob.replace(/^!/, "")))) {
      problem(file.path, "unsupported-workspace-patterns");
      return;
    }
    const patterns = raw as string[];
    const selected = new Set<string>([rootPackage.id]);
    for (const project of projects) {
      if (project.kind !== "npm-package" || !project.path) continue;
      const matches = (glob: string) => matchesGlob(project.path, glob.replace(/^\.\//, "").replace(/\/$/, ""));
      if (!patterns.some((glob) => !glob.startsWith("!") && matches(glob)) || patterns.some((glob) => glob.startsWith("!") && matches(glob.slice(1)))) continue;
      selected.add(project.id);
      addRelationship({ kind: "workspace-member", from: rootPackage.id, to: project.id, source: source(file, location) });
    }
    workspaceSets.push(selected);
  };
  const rootManifest = manifests.get("package.json");
  if (rootManifest?.json.workspaces !== undefined) {
    const workspaces = rootManifest.json.workspaces;
    addWorkspace(record(workspaces) ? workspaces.packages : workspaces, files.get("package.json")!, record(workspaces) ? "/workspaces/packages" : "/workspaces");
  }
  const pnpm = files.get("pnpm-workspace.yaml");
  if (pnpm && truncated.has(pnpm.path)) problem(pnpm.path, "truncated-workspace-config");
  else if (pnpm) {
    try {
      const parsed = parseDocument(pnpm.content, { uniqueKeys: true });
      if (parsed.errors.length) throw new Error("Invalid workspace YAML");
      const value: unknown = parsed.toJS();
      addWorkspace(record(value) ? value.packages : undefined, pnpm, "/packages");
    } catch { problem(pnpm.path, "invalid-workspace-config"); }
  }
  const workspace = workspaceSets[0];
  const conflicting = workspaceSets.some((set) => JSON.stringify([...set].sort()) !== JSON.stringify([...(workspace ?? [])].sort()));
  if (conflicting) problem("", "conflicting-workspaces");
  const canResolveWorkspace = input.mode === "repository" && input.inventoryComplete && truncated.size === 0 &&
    !options.ignorePaths?.length && !conflicting && problems.length === 0;
  const workspaceNames = new Map<string, ProjectEvidence[]>();
  for (const project of projects) {
    if (project.name && workspace?.has(project.id)) {
      const candidates = workspaceNames.get(project.name) ?? [];
      candidates.push(project);
      workspaceNames.set(project.name, candidates);
    }
  }

  for (const [path, manifest] of manifests) {
    if (limited) break;
    const file = files.get(path)!;
    const id = projectId("npm-package", manifest.dir);
    for (const scope of scopes) {
      const declarations = manifest.json[scope];
      if (declarations === undefined) continue;
      if (!record(declarations)) { problem(path, `invalid-${scope}`); continue; }
      for (const [name, value] of Object.entries(declarations).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        if (limited) break;
        if (!packageName.test(name) || typeof value !== "string") { problem(path, `invalid-${scope}-entry`); continue; }
        const declaration = spec(value);
        const origin = source(file, `/${scope}/${pointer(name)}`);
        const candidates = declaration.kind === "workspace-expression" && canResolveWorkspace && workspace?.has(id)
          ? workspaceNames.get(name) ?? [] : [];
        addRelationship({
          kind: "declares-dependency", from: id, targetName: name, scope, spec: declaration, source: origin,
          resolution: candidates.length === 1 ? "workspace-name" : candidates.length > 1 ? "ambiguous" : "unresolved",
          ...(candidates.length === 1 ? { to: candidates[0]!.id } : {}),
        });
        const tool = technology(name);
        if (tool) addTechnology({ projectId: id, technology: tool, basis: "dependency", spec: declaration, source: origin });
      }
    }
    const manager = manifest.json.packageManager;
    if (manager !== undefined) {
      const match = typeof manager === "string" ? /^(npm|pnpm|yarn|bun)@(.+)$/.exec(manager) : null;
      if (match) addTechnology({ projectId: id, technology: match[1] as Technology, basis: "package-manager", spec: spec(match[2]!), source: source(file, "/packageManager") });
      else problem(path, "unsupported-package-manager");
    }
    const engines = manifest.json.engines;
    if (engines !== undefined && !record(engines)) problem(path, "invalid-engines");
    else if (record(engines)) for (const [name, value] of Object.entries(engines)) {
      if (name !== "node" && !managers.has(name)) continue;
      if (typeof value !== "string") { problem(path, "invalid-engine-entry"); continue; }
      addTechnology({ projectId: id, technology: name as Technology, basis: "engine", spec: spec(value), source: source(file, `/engines/${pointer(name)}`) });
    }
  }
  for (const file of orderedFiles) {
    if (limited) break;
    if (/(^|\/)node_modules\//.test(file.path)) continue;
    const slash = file.path.lastIndexOf("/");
    const basename = file.path.slice(slash + 1);
    const tool = Object.hasOwn(toolFiles, basename) ? toolFiles[basename] : undefined;
    if (!tool) continue;
    const dir = slash < 0 ? "" : file.path.slice(0, slash);
    let project = dir === "" ? rootPackage : projects.find((project) => project.path === dir);
    if (!project) {
      project = { id: projectId("configuration-root", dir), kind: "configuration-root", path: dir };
      projects.push(project);
      addRelationship({ kind: "contains", from: root.id, to: project.id, source: source(file) });
    }
    addTechnology({ projectId: project.id, technology: tool, basis: "configuration-file", source: source(file) });
  }
  const byId = <T extends { id: string }>(items: T[]): T[] => items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const snapshot: Omit<KnowledgeSnapshot, "id"> = {
    version: 1, repository: { ...repository }, revision, collectedAt: (options.now ?? new Date()).toISOString(),
    coverage: {
      scope: "configured-node-manifests-and-tool-configs",
      inventoryComplete: input.mode === "repository" && input.inventoryComplete,
      ...(options.inventoryPolicyDigest ? { inventoryPolicyDigest: options.inventoryPolicyDigest } : {}),
      declarationsComplete: problems.length === 0 && truncated.size === 0,
      ignorePaths: [...new Set(options.ignorePaths ?? [])].sort(), truncated: [...truncated].sort(),
      problems: problems.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0),
    },
    projects: byId(projects), technologies: byId(technologies), relationships: byId(relationships),
  };
  return { id: snapshotIdentity(snapshot), ...snapshot };
}

export function technologyStatus(snapshot: KnowledgeSnapshot, projectId: string, technology: Technology) {
  if (!snapshot.projects.some((project) => project.id === projectId)) throw new Error("Project does not belong to this knowledge snapshot");
  const evidence = snapshot.technologies.filter((fact) => fact.projectId === projectId && fact.technology === technology);
  return {
    scope: "direct-project-declarations" as const,
    status: evidence.length ? "observed" as const : snapshot.coverage.inventoryComplete && snapshot.coverage.declarationsComplete && snapshot.coverage.ignorePaths.length === 0 ? "not-observed" as const : "unknown" as const,
    evidence,
  };
}
