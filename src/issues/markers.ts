import { createHash } from "node:crypto";

export type ManagedKind = "finding" | "alert" | "fix" | "recipe" | "experiment";

export interface Marker {
  kind: ManagedKind;
  fingerprint: string;
  attributes: Record<string, string>;
}

const MARKER = /<!--\s*cicd-optimizer:(finding|alert|fix|recipe|experiment)\s+([^>]*?)\s*-->/;

/** Hidden HTML comment that makes issues and pull requests idempotently re-discoverable without a database. */
export function marker(kind: ManagedKind, fingerprint: string, attributes: Record<string, string> = {}): string {
  const extra = Object.entries(attributes)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => ` ${key}=${encodeURIComponent(value)}`)
    .join("");
  return `<!-- cicd-optimizer:${kind} fingerprint=${encodeURIComponent(fingerprint)}${extra} -->`;
}

export function parseMarker(body: string | null | undefined): Marker | undefined {
  const match = body ? MARKER.exec(body) : null;
  if (!match) return undefined;
  const attributes: Record<string, string> = {};
  for (const pair of (match[2] ?? "").split(/\s+/)) {
    const index = pair.indexOf("=");
    if (index > 0) attributes[pair.slice(0, index)] = decodeURIComponent(pair.slice(index + 1));
  }
  const fingerprint = attributes.fingerprint;
  if (!fingerprint) return undefined;
  delete attributes.fingerprint;
  return { kind: match[1] as ManagedKind, fingerprint, attributes };
}

/** The first marker of `kind` in `body` (bodies can carry several, e.g. a fix marker followed by a recipe marker). */
export function findMarker(body: string | null | undefined, kind: ManagedKind): Marker | undefined {
  if (!body) return undefined;
  const all = new RegExp(MARKER.source, "g");
  for (const match of body.matchAll(all)) {
    const parsed = parseMarker(match[0]);
    if (parsed?.kind === kind) return parsed;
  }
  return undefined;
}

export function signatureOf(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/** Rewrites the attributes of the marker in `body` (adding a marker at the top when there is none). */
export function updateMarker(body: string, kind: ManagedKind, fingerprint: string, attributes: Record<string, string>): string {
  const existing = parseMarker(body);
  const next = marker(kind, fingerprint, { ...(existing?.attributes ?? {}), ...attributes });
  return existing ? body.replace(MARKER, () => next) : `${next}\n${body}`;
}
