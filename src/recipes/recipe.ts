import { parse, stringify } from "yaml";
import { RECIPE_RISKS, type RecipeRisk } from "../lint/config.js";
import type { ExperimentManifest } from "../experiments/manifest.js";
import { signatureOf } from "../issues/markers.js";
import { matchesGlob } from "../utils.js";

export const RECIPES_DIR = "recipes";
export const RECIPE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MAX_PATCH_CHARS = 60_000;

export interface RecipeMetric {
  metric: string;
  control?: number;
  arm?: number;
  delta: number;
  pValue?: number;
}

export interface RecipeCompatibility {
  passed: number;
  failed: number;
}

/**
 * A promoted pipeline experiment packaged for reuse, analogous to a Dependabot update: what changed, why it is
 * believed to help (evidence), how risky it is, and how often it has worked elsewhere (compatibility).
 */
export interface Recipe {
  schemaVersion: 1;
  id: string;
  /** Increments whenever the content that targets receive changes. */
  revision: number;
  title: string;
  summary: string;
  risk: RecipeRisk;
  /** Lint rules whose findings the recipe resolves; their autofixes are applied to targets. */
  rules: string[];
  /** Globs that make the recipe applicable when it has no rules. */
  files: string[];
  description?: string;
  /** The winning arm's approach, used as instructions for coding agents adapting the recipe. */
  instructions: string;
  evidence: { improvement: number; metrics: RecipeMetric[] };
  source: { repository: string; experiment: string; arm: string; pullRequest?: number; promotedAt?: string };
  /** Reference unified diff of the winning arm (may be truncated). */
  patch?: string;
  patchFiles: string[];
  compatibility: RecipeCompatibility;
}

export const recipePath = (id: string, dir = RECIPES_DIR) => `${dir.replace(/\/+$/, "")}/${id}.yml`;

const RISK_RANK: Record<RecipeRisk, number> = { low: 1, medium: 2, high: 3 };
export const riskAtMost = (risk: RecipeRisk, max: RecipeRisk) => RISK_RANK[risk] <= RISK_RANK[max];

const MANIFEST = /(^|\/)(package\.json|pnpm-workspace\.yaml|go\.mod|Cargo\.toml|pyproject\.toml|setup\.py|setup\.cfg|Gemfile|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|[^/]+\.(csproj|fsproj|sln)|requirements[^/]*\.txt|nx\.json|turbo\.json|lerna\.json|WORKSPACE|MODULE\.bazel|BUILD(\.bazel)?)$/i;
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|uv\.lock|packages\.lock\.json|Gemfile\.lock)$/i;
const CONTAINER = /(^|\/)((Dockerfile|Containerfile)(\.[^/]+)?|[^/]+\.(dockerfile|containerfile)|\.dockerignore|(docker-)?compose\.ya?ml)$/i;
const PIPELINE = /^\.github\/(workflows\/[^/]+\.ya?ml|actions\/.+)$|(^|\/)action\.ya?ml$/;

/**
 * Risk of applying a change elsewhere: workflow-only edits are low (they cannot change what is built), container
 * edits are medium, and edits to package manifests/lockfiles or wide changes are high.
 */
export function classifyRisk(paths: readonly string[]): RecipeRisk {
  if (paths.length > 10 || paths.some((path) => MANIFEST.test(path) || LOCKFILE.test(path))) return "high";
  if (paths.some((path) => CONTAINER.test(path) || !PIPELINE.test(path))) return "medium";
  return "low";
}

export interface PullRequestFile {
  filename: string;
  status: string;
  patch?: string;
  previous_filename?: string;
}

/** Experiment bookkeeping and benchmark fixtures are not part of the reusable change. */
export const DEFAULT_PATCH_EXCLUDES = ["experiments/**", "corpus/**", ".github/hill-climb.yml"];

