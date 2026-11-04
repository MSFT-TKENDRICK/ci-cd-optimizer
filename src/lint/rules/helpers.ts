import type { JobModel, StepModel, WorkflowModel } from "../parsers/workflow.js";
import { hasTrigger } from "../parsers/workflow.js";
import { runLine } from "../parsers/workflow.js";
import type { RuleContext, RuleMeta, RuleModule, SourceFile } from "../types.js";
import { isAlias, isMap, isPair, isScalar, isSeq, type YAMLMap } from "yaml";
import { lineText } from "../fix.js";
import { lineOfNode } from "../parsers/yaml.js";
import type { ProjectModel } from "../project.js";

export function defineRule<O extends Record<string, unknown>>(rule: {
  meta: RuleMeta<O>;
  check(context: RuleContext<O>): void;
}): RuleModule<O> {
  return rule;
}

export interface RunCommand {
  workflow: WorkflowModel;
  job: JobModel;
  step: StepModel;
  /** The full command line (continuations joined). */
  command: string;
  line: number;
}

/** Splits a `run:` script into logical commands, joining `\` continuations and splitting on `&&`, `||`, `;`. */
export function commandsOf(step: StepModel): Array<{ command: string; line: number }> {
  const script = step.run?.value;
  if (!script) return [];
  const result: Array<{ command: string; line: number }> = [];
  let offset = 0;
  let buffer = "";
  let bufferStart = 0;
  for (const rawLine of script.split("\n")) {
    const lineOffset = offset;
    offset += rawLine.length + 1;
    const text = rawLine.replace(/\r$/, "");
    if (buffer === "") bufferStart = lineOffset;
    if (/\\\s*$/.test(text)) {
      buffer += text.replace(/\\\s*$/, " ");
      continue;
    }
    buffer += text;
    const line = runLine(step, bufferStart);
    for (const part of buffer.split(/&&|\|\||;/)) {
      const command = part.trim();
      if (command && !command.startsWith("#")) result.push({ command, line });
    }
    buffer = "";
  }
  return result;
}

export function* runCommands(workflows: WorkflowModel[]): Generator<RunCommand> {
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        for (const { command, line } of commandsOf(step)) {
          yield { workflow, job, step, command, line };
        }
      }
    }
  }
}

export function* steps(workflows: WorkflowModel[]): Generator<{ workflow: WorkflowModel; job: JobModel; step: StepModel }> {
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      for (const step of job.steps) yield { workflow, job, step };
    }
  }
}

/** Steps that use the given action (owner/repo[/path], case-insensitive), ignoring the ref. */
export function* stepsUsing(
  workflows: WorkflowModel[],
  ...names: string[]
): Generator<{ workflow: WorkflowModel; job: JobModel; step: StepModel }> {
  const wanted = names.map((name) => name.toLowerCase());
  for (const entry of steps(workflows)) {
    const action = entry.step.uses?.action;
    if (action?.kind === "remote" && action.name !== undefined && wanted.includes(action.name)) yield entry;
  }
}

export function isPullRequestWorkflow(workflow: WorkflowModel): boolean {
  return hasTrigger(workflow, "pull_request", "pull_request_target", "merge_group");
}

/** Deploy/release workflows must not cancel in-progress runs or be skipped by change detection. */
export function isDeployLike(workflow: WorkflowModel): boolean {
  if (/deploy|release|publish|promote|rollout/i.test(`${workflow.path} ${workflow.name ?? ""}`)) return true;
  if (workflow.jobs.some((job) => job.environment !== undefined)) return true;
  return hasTrigger(workflow, "release", "deployment", "registry_package");
}

export function stepLine(step: StepModel): number {
  return step.uses?.line ?? step.run?.line ?? step.line;
}

export function jobRunsOnLabels(job: JobModel): string[] {
  const value = job.runsOn?.value;
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(String);
  if (value && typeof value === "object") {
    const labels = (value as { labels?: unknown }).labels;
    if (typeof labels === "string") return [labels];
    if (Array.isArray(labels)) return labels.map(String);
  }
  return [];
}

function directChild(node: unknown, key: string): unknown {
  if (!isMap(node)) return undefined;
  const pair = node.items.find((item) => isPair(item) && isScalar(item.key) && String(item.key.value) === key);
  return pair && !isAlias(pair.value) ? pair.value : undefined;
}

/**
 * The step's `with:` mapping when the step, its `steps` list, and the mapping are all written inline in block style
 * (no anchors/aliases/merge keys on the path, no flow mappings). Fixes that add `with` inputs require this.
 */
export function directWith(workflow: WorkflowModel, step: StepModel): YAMLMap | undefined {
  const match = /^(?:jobs\.([^.]+)\.steps|runs\.steps)\[(\d+)\]$/.exec(step.key);
  if (!match) return undefined;
  const root = workflow.source.doc.contents;
  const parent = match[1] !== undefined ? directChild(directChild(root, "jobs"), match[1]) : directChild(root, "runs");
  const stepsNode = directChild(parent, "steps");
  if (!isSeq(stepsNode)) return undefined;
  const stepNode = stepsNode.items[Number(match[2])];
  if (!isMap(stepNode) || stepNode.flow || lineOfNode(workflow.source, stepNode) !== step.line) return undefined;
  const withNode = directChild(stepNode, "with");
  return isMap(withNode) && !withNode.flow ? withNode : undefined;
}

