import { type GitHubClient, httpStatus, type RepoRef } from "../github/client.js";
import { resolveRepositoryRevision } from "../github/repository.js";
import { describeValue } from "./escape.js";
import { isLogin, parseStrictYaml, type Project, sameLogin } from "./project.js";

export const CONSENT_PATH = ".github/ci-cd-optimizer-review.yml";
export const CONSENT_MAX_BYTES = 4 * 1024;
export const MAX_CONSENT_CONTACTS = 50;
export const DEFAULT_REGISTRY = "MSFT-TKENDRICK/ci-cd-optimizer";

export interface ConsentFile {
  registry: string;
  project: string;
  contacts: string[];
}

export interface VerifiedRepository {
  id: number;
  fullName: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  sha: string;
  treeSha: string;
}

export interface ConsentResult {
  ok: boolean;
  problems: string[];
  /** Present once repository identity checks pass, even when the consent file itself fails. */
  repository?: VerifiedRepository;
}

export type CappedFile = { kind: "file"; text: string } | { kind: "missing" } | { kind: "rejected"; reason: string };

/** Reads one file through the contents API at an exact ref, refusing non-files and anything above `maxBytes`. */
export async function readCappedFile(client: GitHubClient, repo: RepoRef, path: string, ref: string, maxBytes: number): Promise<CappedFile> {
  let data: unknown;
  try {
    ({ data } = await client.request("GET /repos/{owner}/{repo}/contents/{path}", { ...repo, path, ref }));
  } catch (error) {
    if (httpStatus(error) === 404) return { kind: "missing" };
    throw error;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { kind: "rejected", reason: `${path} is not a regular file.` };
  const file = data as { type?: unknown; size?: unknown; encoding?: unknown; content?: unknown };
  if (file.type !== "file") return { kind: "rejected", reason: `${path} is not a regular file.` };
  if (typeof file.size !== "number" || file.size > maxBytes) return { kind: "rejected", reason: `${path} is larger than ${maxBytes} bytes.` };
  if (file.encoding !== "base64" || typeof file.content !== "string") return { kind: "rejected", reason: `${path} could not be read as base64 content.` };
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.length > maxBytes) return { kind: "rejected", reason: `${path} is larger than ${maxBytes} bytes.` };
  return { kind: "file", text: bytes.toString("utf8") };
}

export function parseConsentText(text: string): { consent?: ConsentFile; problems: string[] } {
  const parsed = parseStrictYaml(text, CONSENT_MAX_BYTES, CONSENT_PATH);
  if (!parsed.value) return { problems: parsed.problems };
  const raw = parsed.value;
  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!["registry", "project", "contacts"].includes(key)) problems.push(`${CONSENT_PATH} has unknown key ${describeValue(key, 40)}.`);
  }
  if (typeof raw.registry !== "string" || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(raw.registry)) {
    problems.push(`${CONSENT_PATH} registry must be <owner>/<repo> of the review registry (${DEFAULT_REGISTRY}).`);
  }
  if (typeof raw.project !== "string" || raw.project.length === 0 || raw.project.length > 63) problems.push(`${CONSENT_PATH} project must be the project name.`);
  const contacts = raw.contacts;
  if (!Array.isArray(contacts) || contacts.length === 0 || contacts.length > MAX_CONSENT_CONTACTS || !contacts.every(isLogin)) {
    problems.push(`${CONSENT_PATH} contacts must be a list of 1-${MAX_CONSENT_CONTACTS} GitHub logins.`);
  } else if (new Set(contacts.map((login) => login.toLowerCase())).size !== contacts.length) {
    problems.push(`${CONSENT_PATH} contacts must not contain duplicates.`);
  }
  if (problems.length > 0) return { problems };
  return { consent: { registry: raw.registry as string, project: raw.project as string, contacts: contacts as string[] }, problems: [] };
}

interface RepositoryMetadata {
  id?: unknown;
  full_name?: unknown;
  name?: unknown;
  owner?: { login?: unknown } | null;
  private?: unknown;
  visibility?: unknown;
  fork?: unknown;
  archived?: unknown;
  disabled?: unknown;
  default_branch?: unknown;
}