export function renderPatch(files: readonly PullRequestFile[], max = MAX_PATCH_CHARS): string {
  let out = "";
  for (const file of files) {
    const from = file.status === "added" ? "/dev/null" : `a/${file.previous_filename ?? file.filename}`;
    const to = file.status === "removed" ? "/dev/null" : `b/${file.filename}`;
    const section = [`diff --git a/${file.previous_filename ?? file.filename} b/${file.filename}`, `--- ${from}`, `+++ ${to}`, file.patch ?? "(binary or too large to show)", ""].join("\n");
    if (out.length + section.length > max) return `${out}# … truncated; see the source pull request for the full change.\n`;
    out += section;
  }
  return out;
}

export interface BuildRecipeOptions {
  manifest: ExperimentManifest;
  repository: string;
  files: readonly PullRequestFile[];
  pullRequest?: number;
  promotedAt?: string;
  previous?: Recipe;
  excludes?: readonly string[];
}

export type BuildRecipeResult = { recipe: Recipe; changed: boolean } | { error: string; skipped?: boolean };

const contentSignature = (recipe: Recipe) => signatureOf([
  recipe.title, recipe.summary, recipe.risk, recipe.description ?? "",
  JSON.stringify(recipe.rules), JSON.stringify(recipe.files), JSON.stringify(recipe.patchFiles),
  recipe.patch ?? "", recipe.instructions, recipe.source.repository, recipe.source.experiment, recipe.source.arm,
  String(recipe.source.pullRequest ?? ""),
]);

/** Builds (or re-builds, bumping the revision when content changed) the recipe for a promoted pipeline experiment. */
export function buildRecipe(options: BuildRecipeOptions): BuildRecipeResult {
  const { manifest } = options;
  if (manifest.kind !== "pipeline") {
    return { skipped: true, error: `Experiment "${manifest.name}" changes the linter itself (kind: ${manifest.kind}); only pipeline experiments become recipes.` };
  }
  if (manifest.status !== "promoted" || !manifest.winner) return { skipped: true, error: `Experiment "${manifest.name}" has not been promoted (status: ${manifest.status}).` };
  const arm = manifest.arms.find((candidate) => candidate.name === manifest.winner);
  if (!arm) return { error: `Winning arm "${manifest.winner}" is not declared in the manifest.` };
  const excludes = options.excludes ?? DEFAULT_PATCH_EXCLUDES;
  const files = options.files.filter((file) => !excludes.some((glob) => matchesGlob(file.filename, glob)));
  const patchFiles = files.map((file) => file.filename).sort();
  const rules = [...(manifest.applicability?.rules ?? [])].sort();
  const globs = manifest.applicability?.files ?? [];
  if (rules.length === 0 && globs.length === 0 && patchFiles.length === 0) {
    return { error: `Experiment "${manifest.name}" declares no applicability (rules or files) and its winning arm changed no files.` };
  }
  const patch = files.length > 0 ? renderPatch(files) : undefined;
  const draft: Recipe = {
    schemaVersion: 1,
    id: manifest.name,
    revision: 1,
    title: manifest.title,
    summary: manifest.hypothesis,
    risk: classifyRisk(patchFiles),
    rules,
    // Without explicit globs, the files the winner touched decide applicability.
    files: globs.length > 0 ? [...globs] : rules.length === 0 ? patchFiles : [],
    ...(manifest.applicability?.description ? { description: manifest.applicability.description } : {}),
    instructions: `${arm.title}: ${arm.approach}`,
    evidence: { improvement: manifest.evidence?.improvement ?? 0, metrics: manifest.evidence?.metrics.map((metric) => ({ ...metric })) ?? [] },
    source: {
      repository: options.repository,
      experiment: manifest.name,
      arm: arm.name,
      ...(options.pullRequest !== undefined ? { pullRequest: options.pullRequest } : {}),
      ...(options.promotedAt ? { promotedAt: options.promotedAt } : {}),
    },
    ...(patch ? { patch } : {}),
    patchFiles,
    compatibility: { passed: 0, failed: 0 },
  };
  const previous = options.previous;
  if (!previous) return { recipe: draft, changed: true };
  const same = contentSignature(previous) === contentSignature(draft);
  const recipe: Recipe = { ...draft, revision: same ? previous.revision : previous.revision + 1, compatibility: same ? previous.compatibility : { passed: 0, failed: 0 } };
  return { recipe, changed: serializeRecipe(recipe) !== serializeRecipe(previous) };
}