export interface ExpandedStep {
  step: StepModel;
  /** The job's own step: `step` itself, or the `uses: ./local-action` step that pulled it in. */
  owner: StepModel;
  /** File that physically contains `step` (the workflow, or a local composite action). */
  path: string;
  /** True when `step` is written directly in the job rather than inside a composite action. */
  direct: boolean;
}

/** A job's steps in execution order with local composite actions expanded, each tagged with its owner and file. */
export function expandedJobSteps(project: ProjectModel, workflow: WorkflowModel, job: JobModel): ExpandedStep[] {
  return job.steps.flatMap((owner) =>
    project.expandedSteps({ ...job, steps: [owner] }).map((step) => {
      const direct = step === owner;
      const action = direct ? undefined : project.actions.find((candidate) => candidate.jobs[0]?.steps.includes(step));
      return { step, owner, path: action?.path ?? workflow.path, direct };
    }),
  );
}

export interface JobCommand extends ExpandedStep {
  command: string;
  line: number;
}

/** Every `run:` command of a job (composite actions expanded), in execution order. */
export function jobCommands(project: ProjectModel, workflow: WorkflowModel, job: JobModel): JobCommand[] {
  return expandedJobSteps(project, workflow, job).flatMap((entry) =>
    commandsOf(entry.step).map(({ command, line }) => ({ ...entry, command, line })),
  );
}

/**
 * True only when the project is known to be a monorepo (workspaces or a monorepo build tool were detected). A Gradle
 * settings file alone does not count, matching `facts.isMonorepo`.
 */
export function isKnownMonorepo(project: ProjectModel): boolean {
  const { isMonorepo, monorepoTools } = project.facts;
  return (
    (isMonorepo.status === "known" && isMonorepo.value) ||
    (monorepoTools.status === "known" && monorepoTools.value.some((tool) => tool !== "gradle"))
  );
}

const DIFF_BASE_REF =
  /\borigin\/|\$\{\{\s*github\.(?:event\.pull_request\.base\.(?:sha|ref)|base_ref|event\.before)\s*\}\}|\bHEAD[~^]/;

/**
 * Names the affected/changed-only tooling a command uses, if any. These tools diff against a base ref, so they need
 * history beyond the default `fetch-depth: 1` checkout.
 */
export function affectedTooling(command: string): string | undefined {
  const text = command.replace(/["']/g, "");
  if (/^(?:echo|printf)\b/.test(text)) return undefined;
  if (/\bnx\s+affected\b/.test(text)) return "nx affected";
  if (/\bturbo\b.*\s--affected\b/.test(text)) return "turbo --affected";
  if (/\bturbo\b.*\s(?:--filter|-F)(?:=|\s+)\S*\[[^\]\s]+\]/.test(text)) return "turbo --filter=...[ref]";
  if (/\bpnpm\b.*\s(?:--filter|-F)(?:=|\s+)\S*\[[^\]\s]+\]/.test(text)) return "pnpm --filter ...[ref]";
  if (/\s--(?:changedSince|changed-since)\b/.test(text)) return "jest --changedSince";
  if (/\s--lastCommit\b/.test(text)) return "jest --lastCommit";
  if (/\s--(?:onlyChanged|only-changed)\b/.test(text)) return "jest --onlyChanged";
  if (/\bvitest\b.*\s--changed\b/.test(text)) return "vitest --changed";
  if (/\blerna\b.*\s--since\b/.test(text)) return "lerna --since";
  if (/\byarn\b.*\bworkspaces\s+foreach\b.*\s--since\b/.test(text)) return "yarn workspaces foreach --since";
  if (/\bgit\s+merge-base\b/.test(text)) return "git merge-base";
  if (/\bgit\s+diff\b/.test(text) && DIFF_BASE_REF.test(command)) return "git diff against the base";
  return undefined;
}

export interface ActionVersion {
  major: number;
  minor: number | undefined;
  patch: number | undefined;
  /** The version text as written, for example `v4.2.1`. */
  text: string;
  source: "ref" | "comment";
}

function parseActionVersion(text: string, source: ActionVersion["source"]): ActionVersion | undefined {
  const match = /^v(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: match[2] !== undefined ? Number(match[2]) : undefined,
    patch: match[3] !== undefined ? Number(match[3]) : undefined,
    text,
    source,
  };
}

/**
 * Version of a literal remote action reference: its `vX[.Y[.Z]]` tag, or, for SHA pins, a trailing `# vX.Y.Z`
 * comment on the `uses:` line. Branches, other refs, and uncommented SHA pins yield undefined.
 */
export function actionVersion(step: StepModel, file: SourceFile | undefined): ActionVersion | undefined {
  const uses = step.uses;
  const ref = uses?.action.ref;
  if (!uses || uses.kind !== "literal" || uses.action.kind !== "remote" || ref === undefined) return undefined;
  if (!uses.action.shaPinned) return parseActionVersion(ref, "ref");
  if (!file) return undefined;
  const comment = /\s#(.*)$/.exec(lineText(file.content, uses.line))?.[1] ?? "";
  const match = /(?:^|[\s=@:])(v\d+(?:\.\d+){0,2})(?![\w.-])/.exec(comment);
  return match?.[1] !== undefined ? parseActionVersion(match[1], "comment") : undefined;
}
