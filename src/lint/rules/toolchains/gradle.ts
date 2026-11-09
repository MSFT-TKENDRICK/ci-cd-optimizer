import type { ProjectModel } from "../../project.js";
import type { Location, SourceFile } from "../../types.js";
import { basename } from "../caching/shared.js";
import type { JobCommand } from "../helpers.js";
import {
  commandDirectory,
  dirname,
  inDir,
  jobContexts,
  joinPath,
  parseProperties,
  words,
  type JobContext,
  type PropertyEntry,
} from "./shared.js";

const EXECUTABLES = new Set(["gradlew", "gradlew.bat", "gradle"]);
const SHELLS = new Set(["bash", "sh", "cmd", "pwsh"]);
const HELP_TASKS = new Set(["help", "tasks", "wrapper", "projects", "properties", "dependencies", "dependencyinsight", "buildenvironment", "javatoolchains", "outgoingvariants"]);
const HELP_FLAGS = new Set(["--version", "-v", "--stop", "--status", "-h", "--help", "-?", "--dry-run", "-m"]);
/** Options that take the next word as their value. */
const VALUE_OPTIONS = new Set([
  "-p",
  "--project-dir",
  "-x",
  "--exclude-task",
  "-I",
  "--init-script",
  "-g",
  "--gradle-user-home",
  "-c",
  "--settings-file",
  "-b",
  "--build-file",
  "--console",
  "--warning-mode",
  "--max-workers",
  "--include-build",
  "--priority",
  "-F",
  "--dependency-verification",
  "-M",
  "--write-verification-metadata",
  "--tests",
  "--update-locks",
  "--project-cache-dir",
  "--gradle-version",
  "--distribution-type",
  "--gradle-distribution-url",
  "--gradle-distribution-sha256-sum",
  "--configuration",
  "--dependency",
]);
/** Options that point Gradle at build logic this rule cannot see. */
const OPAQUE_OPTIONS = new Set(["-c", "--settings-file", "-b", "--build-file", "-I", "--init-script"]);

export interface GradleInvocation {
  ctx: JobContext;
  command: JobCommand;
  /** Basename of the launcher: `gradlew`, `gradlew.bat` or `gradle`. */
  executable: string;
  /** Option words (each with any `=value` attached; separated values are not included). */
  options: string[];
  tasks: string[];
}

export interface GradleBuild {
  /** Repository-relative root project directory ("" = repository root). */
  root: string;
  settings?: SourceFile;
  propertiesPath: string;
  properties?: SourceFile;
  values: Map<string, PropertyEntry>;
  invocations: GradleInvocation[];
}

function parseInvocation(ctx: JobContext, command: JobCommand): { dir: string; invocation: GradleInvocation } | undefined {
  const list = words(command.command).map((word) => word.replace(/\\/g, "/"));
  let start = 0;
  if (SHELLS.has(list[0] ?? "") && list[1] !== undefined && EXECUTABLES.has(basename(list[1]))) start = 1;
  const exe = list[start];
  if (exe === undefined || !EXECUTABLES.has(basename(exe))) return undefined;
  const exeDir = dirname(exe);
  const options: string[] = [];
  const tasks: string[] = [];
  let projectDir: string | undefined;
  const args = list.slice(start + 1);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (/^["']?\$/.test(arg) || arg.includes("`")) return undefined;
    if (arg === "--") break;
    if (arg.startsWith("-")) {
      const name = arg.split("=")[0] ?? arg;
      if (OPAQUE_OPTIONS.has(name)) return undefined;
      options.push(arg);
      if (VALUE_OPTIONS.has(arg)) {
        const value = args[index + 1];
        index += 1;
        if (arg === "-p" || arg === "--project-dir") projectDir = value;
      } else if (name === "--project-dir") projectDir = arg.slice(name.length + 1);
      continue;
    }
    tasks.push(arg);
  }
  if (exeDir !== "" && exeDir !== "." && projectDir === undefined) return undefined;
  if (projectDir !== undefined && /[$`]/.test(projectDir)) return undefined;
  const base = commandDirectory(ctx, command);
  if (base === undefined) return undefined;
  const dir = projectDir === undefined ? base : joinPath(base, projectDir);
  if (dir === undefined) return undefined;
  return { dir, invocation: { ctx, command, executable: basename(exe), options, tasks } };
}

function isBuildRun(invocation: GradleInvocation): boolean {
  if (invocation.options.some((option) => HELP_FLAGS.has(option))) return false;
  return invocation.tasks.some((task) => !HELP_TASKS.has(task.replace(/^:/, "").toLowerCase()));
}

function settingsIn(project: ProjectModel, dir: string): SourceFile | undefined {
  return project.files.get(inDir(dir, "settings.gradle.kts")) ?? project.files.get(inDir(dir, "settings.gradle"));
}

/** Root project directory for a build started in `dir`: nearest directory with a settings file, else `dir` with a build file. */
function rootOf(project: ProjectModel, dir: string): string | undefined {
  let current: string | undefined = dir;
  while (current !== undefined) {
    if (settingsIn(project, current)) return current;
    current = current === "" ? undefined : dirname(current);
  }
  const hasBuild = project.files.has(inDir(dir, "build.gradle.kts")) || project.files.has(inDir(dir, "build.gradle"));
  return hasBuild ? dir : undefined;
}

/** Gradle builds that CI actually runs tasks for, grouped by root project directory. */
export function gradleBuilds(project: ProjectModel): GradleBuild[] {
  const builds = new Map<string, GradleBuild>();
  for (const ctx of jobContexts(project)) {
    for (const command of ctx.commands) {
      const parsed = parseInvocation(ctx, command);
      if (!parsed || !isBuildRun(parsed.invocation)) continue;
      const root = rootOf(project, parsed.dir);
      if (root === undefined) continue;
      let build = builds.get(root);
      if (!build) {
        const propertiesPath = inDir(root, "gradle.properties");
        const properties = project.files.get(propertiesPath);
        const settings = settingsIn(project, root);
        build = {
          root,
          propertiesPath,
          values: properties ? parseProperties(properties.content) : new Map(),
          invocations: [],
          ...(properties ? { properties } : {}),
          ...(settings ? { settings } : {}),
        };
        builds.set(root, build);
      }
      build.invocations.push(parsed.invocation);
    }
  }
  return [...builds.values()];
}

/** True when any workflow or action file mentions `text` (for example a `GRADLE_OPTS` or `~/.gradle/gradle.properties` write). */
export function workflowsMention(project: ProjectModel, text: string): boolean {
  return [...project.workflows, ...project.actions].some((workflow) => project.files.get(workflow.path)?.content.includes(text));
}

/** True when an invocation passes one of the flags or sets one of the properties with `-D`. */
export function invocationSets(build: GradleBuild, flags: string[], properties: string[]): boolean {
  return build.invocations.some((invocation) =>
    invocation.options.some(
      (option) => flags.includes(option) || properties.some((property) => option === `-D${property}` || option.startsWith(`-D${property}=`)),
    ),
  );
}

/** The property is decided by the project (any value) or by the CI environment. */
export function propertyDecided(project: ProjectModel, build: GradleBuild, properties: string[], flags: string[]): boolean {
  if (properties.some((property) => build.values.has(property))) return true;
  if (invocationSets(build, flags, properties)) return true;
  return properties.some((property) => workflowsMention(project, property));
}

export function related(build: GradleBuild): Location[] {
  return build.properties ? [{ path: build.properties.path, line: 1 }] : [];
}
