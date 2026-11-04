import { parse, stringify } from "yaml";
import { Validator, type ConfigProblem } from "../lint/config.js";
import type { HillClimbConfig, Rubric } from "./config.js";

/**
 * Branch layout. Git cannot store both `experiments/<name>` and `experiments/<name>/<arm>` (a ref cannot be a file
 * and a directory), so the experiment's control branch is `experiments/<name>/trunk`. Arms branch from trunk and open
 * pull requests into it; the winning arm is merged into trunk, and trunk is promoted to the default branch.
 */
export const EXPERIMENT_PREFIX = "experiments/";
export const TRUNK = "trunk";
const NAME = /^[a-z0-9][a-z0-9-]{1,47}$/;

export const trunkBranch = (experiment: string) => `${EXPERIMENT_PREFIX}${experiment}/${TRUNK}`;
export const armBranch = (experiment: string, arm: string) => `${EXPERIMENT_PREFIX}${experiment}/${arm}`;
export const manifestPath = (experiment: string) => `experiments/${experiment}/experiment.yml`;

export function parseExperimentRef(ref: string): { experiment: string; arm: string } | undefined {
  const match = /^(?:refs\/heads\/)?experiments\/([^/]+)\/([^/]+)$/.exec(ref);
  if (!match || !NAME.test(match[1] as string) || !NAME.test(match[2] as string)) return undefined;
  return { experiment: match[1] as string, arm: match[2] as string };
}

export type ExperimentKind = "rules" | "pipeline";
export type ExperimentStatus = "running" | "promoted" | "rejected" | "expired";

export interface ArmSpec {
  name: string;
  title: string;
  /** Implementation brief for the agent that builds the arm. */
  approach: string;
}

export interface ExperimentManifest {
  name: string;
  title: string;
  hypothesis: string;
  /** `rules`: evolve the linter, measured on the benchmark corpus. `pipeline`: change CI/CD, measured on run telemetry. */
  kind: ExperimentKind;
  /** Metric ids from the hill-climb configuration (default: every metric of the matching source). */
  metrics?: string[];
  rubric: { scores: Record<string, number>; rationale: string };
  arms: ArmSpec[];
  createdAt: string;
  expiresAt: string;
  status: ExperimentStatus;
  winner?: string;
  /** What a promoted result generalizes to; seeds the portable recipe. */
  applicability?: { rules?: string[]; files?: string[]; description?: string };
  source?: { findings?: string[]; issues?: number[]; notes?: string };
  /** Measured outcome of the winning arm, recorded at promotion and carried into the recipe. */
  evidence?: ExperimentEvidence;
}

export interface ExperimentEvidence {
  /** Weighted relative improvement over the control (0.25 = 25% better). */
  improvement: number;
  metrics: Array<{ metric: string; control?: number; arm?: number; delta: number; pValue?: number }>;
}

export interface ParsedManifest {
  manifest?: ExperimentManifest;
  problems: ConfigProblem[];
}

