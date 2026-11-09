import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { matchesGlob } from "../utils.js";
import type { LintConfig } from "./config.js";
import type { AnalysisInput, ChangeContext, SourceFile } from "./types.js";

const run = promisify(execFile);

/** Files whose presence or content rules depend on. Everything else in a repository is irrelevant to the linter. */
const BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".yarnrc.yml",
  ".npmignore",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "tsconfig.json",
  "nx.json",
  "turbo.json",
  "lerna.json",
  "rush.json",
  "MODULE.bazel",
  "WORKSPACE",
  "WORKSPACE.bazel",
  ".bazelrc",
  ".bazelversion",
  ".bazeliskrc",
  "pants.toml",
  "settings.gradle",
  "settings.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
  "gradle.properties",
  "pom.xml",
  "build.sbt",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "go.work",
  "pyproject.toml",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "uv.lock",
  "packages.lock.json",
  "Directory.Packages.props",
  "global.json",
  "docker-bake.hcl",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  ".dockerignore",
  "action.yml",
  "action.yaml",
  "flake.lock",
  ".envrc",
  "devenv.yaml",
  "devenv.lock",
  "CMakeLists.txt",
  "meson.build",
  ".python-version",
  ".go-version",
  ".java-version",
  ".sdkmanrc",
  "rust-toolchain",
  "rust-toolchain.toml",
  "renovate.json",
  "renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
]);

/** Lockfiles are often larger than the per-file limit, but rules only need their presence and header. */
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock", "Pipfile.lock", "uv.lock", "packages.lock.json"]);
const LOCKFILE_HEAD_BYTES = 8192;
const SKIP_DIRS = new Set([".git", "node_modules", ".pnpm-store", ".yarn", ".venv", "venv", "__pycache__", ".turbo", ".nx", "target", ".gradle", ".direnv"]);

export function isInventoryPath(path: string): boolean {
  if (/(^|\/)node_modules\//.test(path)) return false;
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)) return true;
  if (/^\.github\/ci-cd-optimizer\.ya?ml$/.test(path)) return true;
  if (/^\.github\/(dependabot\.ya?ml|renovate\.json5?)$/.test(path)) return true;
  if (/(^|\/)\.cargo\/config(\.toml)?$/.test(path) || /(^|\/)gradle\/wrapper\/gradle-wrapper\.properties$/.test(path)) return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (BASENAMES.has(name)) return true;
  if (/^(Dockerfile|Containerfile)(\.[^/]+)?$/i.test(name) || /\.(dockerfile|containerfile|dockerignore)$/i.test(name)) return true;
  if (/^requirements.*\.txt$/i.test(name) || /(^|\/)requirements\/[^/]+\.txt$/i.test(path)) return true;
  if (/\.bazelrc$/i.test(name) || /\.(csproj|fsproj|sln)$/i.test(name)) return true;
  if (/\.nix$/.test(name)) return true;
  return path === ".changeset/config.json";
}

export const isLockfile = (path: string) => LOCKFILES.has(path.slice(path.lastIndexOf("/") + 1));

export interface InventoryEntry {
  path: string;
  size?: number;
}

export interface InventorySelection {
  paths: string[];
  /** Paths whose content should be truncated to their head (oversized lockfiles). */
  truncated: string[];
  /** false when the file limit was hit or an oversized non-lockfile was dropped, so absence is not meaningful. */
  complete: boolean;
}

/** Chooses which files of a repository listing to analyze, honoring ignorePaths and limits. */
export function selectInventory(entries: readonly InventoryEntry[], config: Pick<LintConfig, "ignorePaths" | "limits">): InventorySelection {
  const paths: string[] = [];
  const truncated: string[] = [];
  let complete = true;
  const ignored = (path: string) => config.ignorePaths.some((glob) => matchesGlob(path, glob) || matchesGlob(path, `${glob}/**`));
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!isInventoryPath(entry.path) || ignored(entry.path)) continue;
    if (paths.length >= config.limits.maxFiles) {
      complete = false;
      break;
    }
    if ((entry.size ?? 0) > config.limits.maxFileBytes) {
      if (!isLockfile(entry.path)) {
        complete = false;
        continue;
      }
      truncated.push(entry.path);
    }
    paths.push(entry.path);
  }
  return { paths, truncated, complete };
}

export function truncateContent(content: string): string {
  return content.length > LOCKFILE_HEAD_BYTES ? content.slice(0, LOCKFILE_HEAD_BYTES) : content;
}

async function walk(root: string, dir: string, out: InventoryEntry[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(root, full, out);
    } else if (entry.isFile()) {
      const path = relative(root, full).split(sep).join("/");
      if (isInventoryPath(path)) out.push({ path, size: (await stat(full)).size });
    }
  }
}

export type LoadedInput = AnalysisInput & { truncated: string[] };

/** Loads the analysis input for a working tree on disk. */
export async function loadDirectory(root: string, config: Pick<LintConfig, "ignorePaths" | "limits">, change?: ChangeContext): Promise<LoadedInput> {
  const entries: InventoryEntry[] = [];
  await walk(root, root, entries);
  const selection = selectInventory(entries, config);
  const truncated = new Set(selection.truncated);
  const files: SourceFile[] = await Promise.all(
    selection.paths.map(async (path) => {
      const content = path.endsWith(".lockb") ? "" : await readFile(join(root, path), "utf8");
      return { path, content: truncated.has(path) ? truncateContent(content) : content };
    }),
  );
  return { files, mode: "repository", inventoryComplete: selection.complete, truncated: selection.truncated, ...(change ? { change } : {}) };
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Loads the analysis input for a git revision (used to compute the baseline for `introduced` diagnostics). */
export async function loadGitRevision(root: string, ref: string, config: Pick<LintConfig, "ignorePaths" | "limits">): Promise<AnalysisInput> {
  const listing = await git(root, ["ls-tree", "-r", "-l", "--full-tree", ref]);
  const entries = listing
    .split("\n")
    .map((line) => /^\d+ blob [0-9a-f]+\s+(\d+|-)\t(.+)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ path: match[2] as string, size: Number(match[1]) || 0 }));
  const selection = selectInventory(entries, config);
  const truncated = new Set(selection.truncated);
  const files: SourceFile[] = [];
  for (const path of selection.paths) {
    const content = path.endsWith(".lockb") ? "" : await git(root, ["show", `${ref}:${path}`]);
    files.push({ path, content: truncated.has(path) ? truncateContent(content) : content });
  }
  return { files, mode: "repository", inventoryComplete: selection.complete };
}

/** Paths changed between the merge base of `base` and the working tree (committed, staged, and unstaged). */
export async function changedSince(root: string, base: string): Promise<ChangeContext> {
  const mergeBase = (await git(root, ["merge-base", base, "HEAD"])).trim();
  const committed = await git(root, ["diff", "--name-only", "--no-renames", mergeBase]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard"]);
  const changedPaths = [...new Set([...committed.split("\n"), ...untracked.split("\n")].map((line) => line.trim()).filter(Boolean))];
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  return { event: "pull_request", baseSha: mergeBase, headSha: head, changedPaths };
}
