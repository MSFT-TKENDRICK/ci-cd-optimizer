import { posix } from "node:path";
import {
  matchingClose,
  nixBindings,
  topLevelAttrset,
  type FlakeInfo,
  type FlakeInput,
  type FlakeLock,
  type FlakeLockNode,
  type FlakeRef,
  type NixBinding,
  type NixFile,
} from "../../parsers/nix.js";
import type { NixFlake, ProjectModel } from "../../project.js";
import { enclosingOpen, inheritStatements } from "./expr.js";

/** Branches that only advance after Hydra built and tested them (https://wiki.nixos.org/wiki/Channel_branches). */
export const NIXPKGS_CHANNEL = /^(?:nixos-(?:unstable|\d{2}\.\d{2})(?:-small)?|nixpkgs-unstable|nixpkgs-\d{2}\.\d{2}-darwin)$/;

/** nixpkgs development branches: commits land here before Hydra has built them. */
export const NIXPKGS_DEV_BRANCH = /^(?:master|release-\d{2}\.\d{2}|staging(?:-next)?(?:-\d{2}\.\d{2})?)$/;

/** Current stable NixOS channel, used in suggestions. */
export const STABLE_CHANNEL = "nixos-26.05";

/** Directories holding templates and fixtures, whose flakes are deliberately shipped unlocked or are not this repository's. */
export const SAMPLE_DIR = /(?:^|\/)(?:templates?|examples?|fixtures?|__fixtures__|testdata|test-data)(?:\/|$)/i;

