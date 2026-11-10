import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { matchesGlob } from "../utils.js";
import type { LintConfig } from "./config.js";
import { isInventoryPath, isLockfile, SKIP_DIRS } from "./inventory-paths.js";
import type { AnalysisInput, ChangeContext, SourceFile } from "./types.js";

const run = promisify(execFile);

export { isInventoryPath, isLockfile } from "./inventory-paths.js";
const LOCKFILE_HEAD_BYTES = 8192;

export interface InventoryEntry {
  path: string;
  size?: number;
  /** Links/submodules are not file contents and are never followed. */
  opaque?: boolean;
}

export interface InventorySelection {
  paths: string[];
  /** Paths whose content should be truncated to their head (oversized lockfiles). */
  truncated: string[];
  /** Whether every selected-scope file was available, independently of explicit exclusions. */
  selectionComplete: boolean;
  /** False when relevant files were excluded, limited, oversized or opaque; global absence is then unknown. */
  complete: boolean;
}

/** Chooses which files of a repository listing to analyze, honoring ignorePaths and limits. */
export function selectInventory(entries: readonly InventoryEntry[], config: Pick<LintConfig, "ignorePaths" | "limits">): InventorySelection {
  const paths: string[] = [];
  const truncated: string[] = [];
  let complete = true;
  let excluded = false;
  const ignored = (path: string) => config.ignorePaths.some((glob) => matchesGlob(path, glob) || matchesGlob(path, `${glob}/**`));
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    if (ignored(entry.path)) {
      if (isInventoryPath(entry.path) || (entry.opaque && !entry.path.split("/").some((part) => SKIP_DIRS.has(part)))) excluded = true;
      continue;
    }
    if (entry.opaque) {
      if (!entry.path.split("/").some((part) => SKIP_DIRS.has(part))) complete = false;
      continue;
    }
    if (!isInventoryPath(entry.path)) continue;
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
  return { paths, truncated, selectionComplete: complete, complete: complete && !excluded };
}

export function truncateContent(content: string): string {
  return content.length > LOCKFILE_HEAD_BYTES ? content.slice(0, LOCKFILE_HEAD_BYTES) : content;
}

async function walk(root: string, dir: string, out: InventoryEntry[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(root, full, out);
    } else if (entry.isSymbolicLink()) {
      out.push({ path: relative(root, full).split(sep).join("/"), opaque: true });
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
  const listing = await git(root, ["ls-tree", "-r", "-l", "-z", "--full-tree", ref]);
  const entries = listing
    .split("\0")
    .map((line) => /^(\d+) (?:blob|commit) [0-9a-f]+\s+(\d+|-)\t([\s\S]+)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ path: match[3] as string, size: Number(match[2]) || 0, opaque: match[1] === "120000" || match[1] === "160000" }));
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
  const committed = await git(root, ["diff", "--name-only", "-z", "--no-renames", mergeBase]);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const changedPaths = [...new Set([...committed.split("\0"), ...untracked.split("\0")].filter(Boolean))];
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  return { event: "pull_request", baseSha: mergeBase, headSha: head, changedPaths };
}
