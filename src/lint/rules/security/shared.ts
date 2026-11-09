import { isAlias, isMap, isPair, isScalar, isSeq, type YAMLMap } from "yaml";
import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { hasTrigger, runLine } from "../../parsers/workflow.js";
import { field, lineOfNode, toJS } from "../../parsers/yaml.js";

/** Triggers that run with the base repository's secrets and a potentially writable token while handling attacker-controlled data. */
export const PRIVILEGED_TRIGGERS = ["pull_request_target", "workflow_run", "issue_comment"];

export function isPrivileged(workflow: WorkflowModel): boolean {
  return workflow.kind === "workflow" && hasTrigger(workflow, ...PRIVILEGED_TRIGGERS);
}

export function privilegedTriggers(workflow: WorkflowModel): string[] {
  return workflow.triggers.map((trigger) => trigger.event).filter((event) => PRIVILEGED_TRIGGERS.includes(event));
}

const INDEX = String.raw`(?:\.\*|\.\d+|\[[^\]]*\])`;
const AUTHOR = String.raw`(?:message|author\.(?:email|name)|committer\.(?:email|name))`;

/** Context properties whose values are chosen by whoever opens the issue, pull request, comment, branch, or commit. */
const UNTRUSTED_CONTEXT = new RegExp(
  [
    String.raw`github\.head_ref\b`,
    String.raw`github\.event\.issue\.(?:title|body)\b`,
    String.raw`github\.event\.pull_request\.(?:title|body|head\.(?:ref|label|repo\.default_branch))\b`,
    String.raw`github\.event\.(?:comment|review|review_comment)\.body\b`,
    String.raw`github\.event\.discussion\.(?:title|body)\b`,
    String.raw`github\.event\.pages${INDEX}\.page_name\b`,
    String.raw`github\.event\.commits${INDEX}\.${AUTHOR}\b`,
    String.raw`github\.event\.head_commit\.${AUTHOR}\b`,
    String.raw`github\.event\.workflow_run\.(?:head_branch|display_title|head_commit\.${AUTHOR}|pull_requests${INDEX}\.head\.ref)\b`,
  ].join("|"),
  "i",
);

export interface UntrustedExpression {
  /** The full `${{ ... }}` text. */
  text: string;
  /** The untrusted context property it reads. */
  context: string;
  /** Character offset of the expression in the scanned text. */
  offset: number;
}

