import { isMap, isScalar, parseAllDocuments, visit } from "yaml";
import { PRESETS } from "../lint/config.js";
import type { Preset } from "../lint/types.js";
import { describeValue } from "./escape.js";

export const PROJECT_FILE = "project.yaml";
export const PROJECT_MAX_BYTES = 8 * 1024;
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** GitHub login / organization rules: alphanumerics and single inner hyphens, at most 39 characters. */
export const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const LANGUAGE_PATTERN = /^[a-z0-9+#.-]{1,32}$/;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,63}$/;
const GITHUB_PREFIX = "https://github.com/";
export const MAX_AUTO_CCS = 10;

export interface MainRepository {
  owner: string;
  repo: string;
  fullName: string;
}

export interface Project {
  name: string;
  mainRepo: MainRepository;
  repositoryId: number;
  primaryContact: string;
  autoCcs: string[];
  securityContact?: string;
  language?: string;
  preset?: Preset;
  paused: boolean;
}

export interface StrictYamlResult {
  value?: Record<string, unknown>;
  problems: string[];
}

/**
 * Parses a small YAML mapping defensively: byte cap before parsing, exactly one YAML 1.2 document, no directives,
 * duplicate keys, aliases, anchors, explicit or custom tags, `<<` merge keys, or non-string keys. Any parser error or
 * warning rejects the document. The result is plain data and never instantiates custom types.
 */
export function parseStrictYaml(text: string, maxBytes: number, label: string): StrictYamlResult {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) return { problems: [`${label} is ${bytes} bytes; the limit is ${maxBytes} bytes.`] };
  if (/^%/m.test(text)) return { problems: [`${label} must not contain YAML directives (lines starting with %).`] };
  let documents;
  try {
    documents = parseAllDocuments(text, { uniqueKeys: true, merge: false, version: "1.2", prettyErrors: true });
  } catch (error) {
    return { problems: [`${label} is not valid YAML (${describeValue(error instanceof Error ? error.message : String(error))}).`] };
  }
  if (!Array.isArray(documents) || documents.length !== 1) {
    return { problems: [`${label} must contain exactly one YAML document.`] };
  }
  const document = documents[0];
  if (!document) return { problems: [`${label} must contain exactly one YAML document.`] };
  const problems: string[] = [];
  for (const issue of [...document.errors, ...document.warnings]) {
    problems.push(`${label} is not valid YAML: ${issue.code} at line ${issue.linePos?.[0]?.line ?? "?"}.`);
  }
  if (!isMap(document.contents)) problems.push(`${label} must be a YAML mapping at the top level.`);
  visit(document, {
    Alias() {
      problems.push(`${label} must not use YAML aliases (*name).`);
      return visit.BREAK;
    },
    Node(_key, node) {
      if (node.anchor) problems.push(`${label} must not use YAML anchors (&name).`);
      if (node.tag) problems.push(`${label} must not use YAML tags (${describeValue(node.tag)}).`);
    },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        problems.push(`${label} keys must be plain strings.`);
        return visit.SKIP;
      }
      if (pair.key.value === "<<") problems.push(`${label} must not use YAML merge keys (<<).`);
      return undefined;
    },
  });
  if (problems.length > 0) return { problems: [...new Set(problems)] };
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { problems: [`${label} must be a YAML mapping at the top level.`] };
  return { value: value as Record<string, unknown>, problems: [] };
}

/** Accepts exactly `https://github.com/<owner>/<repo>`: lowercase scheme and host, ASCII, no userinfo/port/query/fragment/suffix. */
export function parseMainRepo(value: unknown): MainRepository | undefined {
  if (typeof value !== "string" || value.length > GITHUB_PREFIX.length + 140) return undefined;
  if (!/^[\x21-\x7E]+$/.test(value) || !value.startsWith(GITHUB_PREFIX)) return undefined;
  const segments = value.slice(GITHUB_PREFIX.length).split("/");
  if (segments.length !== 2) return undefined;
  const [owner = "", repo = ""] = segments;
  if (!LOGIN_PATTERN.test(owner) || !REPO_NAME_PATTERN.test(repo)) return undefined;
  if (repo === "." || repo === ".." || repo.toLowerCase().endsWith(".git")) return undefined;
  return { owner, repo, fullName: `${owner}/${repo}` };
}

