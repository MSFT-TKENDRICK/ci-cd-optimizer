import type { Node } from "yaml";
import type { JobModel, WorkflowModel } from "../../parsers/workflow.js";
import { field, type Field } from "../../parsers/yaml.js";

/** Actions that compute which paths a pull request touched. */
export const CHANGE_ACTIONS = new Set([
  "dorny/paths-filter",
  "tj-actions/changed-files",
  "step-security/changed-files",
  "technote-space/get-diff-action",
  "jitterbit/get-changed-files",
  "ana06/get-changed-files",
  "trilom/file-changes-action",
  "marceloprado/has-changed-path",
  "yumemi-inc/changed-files",
]);

/** Pull-request automation (labelers, triage bots, title linters) rather than build or test work. */
export const PR_AUTOMATION =
  /label(?:l)?er|labels|triage|stale|greet|welcome|assign|auto-?merge|release-drafter|semantic-pr|pr-title/i;

/** Activity types that fire when a pull request's code changes. */
export const CODE_TYPES = new Set(["opened", "synchronize", "reopened"]);

/** The YAML mapping node of a job, as written under `jobs:`. */
export function jobNode(workflow: WorkflowModel, job: JobModel): Node | null | undefined {
  const jobs = field(workflow.source, workflow.source.doc.contents, "jobs");
  return field(workflow.source, jobs?.value, job.id)?.value;
}

/** A field of the job's `strategy:` mapping. */
export function strategyField(workflow: WorkflowModel, job: JobModel, key: string): Field | undefined {
  const strategy = field(workflow.source, jobNode(workflow, job), "strategy");
  return field(workflow.source, strategy?.value, key);
}

/**
 * Lower bound on the number of legs a literal matrix expands to: the product of its axes minus `exclude` entries
 * (or the number of `include` entries when there are no axes). Undefined when any part is an expression.
 */
export function matrixSize(job: JobModel): number | undefined {
  const matrix = job.matrix;
  if (!matrix || "__expression" in matrix) return undefined;
  const axes = Object.entries(matrix).filter(([key]) => key !== "include" && key !== "exclude");
  const include = matrix.include;
  const exclude = matrix.exclude;
  if (include !== undefined && !Array.isArray(include)) return undefined;
  if (exclude !== undefined && !Array.isArray(exclude)) return undefined;
  if (axes.length === 0) return include?.length ?? 0;
  let product = 1;
  for (const [, value] of axes) {
    if (!Array.isArray(value)) return undefined;
    product *= value.length;
  }
  return Math.max(0, product - (exclude?.length ?? 0));
}

/** Every job the given job depends on, directly or transitively. */
export function ancestors(workflow: WorkflowModel, job: JobModel): JobModel[] {
  const byId = new Map(workflow.jobs.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const result: JobModel[] = [];
  const queue = [...job.needs];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const found = byId.get(id);
    if (!found) continue;
    result.push(found);
    queue.push(...found.needs);
  }
  return result;
}

/** True when the job runs code: shell steps, a checkout, or a local action. */
export function runsChecks(job: JobModel): boolean {
  return job.steps.some(
    (step) => step.run !== undefined || step.uses?.action.kind === "local" || step.uses?.action.name === "actions/checkout",
  );
}
