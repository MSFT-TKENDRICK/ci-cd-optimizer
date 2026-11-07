import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { PRESETS } from "../lint/config.js";
import type { AnyRule } from "../lint/types.js";
import { UsageError } from "./io.js";

/** Id shape for repository-local rules; the `local/` namespace keeps them apart from built-in rules. */
export const LOCAL_RULE_ID = /^local\/[a-z0-9][a-z0-9-]*$/;
const SCHEME = /^[a-z][a-z0-9+.-]{1,}:/i;
const SEVERITIES = ["info", "warn", "error"];
const KINDS = ["practice", "policy", "insight"];
const IMPACTS = ["high", "medium", "low"];
const CAPABILITIES = ["repository", "complete-inventory", "change-set"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const escapes = (path: string) => path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path);

/**
 * Validates a `localRules` entry and returns the real path of the module. These checks catch misconfiguration (absolute
 * paths, URLs, `..`, symlinks out of the repository); they are not a sandbox, because the module itself runs with full
 * privileges.
 */
async function resolveModule(root: string, entry: string): Promise<string> {
  const fail = (reason: string) => new UsageError(`localRules: "${entry}" ${reason}`);
  if (SCHEME.test(entry)) throw fail("must be a repository-relative path, not a URL.");
  if (isAbsolute(entry) || win32.isAbsolute(entry) || posix.isAbsolute(entry) || /^[\\/]/.test(entry)) {
    throw fail("must be a repository-relative path, not an absolute path.");
  }
  // Drive-relative Windows paths (`C:rules.mjs`) and NTFS alternate data streams.
  if (entry.includes(":")) throw fail("must be a repository-relative path without drive letters or colons.");
  const normalized = posix.normalize(entry.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../")) throw fail("must stay inside the repository.");
  if (!/\.(m?js)$/.test(normalized)) throw fail("must be a .js or .mjs file.");
  const file = join(root, normalized);
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw fail("does not exist.");
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
  if (escapes(relative(realRoot, realFile))) throw fail("resolves outside the repository (symbolic link).");
  return realFile;
}

function validateRule(entry: string, value: unknown): AnyRule {
  const fail = (reason: string) => new UsageError(`localRules: "${entry}" exports an invalid rule: ${reason}`);
  if (!isRecord(value) || !isRecord(value.meta)) throw fail("expected an object with `meta` and `check`.");
  const meta = value.meta;
  const id = typeof meta.id === "string" ? meta.id : "";
  if (!LOCAL_RULE_ID.test(id)) throw fail(`meta.id must match ${LOCAL_RULE_ID.source} (got ${JSON.stringify(meta.id)}).`);
  const where = `${id}: `;
  if (meta.ruleset !== "local") throw fail(`${where}meta.ruleset must be "local".`);
  if (typeof meta.description !== "string" || meta.description.trim() === "") throw fail(`${where}meta.description must be a non-empty string.`);
  if (!SEVERITIES.includes(meta.defaultSeverity as string)) throw fail(`${where}meta.defaultSeverity must be one of ${SEVERITIES.join(", ")}.`);
  if (!KINDS.includes(meta.kind as string)) throw fail(`${where}meta.kind must be one of ${KINDS.join(", ")}.`);
  const presets = meta.presets ?? [];
  if (!Array.isArray(presets) || !presets.every((preset) => (PRESETS as readonly string[]).includes(preset as string))) {
    throw fail(`${where}meta.presets must be a list of ${PRESETS.join(", ")}.`);
  }
  const requires = meta.requires ?? [];
  if (!Array.isArray(requires) || !requires.every((capability) => CAPABILITIES.includes(capability as string))) {
    throw fail(`${where}meta.requires must be a list of ${CAPABILITIES.join(", ")}.`);
  }
  if (meta.impact !== undefined && !IMPACTS.includes(meta.impact as string)) throw fail(`${where}meta.impact must be one of ${IMPACTS.join(", ")}.`);
  if (meta.rationale !== undefined && typeof meta.rationale !== "string") throw fail(`${where}meta.rationale must be a string.`);
  if (meta.references !== undefined && !(Array.isArray(meta.references) && meta.references.every((ref) => typeof ref === "string"))) {
    throw fail(`${where}meta.references must be a list of strings.`);
  }
  if (meta.defaultOptions !== undefined && !isRecord(meta.defaultOptions)) throw fail(`${where}meta.defaultOptions must be an object.`);
  if (meta.validateOptions !== undefined && typeof meta.validateOptions !== "function") throw fail(`${where}meta.validateOptions must be a function.`);
  if (meta.docsUrl !== undefined && typeof meta.docsUrl !== "string") throw fail(`${where}meta.docsUrl must be a string.`);
  if (typeof value.check !== "function") throw fail(`${where}check must be a function.`);
  const check = value.check as AnyRule["check"];
  return {
    meta: {
      ...meta,
      id,
      ruleset: "local",
      presets: [...presets],
      requires: [...requires],
      rationale: (meta.rationale as string | undefined) ?? "",
      references: [...((meta.references as string[] | undefined) ?? [])],
      impact: (meta.impact as AnyRule["meta"]["impact"] | undefined) ?? "medium",
      defaultOptions: (meta.defaultOptions as Record<string, unknown> | undefined) ?? {},
    } as AnyRule["meta"],
    check: (context) => check.call(value, context),
  };
}

/**
 * Imports the repository's `localRules` modules. Each module exports `rules` (an array) or a default export (one rule or an
 * array). Only call this for trusted repositories: importing a module executes it.
 */
export async function loadLocalRules(root: string, entries: string[], builtins: readonly AnyRule[]): Promise<AnyRule[]> {
  const loaded: AnyRule[] = [];
  const builtinIds = new Set(builtins.map((rule) => rule.meta.id));
  for (const entry of entries) {
    const real = await resolveModule(root, entry);
    let module: Record<string, unknown>;
    try {
      module = (await import(pathToFileURL(real).href)) as Record<string, unknown>;
    } catch (error) {
      throw new UsageError(`localRules: "${entry}" failed to load: ${error instanceof Error ? error.message : String(error)}`);
    }
    const exported = module.rules ?? module.default;
    const candidates = Array.isArray(exported) ? exported : exported === undefined ? [] : [exported];
    if (candidates.length === 0) throw new UsageError(`localRules: "${entry}" must export \`rules\` (an array) or a default rule or array of rules.`);
    for (const candidate of candidates) {
      const rule = validateRule(entry, candidate);
      if (builtinIds.has(rule.meta.id) || loaded.some((other) => other.meta.id === rule.meta.id)) {
        throw new UsageError(`localRules: "${entry}" defines duplicate rule id "${rule.meta.id}".`);
      }
      loaded.push(rule);
    }
  }
  return loaded;
}
