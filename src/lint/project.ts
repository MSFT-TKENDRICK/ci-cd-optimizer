import { matchesGlob } from "../utils.js";
import { isDockerfilePath, parseDockerfile, type DockerfileModel } from "./parsers/dockerfile.js";
import { isManifestPath, parseManifest, type PackageManifest } from "./parsers/manifest.js";
import {
  isActionPath,
  isWorkflowPath,
  parseWorkflow,
  type JobModel,
  type StepModel,
  type WorkflowModel,
} from "./parsers/workflow.js";
import { parseErrors, parseYaml } from "./parsers/yaml.js";
import type { AnalysisInput, ParseProblem, SourceFile } from "./types.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type MonorepoTool = "nx" | "turbo" | "lerna" | "rush" | "bazel" | "pants" | "gradle";

export interface Fact<T> {
  status: "known" | "unknown";
  value: T;
}

export interface ProjectFacts {
  packageManager: Fact<PackageManager | undefined>;
  monorepoTools: Fact<MonorepoTool[]>;
  workspaceGlobs: Fact<string[]>;
  workspacePackages: Fact<PackageManifest[]>;
  isMonorepo: Fact<boolean>;
  lockfiles: string[];
  dockerignoreDirs: Set<string>;
}

export interface ProjectModel {
  files: Map<string, SourceFile>;
  workflows: WorkflowModel[];
  actions: WorkflowModel[];
  dockerfiles: DockerfileModel[];
  manifests: PackageManifest[];
  rootManifest?: PackageManifest;
  facts: ProjectFacts;
  parseProblems: ParseProblem[];
  /** Resolves a local `uses: ./path` action to its parsed action.yml, if present. */
  localAction(ref: string): WorkflowModel | undefined;
  /** Steps of a job with local composite actions expanded (bounded depth, cycle safe). */
  expandedSteps(job: JobModel): StepModel[];
}

const LOCKFILES: Record<string, PackageManager> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
  "bun.lock": "bun",
};

const TOOL_FILES: Record<string, MonorepoTool> = {
  "nx.json": "nx",
  "turbo.json": "turbo",
  "lerna.json": "lerna",
  "rush.json": "rush",
  "MODULE.bazel": "bazel",
  WORKSPACE: "bazel",
  "WORKSPACE.bazel": "bazel",
  "pants.toml": "pants",
  "settings.gradle": "gradle",
  "settings.gradle.kts": "gradle",
};

function known<T>(value: T): Fact<T> {
  return { status: "known", value };
}

function unknown<T>(value: T): Fact<T> {
  return { status: "unknown", value };
}

function workspaceGlobsFrom(root: PackageManifest | undefined, files: Map<string, SourceFile>): string[] {
  const globs: string[] = [];
  const workspaces = root?.json.workspaces;
  if (Array.isArray(workspaces)) globs.push(...workspaces.map(String));
  else if (workspaces && typeof workspaces === "object") {
    const packages = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(packages)) globs.push(...packages.map(String));
  }
  const pnpm = files.get("pnpm-workspace.yaml");
  if (pnpm) {
    const parsed = parseYaml(pnpm.path, pnpm.content).doc.toJS() as { packages?: unknown } | null;
    if (Array.isArray(parsed?.packages)) globs.push(...parsed.packages.map(String));
  }
  const lerna = files.get("lerna.json");
  if (lerna) {
    try {
      const parsed = JSON.parse(lerna.content) as { packages?: unknown };
      if (Array.isArray(parsed.packages)) globs.push(...parsed.packages.map(String));
    } catch {
      // Ignore malformed lerna.json; facts stay conservative.
    }
  }
  return [...new Set(globs.filter((glob) => !glob.startsWith("!")))];
}

