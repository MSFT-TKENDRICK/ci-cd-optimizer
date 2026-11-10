import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { exactKeys, object, scalarString, string, type Json } from "./json.js";

export interface SourceBlob {
  commit: string;
  path: string;
  blob: string;
  content: string;
}

const exec = promisify(execFile);
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function location(commit: string, path: string): void {
  if (!OID.test(commit)) throw new Error("Source commit must be a full lowercase Git object id, not a mutable ref.");
  scalarString(path);
  const controlCharacters = [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (!path || path.length > 4096 || /[:\\]/.test(path) || controlCharacters || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Source path must be a repository-relative Git path without traversal.");
  }
}

function blobId(content: Buffer, format: "sha1" | "sha256"): string {
  return createHash(format).update(`blob ${content.length}\0`).update(content).digest("hex");
}

export function validateSourceBlob(source: SourceBlob): void {
  location(source.commit, source.path);
  scalarString(source.content);
  if (!OID.test(source.blob)) throw new Error("Invalid recorded Git blob id.");
  const bytes = Buffer.from(source.content, "utf8");
  if (bytes.length > 2_000_000) throw new Error("Source blob exceeds 2 MB.");
  if (blobId(bytes, source.blob.length === 40 ? "sha1" : "sha256") !== source.blob) throw new Error("Recorded source bytes do not match the Git blob id.");
}

export function decodeSourceBlob(value: Json | undefined): SourceBlob {
  const record = object(value, "source");
  exactKeys(record, ["commit", "path", "blob", "content"], "source");
  const result = {
    commit: string(record.commit, "source.commit"), path: string(record.path, "source.path"),
    blob: string(record.blob, "source.blob"), content: string(record.content, "source.content"),
  };
  validateSourceBlob(result);
  return result;
}

/** Reads the committed blob, never the worktree and never a textconv/filter. */
export async function readCommittedBlob(repository: string, commit: string, path: string): Promise<SourceBlob> {
  location(commit, path);
  const git = async (...args: string[]) => (await exec("git", ["--no-pager", "--no-replace-objects", "-C", repository, ...args], { encoding: "buffer", maxBuffer: 2_000_100, timeout: 15_000 })).stdout;
  if ((await git("cat-file", "-t", commit)).toString("utf8").trim() !== "commit") throw new Error("Source id is not a commit.");
  const blob = (await git("rev-parse", "--verify", `${commit}:${path}`)).toString("utf8").trim();
  if (!OID.test(blob) || (await git("cat-file", "-t", blob)).toString("utf8").trim() !== "blob") throw new Error("Source path does not identify a Git blob.");
  const bytes = await git("cat-file", "blob", blob);
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error("Source must round-trip as UTF-8 bytes.");
  const source = { commit, path, blob, content };
  validateSourceBlob(source);
  return source;
}

export async function bindSources(sources: SourceBlob[], repository: string): Promise<void> {
  for (const source of sources) {
    const actual = await readCommittedBlob(repository, source.commit, source.path);
    if (actual.blob !== source.blob || actual.content !== source.content) throw new Error(`Stale or forged source binding: ${source.commit}:${source.path}`);
  }
}
