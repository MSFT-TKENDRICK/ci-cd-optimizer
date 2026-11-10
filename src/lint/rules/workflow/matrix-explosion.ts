import { isScalar, type Node } from "yaml";
import type { JobModel, WorkflowModel } from "../../parsers/workflow.js";
import { field, items, type YamlSource } from "../../parsers/yaml.js";
import { defineRule } from "../helpers.js";

const LIMIT = 256;
const ENUMERATION_CAP = 50_000;

type Combo = Record<string, unknown>;

interface Dimension {
  name: string;
  values: unknown[];
  /** Source text of each value (keeps quoting such as `"3.10"`), when every value is a scalar. */
  texts?: string[];
}

interface Expansion {
  count: number;
  /** True when the count is a lower bound (too many combinations to enumerate). */
  atLeast: boolean;
  dimensions: Dimension[];
  includes: number;
  excludes: number;
}

const isPrimitive = (value: unknown): boolean => value === null || ["string", "number", "boolean"].includes(typeof value);
const same = (a: unknown, b: unknown): boolean => isPrimitive(a) && isPrimitive(b) && a === b;

function records(value: unknown): Combo[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry)) ? (value as Combo[]) : undefined;
}

function scalarTexts(source: YamlSource, content: string, node: Node | null | undefined): string[] | undefined {
  const nodes = items(source, node);
  const texts = nodes.map((item) => (isScalar(item) && item.range ? content.slice(item.range[0], item.range[1]) : undefined));
  const flowSafe = (text: string | undefined): text is string =>
    text !== undefined && !text.includes("\n") && (/^["']/.test(text) || !/[,[\]{}]/.test(text));
  return texts.every(flowSafe) ? texts : undefined;
}

/** Applies GitHub's documented matrix expansion: cross product, then `exclude` (partial match), then `include`. */
function expand(source: YamlSource, content: string, matrixNode: Node | null | undefined, matrix: Combo): Expansion | undefined {
  if ("__expression" in matrix) return undefined;
  const includes = records(matrix.include);
  const excludes = records(matrix.exclude);
  if (!includes || !excludes) return undefined;
  if (excludes.some((entry) => Object.values(entry).some((value) => !isPrimitive(value) || String(value).includes("${{")))) return undefined;
  const dimensions: Dimension[] = [];
  for (const [name, values] of Object.entries(matrix)) {
    if (name === "include" || name === "exclude") continue;
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value === "string" && value.includes("${{"))) return undefined;
    const texts = values.every(isPrimitive) ? scalarTexts(source, content, field(source, matrixNode, name)?.value) : undefined;
    dimensions.push({ name, values, ...(texts && texts.length === values.length ? { texts } : {}) });
  }
  const original = new Set(dimensions.map((dimension) => dimension.name));
  if (includes.some((entry) => Object.entries(entry).some(([key, value]) => original.has(key) && !isPrimitive(value)))) return undefined;
  const summary = { dimensions, includes: includes.length, excludes: excludes.length };
  if (dimensions.length === 0) return { count: includes.length, atLeast: false, ...summary };
  const product = dimensions.reduce((total, dimension) => total * dimension.values.length, 1);
  if (product > ENUMERATION_CAP) {
    return excludes.length > 0 ? undefined : { count: product, atLeast: true, ...summary };
  }
  let combos: Combo[] = [{}];
  for (const dimension of dimensions) {
    combos = combos.flatMap((combo) => dimension.values.map((value) => ({ ...combo, [dimension.name]: value })));
  }
  combos = combos.filter((combo) => !excludes.some((entry) => Object.entries(entry).every(([key, value]) => same(combo[key], value))));
  let added = 0;
  for (const entry of includes) {
    const keys = Object.entries(entry).filter(([key]) => original.has(key));
    if (!combos.some((combo) => keys.every(([key, value]) => same(combo[key], value)))) added += 1;
  }
  return { count: combos.length + added, atLeast: false, ...summary };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const matrixRef = (name: string): RegExp => new RegExp(`matrix\\.${escapeRegExp(name)}(?![\\w-])`);

function runnerDimension(job: JobModel, dimensions: Dimension[]): Dimension | undefined {
  const text = JSON.stringify(job.runsOn?.value ?? "");
  return dimensions.find((dimension) => matrixRef(dimension.name).test(text));
}

const SHARD_NAME = /shard|chunk|partition|split|slice|bucket|index|^(part|group|worker|seed|attempt|iteration|run)s?$/i;
const SHARD_USE = /shard|chunk|partition|split|slice|--total|--group|--part|--index/i;
const VERSION_NAME =
  /version|^(node|nodejs|python|py|pypy|go|golang|java|jdk|ruby|php|dotnet|rust|deno|bun|elixir|otp|erlang|scala|kotlin|swift|perl|julia|ghc|zig|lua|django|rails|flask|react|angular|vue|typescript|k8s|kubernetes|postgres|postgresql|pg|mysql|mariadb|redis|mongo|mongodb|elasticsearch|terraform|gradle|maven|electron|xcode|cuda|torch|pytorch|numpy|pandas)$/i;
const VERSION_VALUE = /^v?\d+(?:\.(?:\d+|x|\*))*$/i;

const unquote = (text: string): string => text.replace(/^(["'])(.*)\1$/, "$2");

/** Dimensions whose every value is needed: test shards, partitions and repetitions. */
function isShardDimension(job: JobModel, name: string): boolean {
  if (SHARD_NAME.test(name)) return true;
  const ref = matrixRef(name);
  return job.steps.some((step) => (step.run?.value ?? "").split("\n").some((line) => ref.test(line) && SHARD_USE.test(line)));
}

/** A version range (`node: [18, 20, 22]`, `python: ["3.9", "3.13"]`) where the oldest and newest values bound the rest. */
function isVersionDimension(dimension: Dimension): boolean {
  const values = (dimension.texts ?? []).map(unquote);
  if (values.length === 0 || !values.every((value) => VERSION_VALUE.test(value))) return false;
  return VERSION_NAME.test(dimension.name) || values.some((value) => value.includes("."));
}

function versionParts(text: string): number[] {
  return unquote(text)
    .replace(/^v/i, "")
    .split(".")
    .map((part) => (/^\d+$/.test(part) ? Number(part) : Number.POSITIVE_INFINITY));
}

function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? -1) - (right[index] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

const MAX_INCLUDE_ROWS = 24;

/**
 * A sparse alternative: the oldest and newest value of every version dimension, every value of the other dimensions,
 * plus `include` rows that run each extra runner at the newest versions (and on every shard, so each leg still runs the whole suite).
 * Undefined when no dimension can be thinned.
 */
function sparseSuggestion(job: JobModel, expansion: Expansion): { snippet: string; count: number } | undefined {
  const { dimensions } = expansion;
  if (expansion.includes > 0 || expansion.excludes > 0) return undefined;
  if (dimensions.some((dimension) => !dimension.texts)) return undefined;
  const runner = runnerDimension(job, dimensions);
  const shards = new Set(dimensions.filter((dimension) => dimension !== runner && isShardDimension(job, dimension.name)));
  const kept = new Map<Dimension, string[]>();
  const leg = new Map<Dimension, string>();
  for (const dimension of dimensions) {
    const texts = dimension.texts ?? [];
    if (dimension === runner) {
      kept.set(dimension, texts.slice(0, 1));
    } else if (!shards.has(dimension) && isVersionDimension(dimension)) {
      const sorted = [...texts].sort(compareVersions);
      kept.set(dimension, texts.length > 2 ? [sorted[0] ?? "", sorted.at(-1) ?? ""] : texts);
      leg.set(dimension, sorted.at(-1) ?? "");
    } else {
      kept.set(dimension, texts);
      leg.set(dimension, texts.at(-1) ?? "");
    }
  }
  const lines = ["strategy:", "  matrix:"];
  let count = 1;
  for (const dimension of dimensions) {
    const values = kept.get(dimension) ?? [];
    count *= values.length;
    lines.push(`    ${dimension.name}: [${values.join(", ")}]`);
  }
  const others = runner ? (runner.texts ?? []).slice(1) : [];
  if (runner && others.length > 0) {
    let shardCombos: Array<Map<Dimension, string>> = [new Map()];
    for (const dimension of dimensions) {
      if (dimension === runner || (!shards.has(dimension) && isVersionDimension(dimension))) continue;
      shardCombos = shardCombos.flatMap((combo) => (dimension.texts ?? []).map((text) => new Map([...combo, [dimension, text]])));
    }
    if (others.length * shardCombos.length > MAX_INCLUDE_ROWS) return undefined;
    lines.push("    include:");
    for (const text of others) {
      for (const combo of shardCombos) {
        const pairs = dimensions.map(
          (dimension) => `${dimension.name}: ${dimension === runner ? text : (combo.get(dimension) ?? leg.get(dimension) ?? "")}`,
        );
        lines.push(`      - { ${pairs.join(", ")} }`);
        count += 1;
      }
    }
  }
  return count < expansion.count ? { snippet: lines.join("\n"), count } : undefined;
}

function jobNode(workflow: WorkflowModel, job: JobModel): Node | null | undefined {
  const source = workflow.source;
  return field(source, field(source, source.doc.contents, "jobs")?.value, job.id)?.value;
}

export default defineRule({
  meta: {
    id: "workflow/matrix-explosion",
    ruleset: "workflow",
    description:
      "A `strategy.matrix` whose version and runner dimensions multiply past the configured job budget, or past GitHub's 256-job limit.",
    rationale:
      "A matrix runs jobs for its dimension combinations and can increase runner usage and queueing. GitHub limits a matrix to 256 jobs. A configured budget is an engineering preference, not evidence that intermediate versions are redundant: reducing version coverage can miss version-specific regressions. Suggested smaller matrices preserve all categorical and shard combinations on every retained runner, but deliberately reduce version combinations and require a coverage decision. Existing include/exclude rules are never replaced automatically.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["agentic", "strict"],
    requires: [],
    defaultOptions: { maxJobs: 20 },
    validateOptions: (options) =>
      Number.isInteger(options.maxJobs) && (options.maxJobs as number) >= 1 && (options.maxJobs as number) <= LIMIT
        ? []
        : [`maxJobs must be an integer between 1 and ${LIMIT}`],
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstrategymatrix",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstrategymatrixinclude",
      "https://docs.github.com/en/actions/reference/limits#job-concurrency-limits-for-github-hosted-runners",
    ],
    impact: "medium",
    example: {
      bad: "strategy:\n  matrix:\n    os: [ubuntu-latest, windows-latest, macos-latest]\n    node: [18, 20, 22, 24]\n    db: [postgres, mysql]",
      good: "# Only after accepting reduced version coverage:\nstrategy:\n  matrix:\n    os: [ubuntu-latest]\n    node: [18, 24]\n    db: [postgres, mysql]\n    include:\n      - { os: windows-latest, node: 24, db: postgres }\n      - { os: windows-latest, node: 24, db: mysql }\n      - { os: macos-latest, node: 24, db: postgres }\n      - { os: macos-latest, node: 24, db: mysql }",
    },
  },
  check({ project, options, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      const source = workflow.source;
      const content = project.files.get(workflow.path)?.content ?? "";
      for (const job of workflow.jobs) {
        if (!job.matrix) continue;
        const matrixField = field(source, field(source, jobNode(workflow, job), "strategy")?.value, "matrix");
        const expansion = expand(source, content, matrixField?.value, job.matrix);
        if (!matrixField || !expansion || expansion.count <= options.maxJobs) continue;
        const sparse = sparseSuggestion(job, expansion);
        // Pure fan-out (shards, packages, explicit object rows) is deliberate parallelism; only GitHub's hard limit applies to it.
        if (!sparse && expansion.count <= LIMIT && !expansion.dimensions.some((dimension) => isVersionDimension(dimension) && !isShardDimension(job, dimension.name))) continue;
        const breakdown = [
          expansion.dimensions.map((dimension) => `${dimension.name} ${dimension.values.length}`).join(" × "),
          expansion.excludes > 0 ? `${expansion.excludes} exclude` : "",
          expansion.includes > 0 ? `${expansion.includes} include` : "",
        ]
          .filter(Boolean)
          .join(", ");
        const total = `${expansion.atLeast ? "at least " : ""}${expansion.count}`;
        const limit =
          expansion.count > LIMIT
            ? ` GitHub rejects it: "A matrix will generate a maximum of 256 jobs per workflow run."`
            : ` That is above the configured ${options.maxJobs}-job budget; actual queueing depends on available runners and account limits.`;
        const carry = expansion.includes > 0 || expansion.excludes > 0 ? " Re-check existing `include`/`exclude` entries against the reduced values." : "";
        report({
          path: workflow.path,
          line: matrixField.line,
          key: `${job.key}.strategy.matrix`,
          message: `Matrix of job \`${job.id}\` expands to ${total} jobs (${breakdown}).${limit}`,
          suggestion: sparse
            ? `If reduced version coverage is acceptable, test the oldest and newest version on the first runner and the newest on additional runners (${sparse.count} jobs). Every categorical and shard combination is retained on each runner. This is a coverage tradeoff, not an equivalent replacement:\n\n${sparse.snippet}`.trim()
            : `Review the intended coverage and runner budget without dropping categorical or shard combinations. Preserve existing include/exclude semantics; no replacement is generated for this matrix.${carry}${expansion.count > LIMIT ? " Split it into jobs or workflows within GitHub's 256-job limit." : ""}`,
        });
      }
    }
  },
});