export function buildProject(input: AnalysisInput): ProjectModel {
  const files = new Map(input.files.map((file) => [file.path, file]));
  const parseProblems: ParseProblem[] = [];
  const workflows: WorkflowModel[] = [];
  const actions: WorkflowModel[] = [];
  const dockerfiles: DockerfileModel[] = [];
  const manifests: PackageManifest[] = [];

  for (const file of input.files) {
    try {
      if (isWorkflowPath(file.path) || isActionPath(file.path)) {
        const model = parseWorkflow(file.path, file.content);
        for (const problem of parseErrors(model.source)) {
          parseProblems.push({ path: file.path, ...problem });
        }
        if (model.kind === "workflow") workflows.push(model);
        else actions.push(model);
      } else if (isDockerfilePath(file.path)) {
        dockerfiles.push(parseDockerfile(file.path, file.content));
      } else if (isManifestPath(file.path) && !file.path.includes("node_modules/")) {
        manifests.push(parseManifest(file.path, file.content));
      }
    } catch (error) {
      parseProblems.push({
        path: file.path,
        line: 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const repository = input.mode === "repository";
  const complete = repository && input.inventoryComplete;
  const rootManifest = manifests.find((manifest) => manifest.dir === "");
  const lockfiles = input.files.map((file) => file.path).filter((path) => (path.split("/").pop() ?? "") in LOCKFILES);
  const rootLock = lockfiles.find((path) => !path.includes("/"));
  const declaredManager =
    typeof rootManifest?.json.packageManager === "string"
      ? (rootManifest.json.packageManager.split("@")[0] as PackageManager)
      : undefined;
  const packageManager = declaredManager ?? (rootLock ? LOCKFILES[rootLock] : undefined);
  const tools = [
    ...new Set(
      input.files
        .map((file) => TOOL_FILES[file.path])
        .filter((tool): tool is MonorepoTool => tool !== undefined),
    ),
  ];
  const globs = workspaceGlobsFrom(rootManifest, files);
  const workspacePackages = manifests.filter(
    (manifest) =>
      manifest.dir !== "" &&
      (globs.length > 0
        ? globs.some((glob) => matchesGlob(manifest.dir, glob) || matchesGlob(`${manifest.dir}/`, glob))
        : tools.length > 0),
  );
  const isMonorepo = globs.length > 0 || tools.includes("nx") || tools.includes("turbo") || tools.includes("lerna") || tools.includes("rush") || tools.includes("bazel") || tools.includes("pants");

  const dockerignoreDirs = new Set(
    input.files
      .filter((file) => /(^|\/)\.dockerignore$/.test(file.path) || /\.dockerignore$/.test(file.path))
      .map((file) => {
        const slash = file.path.lastIndexOf("/");
        return slash >= 0 ? file.path.slice(0, slash) : "";
      }),
  );

  const actionByDir = new Map<string, WorkflowModel>();
  for (const action of actions) {
    const slash = action.path.lastIndexOf("/");
    actionByDir.set(slash >= 0 ? action.path.slice(0, slash) : "", action);
  }

  const localAction = (ref: string): WorkflowModel | undefined => {
    const normalized = ref.replace(/^\.\//, "").replace(/\/$/, "");
    return actionByDir.get(normalized);
  };

  const expand = (steps: StepModel[], depth: number, seen: Set<string>): StepModel[] =>
    steps.flatMap((step) => {
      const ref = step.uses?.action;
      if (ref?.kind !== "local" || depth >= 5) return [step];
      const action = localAction(ref.raw);
      if (!action || action.kind !== "composite-action" || seen.has(action.path)) return [step];
      const nested = action.jobs[0]?.steps ?? [];
      return [step, ...expand(nested, depth + 1, new Set([...seen, action.path]))];
    });

  return {
    files,
    workflows,
    actions,
    dockerfiles,
    manifests,
    ...(rootManifest ? { rootManifest } : {}),
    facts: {
      packageManager: packageManager || complete ? known(packageManager) : unknown(packageManager),
      monorepoTools: complete || tools.length > 0 ? known(tools) : unknown(tools),
      workspaceGlobs: repository ? known(globs) : unknown(globs),
      workspacePackages: repository ? known(workspacePackages) : unknown(workspacePackages),
      isMonorepo: isMonorepo || repository ? known(isMonorepo) : unknown(false),
      lockfiles,
      dockerignoreDirs,
    },
    parseProblems,
    localAction,
    expandedSteps: (job) => expand(job.steps, 0, new Set()),
  };
}
