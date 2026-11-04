import { fix, indentOf, insertLinesAfter, lineText } from "../../fix.js";
import type { StepModel, WorkflowModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import type { Fix, SourceFile } from "../../types.js";
import { commandsOf, defineRule } from "../helpers.js";
import { anyUses, basename, cacheCovers, isFalse, listOf, usesAction } from "./shared.js";

type Manager = "npm" | "pnpm" | "yarn" | "pip" | "poetry" | "pipenv" | "uv" | "maven" | "gradle" | "sbt" | "go" | "nuget";

const LABEL: Record<Manager, string> = {
  npm: "npm",
  pnpm: "pnpm",
  yarn: "Yarn",
  pip: "pip",
  poetry: "Poetry",
  pipenv: "Pipenv",
  uv: "uv",
  maven: "Maven",
  gradle: "Gradle",
  sbt: "sbt",
  go: "Go module",
  nuget: "NuGet",
};

/** Paths and key fragments that show an existing cache step already covers a package manager's cache. */
const COVERAGE: Record<Manager, { path: RegExp; key: RegExp }> = {
  npm: { path: /(^|\/)\.npm(\/|$)|npm-cache|node_modules/i, key: /package-lock|npm-shrinkwrap/i },
  pnpm: { path: /pnpm|node_modules/i, key: /pnpm-lock/i },
  yarn: { path: /yarn|node_modules/i, key: /yarn\.lock/i },
  pip: { path: /pip|venv/i, key: /requirements/i },
  poetry: { path: /poetry|venv/i, key: /poetry\.lock/i },
  pipenv: { path: /pipenv|virtualenvs|venv/i, key: /pipfile/i },
  uv: { path: /(^|\/)uv(\/|$)|venv/i, key: /uv\.lock/i },
  maven: { path: /\.m2|maven/i, key: /pom\.xml/i },
  gradle: { path: /gradle/i, key: /gradle/i },
  sbt: { path: /ivy|sbt|coursier/i, key: /build\.sbt/i },
  go: { path: /go-build|go\/pkg\/mod|(^|\/)go(\/|$)/i, key: /go\.(sum|mod)/i },
  nuget: { path: /nuget/i, key: /packages\.lock\.json|csproj/i },
};

const NODE_LOCKFILES: Record<string, Manager> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
};

interface Finding {
  managers: Manager[];
  /** Value to insert as `cache:`; undefined when no safe autofix exists. */
  fixValue?: string;
  message: string;
  suggestion: string;
  line?: number;
  impact?: "low";
}

function covered(steps: StepModel[], manager: Manager): boolean {
  if (manager === "gradle" && anyUses(steps, "gradle/actions/setup-gradle", "gradle/gradle-build-action")) return true;
  if (manager === "uv" && anyUses(steps, "astral-sh/setup-uv")) return true;
  if (["npm", "pnpm", "yarn"].includes(manager) && anyUses(steps, "bahmutov/npm-install")) return true;
  return cacheCovers(steps, COVERAGE[manager].path, COVERAGE[manager].key);
}

/** Major version of the action from its ref, or from a `# vX.Y.Z` comment when SHA-pinned. */
function actionMajor(step: StepModel, file: SourceFile | undefined): number | undefined {
  const uses = step.uses;
  if (!uses) return undefined;
  if (uses.action.shaPinned) {
    const comment = file ? /#\s*v?(\d+)/.exec(lineText(file.content, uses.line)) : null;
    return comment?.[1] ? Number(comment[1]) : undefined;
  }
  const match = /^v?(\d+)(\.\d+)*$/.exec(uses.action.ref ?? "");
  return match?.[1] ? Number(match[1]) : undefined;
}