export function validateManifest(input: unknown, options: { config?: HillClimbConfig } = {}): ParsedManifest {
  const v = new Validator();
  const root = v.record("", input);
  v.unknownKeys("", root, ["name", "title", "hypothesis", "kind", "metrics", "rubric", "arms", "createdAt", "expiresAt", "status", "winner", "applicability", "source", "evidence"]);
  const name = v.string("name", root.name, "");
  if (!NAME.test(name)) v.problem("name", "Use 2-48 lowercase letters, digits, or dashes.");
  const required = (key: string) => {
    const value = v.string(key, root[key], "");
    if (!value.trim()) v.problem(key, "Required.");
    return value;
  };
  const title = required("title");
  const hypothesis = required("hypothesis");
  const kind = v.oneOf("kind", root.kind, ["rules", "pipeline"] as const, "rules");
  const rubricRaw = v.record("rubric", root.rubric);
  v.unknownKeys("rubric", rubricRaw, ["scores", "rationale"]);
  const scores: Record<string, number> = {};
  for (const [key, value] of Object.entries(v.record("rubric.scores", rubricRaw.scores))) {
    const score = v.number(`rubric.scores.${key}`, value, 0, 1);
    if (score > 5) v.problem(`rubric.scores.${key}`, "Scores range from 1 to 5.");
    scores[key] = score;
  }
  const arms: ArmSpec[] = [];
  if (!Array.isArray(root.arms) || root.arms.length === 0) v.problem("arms", "Define at least one arm.");
  else {
    root.arms.forEach((entry, index) => {
      const path = `arms[${index}]`;
      const arm = v.record(path, entry);
      v.unknownKeys(path, arm, ["name", "title", "approach"]);
      const armName = v.string(`${path}.name`, arm.name, "");
      if (!NAME.test(armName) || armName === TRUNK) v.problem(`${path}.name`, `Use 2-48 lowercase letters, digits, or dashes (not "${TRUNK}").`);
      if (arms.some((other) => other.name === armName)) v.problem(`${path}.name`, `Duplicate arm "${armName}".`);
      arms.push({ name: armName, title: v.string(`${path}.title`, arm.title, armName), approach: v.string(`${path}.approach`, arm.approach, "") });
      if (!arms.at(-1)?.approach.trim()) v.problem(`${path}.approach`, "Describe how this arm differs.");
    });
  }
  const config = options.config;
  if (config && arms.length > config.selection.maxArms) v.problem("arms", `At most ${config.selection.maxArms} arms per experiment.`);
  const metrics = root.metrics === undefined ? undefined : v.strings("metrics", root.metrics, []);
  if (config && metrics) {
    for (const metric of metrics) if (!config.metrics.some((spec) => spec.id === metric)) v.problem("metrics", `Unknown metric "${metric}".`);
  }
  const createdAt = v.string("createdAt", root.createdAt, "");
  const expiresAt = v.string("expiresAt", root.expiresAt, "");
  for (const [key, value] of [["createdAt", createdAt], ["expiresAt", expiresAt]] as const) {
    if (Number.isNaN(Date.parse(value))) v.problem(key, "Expected an ISO 8601 timestamp.");
  }
  const manifest: ExperimentManifest = {
    name,
    title,
    hypothesis,
    kind,
    ...(metrics ? { metrics } : {}),
    rubric: { scores, rationale: v.string("rubric.rationale", rubricRaw.rationale, "") },
    arms,
    createdAt,
    expiresAt,
    status: v.oneOf("status", root.status, ["running", "promoted", "rejected", "expired"] as const, "running"),
  };
  if (root.winner !== undefined) manifest.winner = v.string("winner", root.winner, "");
  if (root.applicability !== undefined) {
    const raw = v.record("applicability", root.applicability);
    v.unknownKeys("applicability", raw, ["rules", "files", "description"]);
    manifest.applicability = {
      ...(raw.rules !== undefined ? { rules: v.strings("applicability.rules", raw.rules, []) } : {}),
      ...(raw.files !== undefined ? { files: v.strings("applicability.files", raw.files, []) } : {}),
      ...(raw.description !== undefined ? { description: v.string("applicability.description", raw.description, "") } : {}),
    };
  }
  if (root.source !== undefined) manifest.source = v.record("source", root.source) as NonNullable<ExperimentManifest["source"]>;
  if (root.evidence !== undefined) {
    const raw = v.record("evidence", root.evidence);
    const metrics = Array.isArray(raw.metrics) ? raw.metrics : [];
    manifest.evidence = {
      improvement: v.number("evidence.improvement", raw.improvement, 0, -1),
      metrics: metrics.flatMap((entry, index) => {
        const item = v.record(`evidence.metrics[${index}]`, entry);
        const optional = (key: "control" | "arm" | "pValue") => (typeof item[key] === "number" ? { [key]: item[key] as number } : {});
        return [{ metric: v.string(`evidence.metrics[${index}].metric`, item.metric, ""), delta: v.number(`evidence.metrics[${index}].delta`, item.delta, 0, -1), ...optional("control"), ...optional("arm"), ...optional("pValue") }];
      }),
    };
  }
  return v.problems.length === 0 ? { manifest, problems: [] } : { problems: v.problems };
}

export function parseManifest(text: string, options: { config?: HillClimbConfig } = {}): ParsedManifest {
  try {
    return validateManifest(parse(text), options);
  } catch (error) {
    return { problems: [{ path: "experiment.yml", message: (error as Error).message }] };
  }
}

export function serializeManifest(manifest: ExperimentManifest): string {
  return stringify(manifest, { lineWidth: 0 });
}

export interface RubricScore {
  score: number;
  passed: boolean;
  missing: string[];
}

/** Weighted mean of 1-5 criterion scores. Missing criteria count as 1 so incomplete proposals cannot pass. */
export function scoreRubric(scores: Readonly<Record<string, number>>, rubric: Rubric): RubricScore {
  const total = rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0) || 1;
  const missing = rubric.criteria.filter((criterion) => scores[criterion.id] === undefined).map((criterion) => criterion.id);
  const weighted = rubric.criteria.reduce((sum, criterion) => sum + criterion.weight * Math.min(5, Math.max(1, scores[criterion.id] ?? 1)), 0);
  const score = Math.round((weighted / total) * 100) / 100;
  return { score, passed: missing.length === 0 && score >= rubric.minScore, missing };
}

export function renderRubric(rubric: Rubric): string {
  return [
    `Score each criterion from 1 (poor) to 5 (excellent). Proposals need a weighted score of at least ${rubric.minScore}.`,
    "",
    "| Criterion | Weight | What a 5 looks like |",
    "| --- | --- | --- |",
    ...rubric.criteria.map((criterion) => `| \`${criterion.id}\` | ${criterion.weight} | ${criterion.description} |`),
  ].join("\n");
}
