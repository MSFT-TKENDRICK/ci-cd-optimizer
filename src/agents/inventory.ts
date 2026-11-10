import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { LintConfig } from "../lint/config.js";
import { isInventoryPath, isLockfile, selectInventory, type InventoryEntry, type LoadedInput } from "../lint/inventory.js";
import { AgentError, LIMITS } from "./safety.js";

const SKIP = new Set([".git", "node_modules", ".pnpm-store", ".yarn", ".venv", "venv", "__pycache__", ".turbo", ".nx", "target", ".gradle"]);
export const within = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

/** Read at most limit + 1 bytes, never an arbitrarily large file or a pipe. Refuse symlinks, including parent escapes. */
export async function readBoundedFile(root: string, path: string, limit: number, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  signal?.throwIfAborted();
  const before = await lstat(path);
  if (!before.isFile() || !within(root, await realpath(path))) throw new AgentError("Only regular files inside the workspace may be read.");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || !within(root, await realpath(path))) {
      throw new AgentError("Workspace file changed while opening it; retry.");
    }
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      signal?.throwIfAborted();
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const truncated = size > limit || opened.size > limit;
    try {
      // Preserve a BOM and reject lossy previews; a bounded lockfile prefix may end inside a code point.
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(bytes.subarray(0, Math.min(size, limit)), { stream: truncated });
      return { text, truncated };
    } catch {
      throw new AgentError("Workspace text must be valid UTF-8; lossy file previews are not supported.");
    }
  } finally {
    await handle.close();
  }
}

/** Agent-specific ceilings cannot be raised by repository configuration. The CLI's inventory behavior is unchanged. */
export async function loadAgentDirectory(root: string, config: LintConfig, signal?: AbortSignal): Promise<LoadedInput> {
  const entries: InventoryEntry[] = [];
  let visited = 0;
  let complete = true;
  async function walk(directory: string, depth: number): Promise<void> {
    signal?.throwIfAborted();
    if (depth > LIMITS.depth || visited >= LIMITS.entries) { complete = false; return; }
    if (!within(root, await realpath(directory))) throw new AgentError("Workspace directory resolves outside the root.");
    const listing = await opendir(directory);
    for await (const entry of listing) {
      signal?.throwIfAborted();
      visited += 1;
      if (visited > LIMITS.entries) { complete = false; break; }
      const full = join(directory, entry.name);
      if (entry.isDirectory() && !SKIP.has(entry.name)) await walk(full, depth + 1);
      else if (entry.isFile()) {
        const path = relative(root, full).split(sep).join("/");
        if (isInventoryPath(path)) entries.push({ path, size: (await lstat(full)).size });
      }
    }
  }
  await walk(root, 0);
  const limits = { maxFiles: Math.min(config.limits.maxFiles, LIMITS.files), maxFileBytes: Math.min(config.limits.maxFileBytes, LIMITS.fileBytes) };
  const selected = selectInventory(entries, { ...config, limits });
  const truncated = new Set(selected.truncated);
  const files: LoadedInput["files"] = [];
  let remaining: number = LIMITS.workspaceBytes;
  for (const path of selected.paths) {
    signal?.throwIfAborted();
    if (remaining <= 0) { complete = false; break; }
    if (path.endsWith(".lockb")) { files.push({ path, content: "" }); continue; }
    const limit = Math.min(remaining, truncated.has(path) ? 8192 : limits.maxFileBytes);
    const read = await readBoundedFile(root, join(root, ...path.split("/")), limit, signal);
    remaining -= Buffer.byteLength(read.text);
    if (read.truncated) {
      complete = false;
      if (!isLockfile(path)) continue;
      truncated.add(path);
    }
    files.push({ path, content: read.text });
  }
  return { files, truncated: [...truncated], mode: "repository", inventoryComplete: complete && selected.complete };
}