export function isLogin(value: unknown): value is string {
  return typeof value === "string" && LOGIN_PATTERN.test(value);
}

export function sameLogin(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isSecurityContact(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 254 || !/^[\x21-\x7E]+$/.test(value)) return false;
  if (EMAIL_PATTERN.test(value)) return true;
  if (!value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && url.hostname.includes(".");
  } catch {
    return false;
  }
}

const KNOWN_KEYS = new Set(["name", "main_repo", "repository_id", "primary_contact", "auto_ccs", "security_contact", "language", "preset", "paused"]);

/** Validates a parsed project mapping. `directory` is the name of the directory holding project.yaml, when known. */
export function validateProject(raw: Record<string, unknown>, directory?: string): { project?: Project; problems: string[] } {
  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) problems.push(`Unknown key ${describeValue(key, 40)}. Allowed keys: ${[...KNOWN_KEYS].join(", ")}.`);
  }
  const { name } = raw;
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    problems.push("name is required and must match ^[a-z0-9][a-z0-9-]{0,62}$ (lowercase letters, digits, hyphens).");
  } else if (directory !== undefined && name !== directory) {
    problems.push(`name ${describeValue(name)} must equal its directory name ${describeValue(directory)}.`);
  }
  const mainRepo = parseMainRepo(raw.main_repo);
  if (!mainRepo) {
    problems.push(`main_repo must be exactly https://github.com/<owner>/<repo> (no trailing slash, .git suffix, query, fragment, credentials, or port); got ${describeValue(raw.main_repo)}.`);
  }
  const repositoryId = raw.repository_id;
  if (typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    problems.push("repository_id is required and must be the repository's positive numeric id (gh api repos/<owner>/<repo> --jq .id).");
  }
  if (!isLogin(raw.primary_contact)) problems.push("primary_contact is required and must be a GitHub login.");
  let autoCcs: string[] = [];
  if (raw.auto_ccs !== undefined) {
    if (!Array.isArray(raw.auto_ccs) || raw.auto_ccs.length > MAX_AUTO_CCS || !raw.auto_ccs.every(isLogin)) {
      problems.push(`auto_ccs must be a list of at most ${MAX_AUTO_CCS} GitHub logins.`);
    } else {
      autoCcs = raw.auto_ccs;
      if (new Set(autoCcs.map((login) => login.toLowerCase())).size !== autoCcs.length) problems.push("auto_ccs must not contain duplicates.");
    }
  }
  if (raw.security_contact !== undefined && !isSecurityContact(raw.security_contact)) {
    problems.push("security_contact must be an email address or an https:// URL.");
  }
  if (raw.language !== undefined && (typeof raw.language !== "string" || !LANGUAGE_PATTERN.test(raw.language))) {
    problems.push("language must match ^[a-z0-9+#.-]{1,32}$.");
  }
  if (raw.preset !== undefined && !(PRESETS as unknown[]).includes(raw.preset)) {
    problems.push(`preset must be one of ${PRESETS.join(", ")}.`);
  }
  if (raw.paused !== undefined && typeof raw.paused !== "boolean") problems.push("paused must be true or false.");
  if (problems.length > 0) return { problems };
  return {
    project: {
      name: name as string,
      mainRepo: mainRepo as MainRepository,
      repositoryId: repositoryId as number,
      primaryContact: raw.primary_contact as string,
      autoCcs,
      ...(raw.security_contact !== undefined ? { securityContact: raw.security_contact as string } : {}),
      ...(raw.language !== undefined ? { language: raw.language as string } : {}),
      ...(raw.preset !== undefined ? { preset: raw.preset as Preset } : {}),
      paused: raw.paused === true,
    },
    problems: [],
  };
}

export function parseProjectText(text: string, directory?: string): { project?: Project; problems: string[] } {
  const parsed = parseStrictYaml(text, PROJECT_MAX_BYTES, PROJECT_FILE);
  if (!parsed.value) return { problems: parsed.problems };
  return validateProject(parsed.value, directory);
}