function filePaths(project: ProjectModel): string[] {
  return [...project.files.keys()].filter((path) => !/(^|\/)node_modules\//.test(path));
}

function declaredNodeManager(project: ProjectModel): string | undefined {
  const json = project.rootManifest?.json;
  if (!json) return undefined;
  if (typeof json.packageManager === "string") return json.packageManager;
  const devEngines = json.devEngines as { packageManager?: { name?: unknown } } | undefined;
  return typeof devEngines?.packageManager?.name === "string" ? `${devEngines.packageManager.name}@` : undefined;
}

function earlierCommands(before: StepModel[]): string[] {
  return before.flatMap((step) => commandsOf(step).map((entry) => entry.command));
}

function literalWith(step: StepModel, key: string): string | undefined {
  const entry = step.with.get(key);
  return entry && entry.kind === "literal" && entry.value !== null && entry.value !== undefined ? String(entry.value) : undefined;
}

function checkNode(project: ProjectModel, step: StepModel, before: StepModel[], all: StepModel[], file: SourceFile | undefined): Finding | undefined {
  if (step.with.has("cache")) return undefined;
  const lockfiles = project.facts.lockfiles.filter((path) => basename(path) in NODE_LOCKFILES && !path.includes("node_modules/"));
  if (lockfiles.length === 0) return undefined;
  const dependencyPathEntry = step.with.get("cache-dependency-path");
  const dependencyPath = literalWith(step, "cache-dependency-path");
  const fromDependencyPath = dependencyPath ? NODE_LOCKFILES[basename(listOf(dependencyPath)[0] ?? "")] : undefined;
  const rootLock = lockfiles.find((path) => !path.includes("/"));
  const nestedManagers = new Set(lockfiles.map((path) => NODE_LOCKFILES[basename(path)]));
  const manager: Manager | undefined =
    fromDependencyPath ?? (rootLock ? NODE_LOCKFILES[rootLock] : nestedManagers.size === 1 ? [...nestedManagers][0] : undefined);
  if (!manager) {
    if (dependencyPathEntry && dependencyPathEntry.kind !== "literal") return undefined;
    return {
      managers: ["npm", "pnpm", "yarn"],
      message: "`actions/setup-node` does not cache dependencies although lockfiles exist.",
      suggestion: "Add `cache: <npm|pnpm|yarn>` with a `cache-dependency-path` pointing at the lockfile(s).",
    };
  }
  if (covered(all, manager)) return undefined;
  const declared = declaredNodeManager(project);
  const major = actionMajor(step, file);
  if (manager === "npm" && declared?.startsWith("npm@") && (major === undefined || major >= 6)) return undefined;
  if (isFalse(step.with.get("package-manager-cache")?.value)) return undefined;
  const hasDependencyPath = dependencyPathEntry !== undefined;
  const commands = earlierCommands(before);
  let fixable = hasDependencyPath || rootLock !== undefined;
  if (manager === "pnpm") {
    fixable &&=
      anyUses(before, "pnpm/action-setup") ||
      commands.some((command) => /^corepack\s+enable\b/.test(command) || /^npm\s+(i|install)\s+(-g|--global)\b.*\bpnpm\b/.test(command));
  } else if (manager === "yarn") {
    fixable &&= declared === undefined || declared.startsWith("yarn@1") || commands.some((command) => /^corepack\s+enable\b/.test(command));
  }
  const location = rootLock ?? lockfiles.find((path) => NODE_LOCKFILES[basename(path)] === manager) ?? "";
  const extra = hasDependencyPath || rootLock ? "" : ` and \`cache-dependency-path: ${location}\``;
  const order = manager === "pnpm" && !fixable ? " (pnpm must be installed before setup-node, e.g. with pnpm/action-setup)" : "";
  return {
    managers: [manager],
    ...(fixable ? { fixValue: manager } : {}),
    message: `\`actions/setup-node\` does not cache ${LABEL[manager]} dependencies (${basename(location)} found).`,
    suggestion: `Add \`cache: ${manager}\`${extra} to the step's \`with:\`${order} so the package download cache is restored between runs.`,
  };
}

function checkPython(project: ProjectModel, step: StepModel, before: StepModel[], all: StepModel[]): Finding | undefined {
  if (step.with.has("cache")) return undefined;
  const paths = filePaths(project);
  const names = paths.map(basename);
  const managers = new Set<Manager>();
  if (names.includes("poetry.lock")) managers.add("poetry");
  if (names.includes("Pipfile.lock")) managers.add("pipenv");
  if (names.includes("uv.lock") && !anyUses(all, "astral-sh/setup-uv")) managers.add("uv");
  if (paths.some((path) => /^requirements.*\.txt$/i.test(basename(path)) || /(^|\/)requirements\/[^/]+\.txt$/i.test(path))) managers.add("pip");
  const list = [...managers];
  if (list.length === 0 || list.some((manager) => covered(all, manager))) return undefined;
  if (list.length > 1) {
    return {
      managers: list,
      message: "`actions/setup-python` does not cache dependencies (caching is off by default).",
      suggestion: `Set \`cache:\` to the installer this job uses (${list.join(", ")}).`,
    };
  }
  const manager = list[0] as Manager;
  if (manager === "uv") {
    return {
      managers: list,
      message: "`actions/setup-python` does not cache dependencies, and uv.lock is present.",
      suggestion: "Use `astral-sh/setup-uv` (with `enable-cache: true`) to install uv and cache its downloads.",
    };
  }
  const hasDependencyPath = step.with.has("cache-dependency-path");
  let fixable = false;
  if (manager === "pip") fixable = hasDependencyPath || names.includes("requirements.txt");
  if (manager === "poetry") {
    fixable =
      anyUses(before, "snok/install-poetry", "abatilo/actions-poetry") ||
      earlierCommands(before).some((command) => /^(pipx|pip3?|python3?\s+-m\s+pip)\s+install\b.*\bpoetry\b/.test(command));
  }
  const order = manager === "poetry" && !fixable ? " (Poetry must be installed before setup-python, e.g. `pipx install poetry`)" : "";
  return {
    managers: list,
    ...(fixable ? { fixValue: manager } : {}),
    message: `\`actions/setup-python\` does not cache ${LABEL[manager]} dependencies (caching is off by default).`,
    suggestion: `Add \`cache: ${manager}\` to the step's \`with:\`${order}.`,
  };
}

function checkJava(project: ProjectModel, step: StepModel, all: StepModel[]): Finding | undefined {
  if (step.with.has("cache")) return undefined;
  const names = new Set(filePaths(project).map(basename));
  const managers: Manager[] = [];
  if (names.has("pom.xml")) managers.push("maven");
  if (["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].some((name) => names.has(name))) managers.push("gradle");
  if (names.has("build.sbt")) managers.push("sbt");
  if (managers.length === 0 || managers.some((manager) => covered(all, manager))) return undefined;
  const manager = managers.length === 1 ? managers[0] : undefined;
  return {
    managers,
    ...(manager ? { fixValue: manager } : {}),
    message: `\`actions/setup-java\` does not cache ${manager ? LABEL[manager] : "build tool"} dependencies.`,
    suggestion:
      manager === "gradle"
        ? "Add `cache: gradle`, or use `gradle/actions/setup-gradle`, which also caches the Gradle build cache."
        : `Add \`cache: ${manager ?? managers.join("|")}\` to the step's \`with:\`.`,
  };
}

function checkGo(step: StepModel, all: StepModel[]): Finding | undefined {
  const cache = step.with.get("cache");
  if (!cache || !isFalse(cache.value) || covered(all, "go")) return undefined;
  return {
    managers: ["go"],
    line: cache.line,
    impact: "low",
    message: "`actions/setup-go` caching is explicitly disabled with `cache: false`.",
    suggestion: "Remove `cache: false` (setup-go caches modules and build outputs by default) unless another step caches them.",
  };
}

function checkDotnet(project: ProjectModel, step: StepModel, all: StepModel[]): Finding | undefined {
  if (step.with.has("cache")) return undefined;
  if (!filePaths(project).some((path) => basename(path) === "packages.lock.json") || covered(all, "nuget")) return undefined;
  return {
    managers: ["nuget"],
    message: "`actions/setup-dotnet` does not cache NuGet packages although packages.lock.json exists.",
    suggestion: "Add `cache: true` (and `cache-dependency-path` if the lock files are not found by the default glob).",
  };
}

/** Inserts `cache: <value>` before the first entry of a direct, block-style `with:` mapping. */
function cacheFix(file: SourceFile | undefined, step: StepModel, value: string): Fix | undefined {
  if (!file) return undefined;
  const direct = [...step.with.values()].filter((entry) => entry.origin === "direct" && entry.line > step.line);
  if (direct.length === 0 || direct.length !== step.with.size) return undefined;
  const first = Math.min(...direct.map((entry) => entry.line));
  const text = lineText(file.content, first);
  if (!/^\s*[A-Za-z0-9_-]+\s*:/.test(text) || /[{}]/.test(text)) return undefined;
  let withLine: number | undefined;
  for (let line = first - 1; line >= step.line; line -= 1) {
    const candidate = lineText(file.content, line);
    if (/^\s*(-\s+)?with\s*:\s*(#.*)?$/.test(candidate)) {
      withLine = line;
      break;
    }
    if (candidate.trim() !== "" && !candidate.trim().startsWith("#")) return undefined;
  }
  if (withLine === undefined) return undefined;
  return fix(`Add \`cache: ${value}\``, insertLinesAfter(file, first - 1, [`${indentOf(file.content, first)}cache: ${value}`]));
}

export default defineRule({
  meta: {
    id: "caching/setup-cache",
    ruleset: "caching",
    description: "Language setup actions should cache downloaded dependencies.",
    rationale:
      "Without caching, every run re-downloads all dependencies from the registry, which is often the slowest part of a job and is repeated on every agent iteration. setup-node, setup-python, setup-java and setup-dotnet only cache when `cache` is set (setup-node v6+ auto-caches npm only when package.json `packageManager` names npm); setup-go caches by default.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/actions/setup-node#caching-global-packages-data",
      "https://github.com/actions/setup-python#caching-packages-dependencies",
      "https://github.com/actions/setup-java#caching-packages-dependencies",
      "https://github.com/actions/setup-go#caching-dependency-files-and-build-outputs",
      "https://github.com/actions/setup-dotnet#caching-nuget-packages",
    ],
    impact: "high",
    fixable: true,
    example: {
      bad: "- uses: actions/setup-node@v7\n  with:\n    node-version: 22",
      good: "- uses: actions/setup-node@v7\n  with:\n    cache: npm\n    node-version: 22",
    },
  },
  check({ project, report }) {
    const scan = (workflow: WorkflowModel) => {
      const file = project.files.get(workflow.path);
      for (const job of workflow.jobs) {
        const all = project.expandedSteps(job);
        for (const step of job.steps) {
          const before = all.slice(0, Math.max(0, all.indexOf(step)));
          let finding: Finding | undefined;
          if (usesAction(step, "actions/setup-node")) finding = checkNode(project, step, before, all, file);
          else if (usesAction(step, "actions/setup-python")) finding = checkPython(project, step, before, all);
          else if (usesAction(step, "actions/setup-java")) finding = checkJava(project, step, all);
          else if (usesAction(step, "actions/setup-go")) finding = checkGo(step, all);
          else if (usesAction(step, "actions/setup-dotnet")) finding = checkDotnet(project, step, all);
          if (!finding) continue;
          const autofix = finding.fixValue ? cacheFix(file, step, finding.fixValue) : undefined;
          report({
            path: workflow.path,
            line: finding.line ?? step.uses?.line ?? step.line,
            key: `${step.key}:no-cache`,
            message: finding.message,
            suggestion: finding.suggestion,
            ...(finding.impact ? { impact: finding.impact } : {}),
            ...(autofix ? { fix: autofix } : {}),
          });
        }
      }
    };
    for (const workflow of [...project.workflows, ...project.actions]) scan(workflow);
  },
});
