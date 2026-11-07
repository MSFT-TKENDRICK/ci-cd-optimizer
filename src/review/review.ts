import type { GitHubClient, RepoRef } from "../github/client.js";
import { loadRepositorySnapshot } from "../github/repository.js";
import { lint } from "../lint/api.js";
import { CONFIG_PATHS, parseConfigText, type LintConfig } from "../lint/config.js";
import { allRules } from "../lint/rules/index.js";
import type { Diagnostic } from "../lint/types.js";
import { readCappedFile, verifyConsent, type VerifiedRepository } from "./consent.js";
import { sanitizeText, truncate } from "./escape.js";
import type { Project } from "./project.js";

export const REVIEW_LIMITS = { maxFiles: 200, maxFileBytes: 200_000 } as const;
export const REVIEW_CONCURRENCY = 4;
export const TARGET_CONFIG_MAX_BYTES = 64 * 1024;

export type ReviewStatus = "ok" | "invalid" | "consent-failed" | "paused" | "error";

export interface ReviewOutcome {
  project: string;
  status: ReviewStatus;
  repository?: VerifiedRepository;
  problems: string[];
  notes: string[];
  diagnostics: Diagnostic[];
  filesAnalyzed: number;
  inventoryComplete: boolean;
}

export interface ReviewOptions {
  /** `owner/repo` of the registry the consent file must name. */
  registry: string;
  /** Intake PR author; must appear in the consent contacts. Omitted for scheduled and maintainer runs. */
  author?: string;
}

async function loadTargetConfig(client: GitHubClient, repo: RepoRef, sha: string): Promise<{ config: LintConfig; notes: string[] }> {
  for (const path of CONFIG_PATHS) {
    const file = await readCappedFile(client, repo, path, sha, TARGET_CONFIG_MAX_BYTES);
    if (file.kind === "missing") continue;
    if (file.kind === "rejected") return { config: parseConfigText("", allRules).config, notes: [`${file.reason} Using the default configuration.`] };
    const parsed = parseConfigText(file.text, allRules, path);
    return { config: parsed.config, notes: parsed.problems.map((problem) => `${path}: ${problem.path} ${problem.message}`) };
  }
  return { config: parseConfigText("", allRules).config, notes: [] };
}

function clampConfig(config: LintConfig, project: Project): LintConfig {
  return {
    ...config,
    ...(project.preset ? { extends: [project.preset] } : {}),
    limits: {
      maxFiles: Math.min(config.limits.maxFiles, REVIEW_LIMITS.maxFiles),
      maxFileBytes: Math.min(config.limits.maxFileBytes, REVIEW_LIMITS.maxFileBytes),
    },
  };
}

function errorMessage(error: unknown): string {
  return truncate(sanitizeText(error instanceof Error ? error.message : String(error)), 200);
}

/**
 * Reviews a registered project through the GitHub API only: consent and repository identity are re-verified, the
 * default branch is pinned to one SHA, and the CI/CD files at that SHA are linted as data. Target code is never
 * checked out or executed.
 */
export async function reviewProject(client: GitHubClient, project: Project, options: ReviewOptions): Promise<ReviewOutcome> {
  const outcome: ReviewOutcome = { project: project.name, status: "ok", problems: [], notes: [], diagnostics: [], filesAnalyzed: 0, inventoryComplete: true };
  if (project.paused) {
    outcome.status = "paused";
    outcome.notes.push("Reviews are paused for this project (paused: true).");
    return outcome;
  }
  try {
    const consent = await verifyConsent(client, project, { registry: options.registry, ...(options.author !== undefined ? { author: options.author } : {}) });
    if (consent.repository) outcome.repository = consent.repository;
    if (!consent.ok || !consent.repository) {
      outcome.status = "consent-failed";
      outcome.problems.push(...consent.problems);
      return outcome;
    }
    const repository = consent.repository;
    const target: RepoRef = { owner: repository.owner, repo: repository.repo };
    const loaded = await loadTargetConfig(client, target, repository.sha);
    outcome.notes.push(...loaded.notes);
    if (!loaded.config.enabled) {
      outcome.notes.push("The repository's .github/ci-cd-optimizer.yml sets enabled: false, so no rules ran.");
      return outcome;
    }
    const config = clampConfig(loaded.config, project);
    const snapshot = await loadRepositorySnapshot(client, target, {
      ref: repository.sha,
      config: { ignorePaths: config.ignorePaths, limits: config.limits },
      resolvedRevision: { sha: repository.sha, treeSha: repository.treeSha },
      concurrency: REVIEW_CONCURRENCY,
    });
    const result = lint({ input: snapshot.input, config });
    outcome.diagnostics = result.diagnostics;
    outcome.filesAnalyzed = result.filesAnalyzed;
    outcome.inventoryComplete = snapshot.input.inventoryComplete;
    if (!snapshot.input.inventoryComplete) {
      outcome.notes.push(`Only part of the repository was reviewed (limits: ${REVIEW_LIMITS.maxFiles} files, ${REVIEW_LIMITS.maxFileBytes} bytes per file).`);
    }
    if (result.parseProblems.length > 0) outcome.notes.push(`${result.parseProblems.length} file(s) could not be parsed and were skipped.`);
    return outcome;
  } catch (error) {
    outcome.status = "error";
    outcome.problems.push(`The review could not complete: ${errorMessage(error)}`);
    return outcome;
  }
}