/** Rewrites property access in bracket notation (`github['head_ref']`, `secrets["TOKEN"]`) to dot notation. */
export function normalizeAccess(text: string): string {
  return text.replace(/\s*\[\s*(['"])([A-Za-z_][A-Za-z0-9_-]*)\1\s*\]/g, ".$2");
}

/** Every `${{ }}` expression in `text` that reads an attacker-controllable context property. */
export function untrustedExpressions(text: string): UntrustedExpression[] {
  const result: UntrustedExpression[] = [];
  for (const match of text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    const context = UNTRUSTED_CONTEXT.exec(normalizeAccess(match[1] ?? ""))?.[0];
    if (context !== undefined) result.push({ text: match[0], context, offset: match.index });
  }
  return result;
}

/** Lines of a `run:` script with their character offsets and source line numbers. */
export function scriptLines(step: StepModel): Array<{ text: string; offset: number; line: number }> {
  const script = step.run?.value;
  if (script === undefined) return [];
  const result: Array<{ text: string; offset: number; line: number }> = [];
  let offset = 0;
  for (const raw of script.split("\n")) {
    result.push({ text: raw.replace(/\r$/, ""), offset, line: runLine(step, offset) });
    offset += raw.length + 1;
  }
  return result;
}

/** Matches a redirect or `tee` into one of the runner's environment files. */
export const ENV_FILE_WRITE = /(?:>>?|\btee\b(?:\s+-a|\s+--append)?)\s*["']?\$\{?(GITHUB_ENV|GITHUB_PATH|GITHUB_OUTPUT)\b/;

function rootNode(workflow: WorkflowModel): unknown {
  return workflow.source.doc.contents;
}

function jobNode(workflow: WorkflowModel, job: JobModel): unknown {
  const jobs = field(workflow.source, rootNode(workflow), "jobs");
  return field(workflow.source, jobs?.value, job.id)?.value;
}

export interface Permissions {
  /** `write-all`, `read-all`, or a map of scope to access level; `{}` grants nothing. */
  value: unknown;
  line: number;
}

function permissionsAt(workflow: WorkflowModel, node: unknown): Permissions | undefined {
  const entry = field(workflow.source, node, "permissions");
  if (!entry) return undefined;
  return { value: toJS(workflow.source, entry.value), line: entry.line };
}

export function workflowPermissions(workflow: WorkflowModel): Permissions | undefined {
  return permissionsAt(workflow, rootNode(workflow));
}

export function jobPermissions(workflow: WorkflowModel, job: JobModel): Permissions | undefined {
  return permissionsAt(workflow, jobNode(workflow, job));
}

/** The job's own `permissions`, else the workflow's. Undefined means the repository default token permissions. */
export function effectivePermissions(workflow: WorkflowModel, job: JobModel): Permissions | undefined {
  return jobPermissions(workflow, job) ?? workflowPermissions(workflow);
}

/** Scopes granted `write` (`*` for `write-all`). Expression values are unknown and yield nothing. */
export function writeScopes(permissions: Permissions | undefined): string[] {
  const value = permissions?.value;
  if (typeof value === "string") return value.trim() === "write-all" ? ["*"] : [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, level]) => typeof level === "string" && level.trim() === "write")
    .map(([scope]) => scope);
}

const SECRET_REFERENCE = /\$\{\{[^}]*\bsecrets\.(?!GITHUB_TOKEN\b)[A-Za-z_]/i;

/** True when any `env` visible to the step (workflow, job, or step level) maps a non-GITHUB_TOKEN secret. */
export function stepHasSecretEnv(workflow: WorkflowModel, job: JobModel, step: StepModel): boolean {
  return [workflow.env, job.env, step.env].some((env) =>
    Object.values(env).some((value) => typeof value === "string" && SECRET_REFERENCE.test(normalizeAccess(value))),
  );
}

/** Env var names (workflow, job, and step level) whose value is an attacker-controllable expression. */
export function untrustedEnvNames(
  workflow: WorkflowModel,
  job: JobModel,
  step: StepModel,
  include: (expression: UntrustedExpression) => boolean = () => true,
): string[] {
  const names = new Set<string>();
  for (const env of [workflow.env, job.env, step.env]) {
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === "string" && untrustedExpressions(value).some(include)) names.add(name);
    }
  }
  return [...names];
}

/** Git ref names cannot contain newlines or control characters, so these contexts cannot forge extra env-file lines. */
export function isRefName(expression: UntrustedExpression): boolean {
  return /head_ref|head\.ref|head_branch|head\.label/i.test(expression.context);
}

const UNTRUSTED_REF =
  /\$\{\{[^}]*(?:github\.event\.pull_request\.head\.(?:sha|ref)|github\.head_ref|github\.event\.workflow_run\.(?:head_sha|head_branch)|github\.event\.workflow_run\.pull_requests[^}]*\.head\.(?:sha|ref))[^}]*\}\}|refs\/pull\//i;
const UNTRUSTED_REPOSITORY =
  /\$\{\{[^}]*(?:github\.event\.pull_request\.head\.repo\.full_name|github\.event\.workflow_run\.head_repository\.full_name)[^}]*\}\}/i;

/** Describes why an `actions/checkout` step fetches attacker-controlled code, if it does. */
export function untrustedCheckoutTarget(step: StepModel): string | undefined {
  const ref = step.with.get("ref")?.value;
  if (typeof ref === "string" && UNTRUSTED_REF.test(normalizeAccess(ref))) return `ref: ${ref.trim()}`;
  const repository = step.with.get("repository")?.value;
  if (typeof repository === "string" && UNTRUSTED_REPOSITORY.test(normalizeAccess(repository))) return `repository: ${repository.trim()}`;
  return undefined;
}

