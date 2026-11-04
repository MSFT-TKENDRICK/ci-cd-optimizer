import type { StepModel } from "../../parsers/workflow.js";

/** actions/cache and drop-in replacements that restore a cache (save-only variants excluded). */
export const CACHE_RESTORE_ACTIONS = [
  "actions/cache",
  "actions/cache/restore",
  "buildjet/cache",
  "buildjet/cache/restore",
  "useblacksmith/cache",
  "useblacksmith/cache/restore",
  "runs-on/cache",
  "runs-on/cache/restore",
];

export function usesAction(step: StepModel, ...names: string[]): boolean {
  const action = step.uses?.action;
  return action?.kind === "remote" && action.name !== undefined && names.includes(action.name);
}

export function anyUses(steps: StepModel[], ...names: string[]): boolean {
  return steps.some((step) => usesAction(step, ...names));
}

/** Splits a multi-line `with` value (for example `path:` or `cache-from:`) into trimmed, non-comment entries. */
export function listOf(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && !entry.startsWith("#"));
}

export function isFalse(value: unknown): boolean {
  return value === false || (typeof value === "string" && value.trim().toLowerCase() === "false");
}

export function isTrue(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
}

/**
 * True when a cache-restoring step restores a path matching `path` (or whose key matches `key`). A cache step whose
 * path is not a literal is unknown and therefore counts as covering (never treat unknown values as missing).
 */
export function cacheCovers(steps: StepModel[], path: RegExp, key?: RegExp): boolean {
  return steps.some((step) => {
    if (!usesAction(step, ...CACHE_RESTORE_ACTIONS)) return false;
    const pathEntry = step.with.get("path");
    if (pathEntry && pathEntry.kind !== "literal") return true;
    const paths = pathEntry && typeof pathEntry.value === "string" ? listOf(pathEntry.value) : [];
    if (paths.some((entry) => !entry.startsWith("!") && path.test(entry))) return true;
    const keyValue = step.with.get("key")?.value;
    return key !== undefined && typeof keyValue === "string" && key.test(keyValue);
  });
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Words of a shell command with leading `VAR=value` assignments and `sudo`/`time`/`env` wrappers removed. */
export function commandWords(command: string): string[] {
  const words = command.split(/\s+/).filter(Boolean);
  let index = 0;
  while (
    index < words.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "") || ["sudo", "time", "env", "exec", "command"].includes(words[index] ?? ""))
  ) {
    index += 1;
  }
  return words.slice(index);
}