export function serializeRecipe(recipe: Recipe): string {
  return stringify(recipe, { lineWidth: 0 });
}

export interface ParsedRecipe {
  recipe?: Recipe;
  problems: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

export function parseRecipe(text: string): ParsedRecipe {
  let raw: unknown;
  try {
    raw = parse(text, { maxAliasCount: 100 });
  } catch (error) {
    return { problems: [`Invalid YAML: ${(error as Error).message}`] };
  }
  if (!isRecord(raw)) return { problems: ["A recipe must be a mapping."] };
  const problems: string[] = [];
  if (raw.schemaVersion !== 1) problems.push("schemaVersion must be 1.");
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!RECIPE_ID.test(id)) problems.push("id must be lowercase letters, digits and dashes.");
  for (const key of ["title", "summary", "instructions"] as const) if (typeof raw[key] !== "string" || !raw[key]) problems.push(`${key} is required.`);
  if (!RECIPE_RISKS.includes(raw.risk as RecipeRisk)) problems.push(`risk must be one of ${RECIPE_RISKS.join(", ")}.`);
  const source = isRecord(raw.source) ? raw.source : {};
  if (typeof source.repository !== "string" || typeof source.experiment !== "string" || typeof source.arm !== "string") {
    problems.push("source.repository, source.experiment and source.arm are required.");
  }
  const rules = strings(raw.rules);
  const files = strings(raw.files);
  if (rules.length === 0 && files.length === 0) problems.push("A recipe needs rules or files to decide where it applies.");
  if (problems.length > 0) return { problems };
  const evidence = isRecord(raw.evidence) ? raw.evidence : {};
  const compatibility = isRecord(raw.compatibility) ? raw.compatibility : {};
  const pullRequest = num(source.pullRequest);
  return {
    problems,
    recipe: {
      schemaVersion: 1,
      id,
      revision: Math.max(1, Math.floor(num(raw.revision) ?? 1)),
      title: raw.title as string,
      summary: raw.summary as string,
      risk: raw.risk as RecipeRisk,
      rules,
      files,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      instructions: raw.instructions as string,
      evidence: {
        improvement: num(evidence.improvement) ?? 0,
        metrics: (Array.isArray(evidence.metrics) ? evidence.metrics : []).filter(isRecord).map((metric) => ({
          metric: String(metric.metric ?? ""),
          delta: num(metric.delta) ?? 0,
          ...(num(metric.control) !== undefined ? { control: num(metric.control) as number } : {}),
          ...(num(metric.arm) !== undefined ? { arm: num(metric.arm) as number } : {}),
          ...(num(metric.pValue) !== undefined ? { pValue: num(metric.pValue) as number } : {}),
        })),
      },
      source: {
        repository: source.repository as string,
        experiment: source.experiment as string,
        arm: source.arm as string,
        ...(pullRequest !== undefined ? { pullRequest } : {}),
        ...(typeof source.promotedAt === "string" ? { promotedAt: source.promotedAt } : {}),
      },
      ...(typeof raw.patch === "string" && raw.patch ? { patch: raw.patch } : {}),
      patchFiles: strings(raw.patchFiles),
      compatibility: { passed: Math.max(0, num(compatibility.passed) ?? 0), failed: Math.max(0, num(compatibility.failed) ?? 0) },
    },
  };
}

export function sourceUrl(recipe: Recipe, server = "https://github.com"): string {
  const base = `${server}/${recipe.source.repository}`;
  return recipe.source.pullRequest !== undefined ? `${base}/pull/${recipe.source.pullRequest}` : base;
}