function withString(step: StepModel, key: string): string | undefined {
  const value = step.with.get(key)?.value;
  return typeof value === "string" ? value.trim() : typeof value === "boolean" ? String(value) : undefined;
}

/**
 * Whether a build context points at the workspace. An absent context means the action's default Git context (the
 * event's ref fetched from the remote), which is not the checked-out workspace.
 */
const LOCAL_CONTEXT = (value: string | undefined): boolean => value !== undefined && !/^(?:https?:|git[@:]|\$\{\{)/i.test(value);

/** Whether a job checks out attacker-controlled code or interpolates attacker-controlled input into a script. */
export function jobHandlesUntrusted(workflow: WorkflowModel, job: JobModel): boolean {
  return job.steps.some(
    (step) =>
      (step.uses?.action.name === "actions/checkout" && untrustedCheckoutTarget(step) !== undefined) ||
      scriptLines(step).some((line) => /\bgh\s+pr\s+checkout\b/.test(line.text) || untrustedExpressions(line.text).length > 0) ||
      (step.run !== undefined && untrustedEnvNames(workflow, job, step).length > 0),
  );
}

/**
 * Marketplace actions that build, install, or run code from the checked-out workspace. After an untrusted checkout these
 * execute attacker-authored code just like a `run:` step (Dockerfile `RUN`, lifecycle scripts, gemspecs, build scripts, hooks).
 */
export function executesWorkspace(step: StepModel): string | undefined {
  const action = step.uses?.action;
  if (action?.kind !== "remote" || action.name === undefined) return undefined;
  const name = action.name.toLowerCase();
  const what = `the action \`${step.uses?.value ?? name}\``;
  switch (name) {
    case "github/codeql-action/autobuild":
    case "pre-commit/action":
    case "bahmutov/npm-install":
    case "cypress-io/github-action":
      return what;
    case "docker/build-push-action":
      return LOCAL_CONTEXT(withString(step, "context")) ? what : undefined;
    case "docker/bake-action":
      return LOCAL_CONTEXT(withString(step, "source")) ? what : undefined;
    case "gradle/gradle-build-action":
      return withString(step, "arguments") ? what : undefined;
    case "ruby/setup-ruby":
      return withString(step, "bundler-cache") === "true" ? what : undefined;
    case "pnpm/action-setup": {
      const install = withString(step, "run_install");
      return install !== undefined && install !== "false" ? what : undefined;
    }
    default:
      return undefined;
  }
}

function directChild(node: unknown, key: string): unknown {
  if (!isMap(node)) return undefined;
  const pair = node.items.find((item) => isPair(item) && isScalar(item.key) && String(item.key.value) === key);
  return pair && !isAlias(pair.value) ? pair.value : undefined;
}

/**
 * The step's mapping node when the step and its `steps` list are written inline in block style (no anchors,
 * aliases, merge keys, or flow mappings on the path). Fixes that edit a step's keys require this.
 */
export function directStep(workflow: WorkflowModel, step: StepModel): YAMLMap | undefined {
  const match = /^(?:jobs\.([^.]+)\.steps|runs\.steps)\[(\d+)\]$/.exec(step.key);
  if (!match) return undefined;
  const root = rootNode(workflow);
  const parent = match[1] !== undefined ? directChild(directChild(root, "jobs"), match[1]) : directChild(root, "runs");
  const stepsNode = directChild(parent, "steps");
  if (!isSeq(stepsNode)) return undefined;
  const node = stepsNode.items[Number(match[2])];
  if (!isMap(node) || node.flow || lineOfNode(workflow.source, node) !== step.line) return undefined;
  if (node.items.some((pair) => !isScalar(pair.key) || pair.key.value === "<<")) return undefined;
  return node;
}