export interface ConsentOptions {
  registry: string;
  /** Login of the person asking for the review (the intake PR author). Must be listed in the consent contacts. */
  author?: string;
}

/**
 * Verifies the target repository by its immutable id, pins its default-branch SHA, and checks the consent file at
 * that SHA. Collaborator permissions are deliberately not queried: that endpoint needs push access to the target,
 * which the program's token does not (and should not) have. Instead the target repository itself lists who may
 * speak for it, and only someone with write access can change that file.
 */
export async function verifyConsent(client: GitHubClient, project: Project, options: ConsentOptions): Promise<ConsentResult> {
  let metadata: RepositoryMetadata;
  try {
    ({ data: metadata } = (await client.request("GET /repositories/{repository_id}", { repository_id: project.repositoryId })) as { data: RepositoryMetadata });
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404 || status === 403 || status === 451) {
      return { ok: false, problems: [`Repository id ${project.repositoryId} was not found or is not public.`] };
    }
    throw error;
  }
  const problems: string[] = [];
  if (metadata.id !== project.repositoryId) problems.push(`Repository id ${project.repositoryId} did not resolve to the same repository.`);
  const fullName = typeof metadata.full_name === "string" ? metadata.full_name : "";
  if (fullName.toLowerCase() !== project.mainRepo.fullName.toLowerCase()) {
    problems.push(`repository_id ${project.repositoryId} is now ${describeValue(fullName)}, not ${describeValue(project.mainRepo.fullName)}. If the repository was renamed or transferred, update main_repo in a new pull request.`);
  }
  if (metadata.private !== false || (metadata.visibility !== undefined && metadata.visibility !== "public")) problems.push("The repository must be public.");
  if (metadata.fork !== false) problems.push("The repository must not be a fork; submit the upstream repository.");
  if (metadata.archived === true) problems.push("The repository is archived.");
  if (metadata.disabled === true) problems.push("The repository is disabled.");
  const defaultBranch = typeof metadata.default_branch === "string" ? metadata.default_branch : "";
  if (!defaultBranch) problems.push("The repository has no default branch.");
  if (problems.length > 0) return { ok: false, problems };

  const [owner = "", repo = ""] = fullName.split("/");
  const target: RepoRef = { owner, repo };
  const revision = await resolveRepositoryRevision(client, target, defaultBranch);
  const repository: VerifiedRepository = { id: project.repositoryId, fullName, owner, repo, defaultBranch, sha: revision.sha, treeSha: revision.treeSha };

  const file = await readCappedFile(client, target, CONSENT_PATH, revision.sha, CONSENT_MAX_BYTES);
  if (file.kind === "missing") {
    return { ok: false, repository, problems: [`${CONSENT_PATH} was not found on the default branch. Maintainers must commit it to consent to reviews; deleting it opts out.`] };
  }
  if (file.kind === "rejected") return { ok: false, repository, problems: [file.reason] };
  const parsed = parseConsentText(file.text);
  if (!parsed.consent) return { ok: false, repository, problems: parsed.problems };
  const { consent } = parsed;
  if (consent.registry.toLowerCase() !== options.registry.toLowerCase()) {
    problems.push(`${CONSENT_PATH} registry is ${describeValue(consent.registry)}; expected ${describeValue(options.registry)}.`);
  }
  if (consent.project !== project.name) problems.push(`${CONSENT_PATH} project is ${describeValue(consent.project)}; expected ${describeValue(project.name)}.`);
  const listed = (login: string) => consent.contacts.some((contact) => sameLogin(contact, login));
  if (!listed(project.primaryContact)) problems.push(`primary_contact ${describeValue(project.primaryContact)} is not listed in ${CONSENT_PATH} contacts.`);
  for (const cc of project.autoCcs) {
    if (!listed(cc)) problems.push(`auto_ccs entry ${describeValue(cc)} is not listed in ${CONSENT_PATH} contacts.`);
  }
  if (options.author !== undefined && !listed(options.author)) {
    problems.push(`Submitter ${describeValue(options.author)} is not listed in ${CONSENT_PATH} contacts.`);
  }
  return { ok: problems.length === 0, repository, problems };
}