export function flakePath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function inputLine(input: FlakeInput): number {
  return input.urlLine ?? input.line;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function shortRev(rev: string | undefined): string | undefined {
  return rev ? rev.slice(0, 7) : undefined;
}

/** Lock files whose format this module understands (Nix reads versions 5 to 7). */
export function supportedLock(lock: FlakeLock | undefined): lock is FlakeLock {
  return lock !== undefined && lock.version !== undefined && lock.version >= 5 && lock.version <= 7;
}

/** True when a lock node is NixOS/nixpkgs, judged by what it locked (node names such as `nixpkgs_2` are not trusted). */
export function isNixpkgsNode(node: FlakeLockNode | undefined): boolean {
  const locked = node?.locked;
  if (!locked) return false;
  const owner = str(locked.owner);
  const repo = str(locked.repo);
  if (owner && repo) return owner.toLowerCase() === "nixos" && repo.toLowerCase() === "nixpkgs";
  const url = str(locked.url) ?? "";
  return /github\.com[/:]nixos\/nixpkgs(?:\.git)?(?:[/?#]|$)/i.test(url) || /^https:\/\/(?:channels|releases)\.nixos\.org\//.test(url);
}

/** Comparable source revision (or NAR hash), not a proof that consumers produce identical derivations. */
export function nodeIdentity(node: FlakeLockNode): string | undefined {
  return str(node.locked?.rev) ?? str(node.locked?.narHash);
}

/** The root input names of a lock whose reference is a node name (not a `follows` path). */
export function rootNode(lock: FlakeLock, name: string): FlakeLockNode | undefined {
  const reference = lock.rootInputs[name];
  return typeof reference === "string" ? lock.nodes.get(reference) : undefined;
}

export interface GitHubGitUrl {
  scheme: "https" | "ssh";
  owner: string;
  repo: string;
  params: Map<string, string>;
}

/** Parses `git+https://github.com/<owner>/<repo>[.git][?query]` and `git+ssh://git@github.com/<owner>/<repo>...`. */
export function parseGitHubGitUrl(url: string): GitHubGitUrl | undefined {
  const match = /^git\+(https:\/\/(?:www\.)?github\.com\/|ssh:\/\/git@github\.com[:/])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?(?:\?([^#]*))?$/i.exec(
    url.trim(),
  );
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const params = new Map<string, string>();
  for (const pair of (match[4] ?? "").split("&")) {
    if (!pair) continue;
    const equals = pair.indexOf("=");
    const key = equals < 0 ? pair : pair.slice(0, equals);
    const value = equals < 0 ? "" : pair.slice(equals + 1);
    try {
      params.set(key, decodeURIComponent(value));
    } catch {
      params.set(key, value);
    }
  }
  return { scheme: match[1].toLowerCase().startsWith("https") ? "https" : "ssh", owner: match[2], repo: match[3], params };
}

/** Owner, repo and ref/rev of a GitHub-hosted input, from `github:` references, git URLs on github.com, or attribute inputs. */
export function githubSource(input: FlakeInput): { owner: string; repo: string; ref?: string; rev?: string } | undefined {
  const ref = input.flakeRef;
  if (!ref) return undefined;
  if (ref.type === "github" && ref.owner && ref.repo) {
    return { owner: ref.owner, repo: ref.repo, ...(ref.ref ? { ref: ref.ref } : {}), ...(ref.rev ? { rev: ref.rev } : {}) };
  }
  if (ref.type === "git") {
    const git = input.url !== undefined ? parseGitHubGitUrl(input.url) : undefined;
    const url = input.attrs.get("url");
    const parsed = git ?? (url ? parseGitHubGitUrl(`git+${url}`) : undefined);
    if (!parsed) return undefined;
    const gitRef = parsed.params.get("ref") ?? input.attrs.get("ref");
    const gitRev = parsed.params.get("rev") ?? input.attrs.get("rev");
    return { owner: parsed.owner, repo: parsed.repo, ...(gitRef ? { ref: gitRef } : {}), ...(gitRev ? { rev: gitRev } : {}) };
  }
  return undefined;
}

/** Names the `outputs` function takes besides `self` that are not declared under `inputs`: Nix adds them as indirect inputs. */
export function implicitInputs(info: FlakeInfo): string[] {
  return (info.outputs?.args ?? []).filter((name) => name !== "self" && !info.inputs.has(name));
}

/** Bindings of a flake.nix's top-level attribute set. */
export function flakeBindings(file: NixFile): NixBinding[] {
  const open = topLevelAttrset(file);
  return open === undefined ? [] : nixBindings(file, open);
}

/** True when flake.nix gives the input any source (`url`, `type`, `follows`, or a shorthand value), even one the parser cannot read. */
export function hasExplicitSource(file: NixFile, bindings: NixBinding[], name: string): boolean {
  return bindings.some((binding) => {
    const [head, input, field] = binding.path;
    if (head !== "inputs" || input !== name) return false;
    if (binding.path.length === 2) return attrsetLiteral(file, binding) === undefined;
    return binding.path.length === 3 && (field === "url" || field === "type" || field === "follows");
  });
}

/**
 * True when every attribute set literal of flake.nix was read to its closing brace and `inputs` is
 * only ever bound to literals, so `flakeInfo` saw every declared input. False for
 * `inputs = import ./inputs.nix;`, `inputs = { … } // extra;` or syntax the parser stops at.
 */
export function inputsFullyKnown(file: NixFile, bindings: NixBinding[]): boolean {
  const open = topLevelAttrset(file);
  if (open === undefined) return false;
  const scopes = [open];
  for (const binding of bindings) {
    const brace = attrsetLiteral(file, binding);
    if (brace !== undefined) scopes.push(brace);
    else if (binding.path.length === 1 && binding.path[0] === "inputs") return false;
  }
  return scopes.every((brace) => {
    if (inheritStatements(file).some((statement) => enclosingOpen(file, statement.offset) === brace)) return false;
    const close = matchingClose(file, brace);
    const inside = bindings.filter((binding) => binding.keyStart > brace && binding.keyStart < close);
    const last = Math.max(brace, ...inside.map((binding) => binding.valueEnd));
    return /^(?:\s*inherit\b[^;]*;)*\s*$/.test(file.masked.slice(last + 1, close));
  });
}

/** Offset of the `{` when a binding's whole value is one attribute set literal (whose contents `nixBindings` flattened). */
function attrsetLiteral(file: NixFile, binding: NixBinding): number | undefined {
  const open = /^(?:rec\s+)?\{/.exec(file.masked.slice(binding.valueStart, binding.valueStart + 8));
  if (!open) return undefined;
  const brace = binding.valueStart + open[0].length - 1;
  const close = matchingClose(file, brace);
  return close >= 0 && file.masked.slice(close + 1, binding.valueEnd).trim() === "" ? brace : undefined;
}

function pathTarget(url: string, fromDir: string): string | undefined {
  const [base = "", query = ""] = url.split("?", 2);
  let path: string | undefined;
  if (/^path:/.test(base)) path = base.slice("path:".length);
  else if (/^git\+file:/.test(base)) path = base.slice("git+file:".length);
  else if (/^\.{1,2}(?:\/|$)/.test(base)) path = base;
  if (path === undefined || path.startsWith("/")) return undefined;
  const dir = /(?:^|&)dir=([^&]*)/.exec(query)?.[1];
  let subdir = ".";
  try {
    if (dir) subdir = decodeURIComponent(dir);
  } catch {
    return undefined;
  }
  const joined = posix.normalize(posix.join(fromDir || ".", path, subdir));
  return joined === "." ? "" : joined.replace(/\/$/, "");
}

/** True when another flake in the project consumes `dir` through a relative `path:`/`git+file:` input (a subflake). */
export function isSubflake(project: ProjectModel, dir: string): boolean {
  return project.nix.flakes.some(
    (other) =>
      other.dir !== dir &&
      [...(other.info?.inputs.values() ?? [])].some((input) => input.url !== undefined && pathTarget(input.url, other.dir) === dir),
  );
}

/** The flake's lock file as parsed, or undefined (including for unsupported lock versions). */
export function lockOf(flake: NixFlake): FlakeLock | undefined {
  return supportedLock(flake.lock) ? flake.lock : undefined;
}

/** Comparable fields of a forge reference; undefined for references with fields this module does not compare. */
export function forgeKey(ref: Record<string, unknown> | FlakeRef | undefined): string | undefined {
  if (!ref) return undefined;
  const fields = ref as Record<string, unknown>;
  const type = str(fields.type);
  if (type !== "github" && type !== "gitlab" && type !== "sourcehut") return undefined;
  if (Object.keys(fields).some((key) => !["type", "owner", "repo", "ref", "rev", "dir"].includes(key) && fields[key] !== undefined)) {
    return undefined;
  }
  const owner = str(fields.owner)?.toLowerCase();
  const repo = str(fields.repo)?.toLowerCase();
  if (!owner || !repo) return undefined;
  return JSON.stringify([type, owner, repo, str(fields.ref) ?? "", str(fields.rev) ?? "", str(fields.dir) ?? ""]);
}

/** Human-readable form of a lock node's `original`, e.g. `github:NixOS/nixpkgs/nixos-24.11`. */
export function describeOriginal(original: Record<string, unknown> | undefined): string | undefined {
  if (!original) return undefined;
  const type = str(original.type);
  const owner = str(original.owner);
  const repo = str(original.repo);
  if ((type === "github" || type === "gitlab" || type === "sourcehut") && owner && repo) {
    const refOrRev = str(original.ref) ?? str(original.rev);
    return `${type}:${owner}/${repo}${refOrRev ? `/${refOrRev}` : ""}`;
  }
  if (type === "indirect") {
    const id = str(original.id);
    const refOrRev = str(original.ref) ?? str(original.rev);
    return id ? `flake:${id}${refOrRev ? `/${refOrRev}` : ""}` : undefined;
  }
  return str(original.url);
}
