import { isScalar, Scalar, type Node } from "yaml";
import {
  classify,
  entries,
  field,
  items,
  lineOfNode,
  parseYaml,
  stringValue,
  toJS,
  type Field,
  type Origin,
  type ValueKind,
  type YamlSource,
} from "./yaml.js";

export interface Sourced<T> {
  value: T;
  kind: ValueKind;
  line: number;
  origin: Origin;
}

export interface ActionRef {
  raw: string;
  kind: "local" | "docker" | "remote" | "expression";
  owner?: string;
  repo?: string;
  /** owner/repo plus optional subdirectory, lowercased (for example `actions/cache/save`). */
  name?: string;
  ref?: string;
  shaPinned: boolean;
}

export interface StepModel {
  index: number;
  line: number;
  key: string;
  id?: string;
  name?: string;
  uses?: Sourced<string> & { action: ActionRef };
  with: Map<string, Sourced<unknown>>;
  run?: Sourced<string> & { contentLine: number };
  workingDirectory?: string;
  if?: string;
  env: Record<string, unknown>;
}

export interface ServiceModel {
  name: string;
  image: Sourced<string>;
}

export interface JobModel {
  id: string;
  line: number;
  key: string;
  name?: string;
  runsOn?: Sourced<unknown>;
  needs: string[];
  timeoutMinutes?: Sourced<unknown>;
  uses?: Sourced<string>;
  containerImage?: Sourced<string>;
  services: ServiceModel[];
  concurrency?: Sourced<unknown>;
  environment?: Sourced<unknown>;
  if?: string;
  matrix?: Record<string, unknown>;
  steps: StepModel[];
  workingDirectory?: string;
  env: Record<string, unknown>;
}

export interface TriggerModel {
  event: string;
  line: number;
  paths?: string[];
  pathsIgnore?: string[];
  branches?: string[];
  types?: string[];
}

export interface WorkflowModel {
  kind: "workflow" | "composite-action" | "action";
  path: string;
  source: YamlSource;
  name?: string;
  triggers: TriggerModel[];
  triggersLine: number;
  concurrency?: Sourced<unknown>;
  workingDirectory?: string;
  env: Record<string, unknown>;
  jobs: JobModel[];
}

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function parseActionRef(raw: string): ActionRef {
  const value = raw.trim();
  if (value.includes("${{")) return { raw: value, kind: "expression", shaPinned: false };
  if (value.startsWith("./") || value.startsWith("../")) {
    return { raw: value, kind: "local", shaPinned: true };
  }
  if (value.startsWith("docker://")) {
    return { raw: value, kind: "docker", shaPinned: /@sha256:[0-9a-f]{64}$/i.test(value) };
  }
  const at = value.lastIndexOf("@");
  const path = at >= 0 ? value.slice(0, at) : value;
  const ref = at >= 0 ? value.slice(at + 1) : undefined;
  const [owner, repo] = path.split("/");
  return {
    raw: value,
    kind: "remote",
    ...(owner ? { owner: owner.toLowerCase() } : {}),
    ...(repo ? { repo: repo.toLowerCase() } : {}),
    name: path.toLowerCase(),
    ...(ref !== undefined ? { ref } : {}),
    shaPinned: ref !== undefined && SHA_PATTERN.test(ref),
  };
}

function sourced<T>(source: YamlSource, entry: Field | undefined): Sourced<T> | undefined {
  if (!entry) return undefined;
  const value = toJS(source, entry.value) as T;
  return { value, kind: classify(value), line: entry.line, origin: entry.origin };
}

function sourcedString(source: YamlSource, entry: Field | undefined): Sourced<string> | undefined {
  const result = sourced<unknown>(source, entry);
  if (!result || result.value === undefined || result.value === null) return undefined;
  return { ...result, value: String(result.value) };
}

function stringList(source: YamlSource, node: Node | null | undefined): string[] | undefined {
  if (!node) return undefined;
  const value = toJS(source, node);
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(String);
  return undefined;
}

function record(source: YamlSource, node: Node | null | undefined): Record<string, unknown> {
  const value = toJS(source, node);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseSteps(source: YamlSource, stepsNode: Node | null | undefined, keyPrefix: string): StepModel[] {
  return items(source, stepsNode).map((stepNode, index) => {
    const usesField = field(source, stepNode, "uses");
    const runField = field(source, stepNode, "run");
    const withField = field(source, stepNode, "with");
    const withMap = new Map<string, Sourced<unknown>>();
    for (const entry of entries(source, withField?.value)) {
      const value = sourced<unknown>(source, entry);
      if (value) withMap.set(entry.key, value);
    }
    const uses = sourcedString(source, usesField);
    const run = sourcedString(source, runField);
    const runNode = runField?.value;
    const isBlock =
      isScalar(runNode) &&
      (runNode.type === Scalar.BLOCK_LITERAL || runNode.type === Scalar.BLOCK_FOLDED);
    const contentLine = runNode ? lineOfNode(source, runNode) + (isBlock ? 1 : 0) : 0;
    const id = stringValue(field(source, stepNode, "id")?.value);
    const name = stringValue(field(source, stepNode, "name")?.value);
    const workingDirectory = stringValue(field(source, stepNode, "working-directory")?.value);
    const condition = stringValue(field(source, stepNode, "if")?.value);
    return {
      index,
      line: lineOfNode(source, stepNode),
      key: `${keyPrefix}.steps[${index}]`,
      ...(id !== undefined ? { id } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(uses ? { uses: { ...uses, action: parseActionRef(uses.value) } } : {}),
      with: withMap,
      ...(run ? { run: { ...run, contentLine } } : {}),
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
      ...(condition !== undefined ? { if: condition } : {}),
      env: record(source, field(source, stepNode, "env")?.value),
    };
  });
}

function defaultsWorkingDirectory(source: YamlSource, node: Node | null | undefined): string | undefined {
  const run = field(source, field(source, node, "defaults")?.value, "run");
  return stringValue(field(source, run?.value, "working-directory")?.value);
}

function parseTriggers(source: YamlSource, onField: Field | undefined): TriggerModel[] {
  if (!onField) return [];
  const value = toJS(source, onField.value);
  if (typeof value === "string") return [{ event: value, line: onField.line }];
  if (Array.isArray(value)) return value.map((event) => ({ event: String(event), line: onField.line }));
  return entries(source, onField.value).map((entry) => {
    const paths = stringList(source, field(source, entry.value, "paths")?.value);
    const pathsIgnore = stringList(source, field(source, entry.value, "paths-ignore")?.value);
    const branches = stringList(source, field(source, entry.value, "branches")?.value);
    const types = stringList(source, field(source, entry.value, "types")?.value);
    return {
      event: entry.key,
      line: entry.line,
      ...(paths ? { paths } : {}),
      ...(pathsIgnore ? { pathsIgnore } : {}),
      ...(branches ? { branches } : {}),
      ...(types ? { types } : {}),
    };
  });
}

function parseJob(source: YamlSource, entry: Field): JobModel {
  const node = entry.value;
  const key = `jobs.${entry.key}`;
  const needsValue = toJS(source, field(source, node, "needs")?.value);
  const needs = typeof needsValue === "string" ? [needsValue] : Array.isArray(needsValue) ? needsValue.map(String) : [];
  const containerField = field(source, node, "container");
  const containerImage =
    containerField && stringValue(containerField.value) !== undefined
      ? sourcedString(source, containerField)
      : sourcedString(source, field(source, containerField?.value, "image"));
  const services = entries(source, field(source, node, "services")?.value)
    .map((service) => {
      const image = sourcedString(source, field(source, service.value, "image"));
      return image ? { name: service.key, image } : undefined;
    })
    .filter((service): service is ServiceModel => service !== undefined);
  const strategy = field(source, node, "strategy");
  const matrix = toJS(source, field(source, strategy?.value, "matrix")?.value);
  const name = stringValue(field(source, node, "name")?.value);
  const condition = stringValue(field(source, node, "if")?.value);
  const workingDirectory = defaultsWorkingDirectory(source, node);
  const runsOn = sourced<unknown>(source, field(source, node, "runs-on"));
  const timeoutMinutes = sourced<unknown>(source, field(source, node, "timeout-minutes"));
  const uses = sourcedString(source, field(source, node, "uses"));
  const concurrency = sourced<unknown>(source, field(source, node, "concurrency"));
  const environment = sourced<unknown>(source, field(source, node, "environment"));
  return {
    id: entry.key,
    line: entry.line,
    key,
    ...(name !== undefined ? { name } : {}),
    ...(runsOn ? { runsOn } : {}),
    needs,
    ...(timeoutMinutes ? { timeoutMinutes } : {}),
    ...(uses ? { uses } : {}),
    ...(containerImage ? { containerImage } : {}),
    services,
    ...(concurrency ? { concurrency } : {}),
    ...(environment ? { environment } : {}),
    ...(condition !== undefined ? { if: condition } : {}),
    ...(matrix && typeof matrix === "object" && !Array.isArray(matrix)
      ? { matrix: matrix as Record<string, unknown> }
      : typeof matrix === "string"
        ? { matrix: { __expression: matrix } }
        : {}),
    steps: parseSteps(source, field(source, node, "steps")?.value, key),
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    env: record(source, field(source, node, "env")?.value),
  };
}

export function isWorkflowPath(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path);
}

export function isActionPath(path: string): boolean {
  return /(^|\/)action\.ya?ml$/i.test(path);
}

export function parseWorkflow(path: string, content: string): WorkflowModel {
  const source = parseYaml(path, content);
  const root = source.doc.contents;
  const name = stringValue(field(source, root, "name")?.value);
  if (isActionPath(path) && !isWorkflowPath(path)) {
    const runs = field(source, root, "runs");
    const using = stringValue(field(source, runs?.value, "using")?.value);
    const composite = using === "composite";
    const steps = composite ? parseSteps(source, field(source, runs?.value, "steps")?.value, "runs") : [];
    return {
      kind: composite ? "composite-action" : "action",
      path,
      source,
      ...(name !== undefined ? { name } : {}),
      triggers: [],
      triggersLine: 1,
      env: {},
      jobs: composite
        ? [
            {
              id: "(composite)",
              line: runs?.line ?? 1,
              key: "runs",
              needs: [],
              services: [],
              steps,
              env: {},
            },
          ]
        : [],
    };
  }
  const onField = field(source, root, "on");
  const concurrency = sourced<unknown>(source, field(source, root, "concurrency"));
  const workingDirectory = defaultsWorkingDirectory(source, root);
  return {
    kind: "workflow",
    path,
    source,
    ...(name !== undefined ? { name } : {}),
    triggers: parseTriggers(source, onField),
    triggersLine: onField?.line ?? 1,
    ...(concurrency ? { concurrency } : {}),
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    env: record(source, field(source, root, "env")?.value),
    jobs: entries(source, field(source, root, "jobs")?.value).map((entry) => parseJob(source, entry)),
  };
}

/** Line of a character offset inside a step's `run` script. */
export function runLine(step: StepModel, offset: number): number {
  if (!step.run) return step.line;
  const before = step.run.value.slice(0, Math.max(0, offset));
  return step.run.contentLine + (before.match(/\n/g)?.length ?? 0);
}

export function hasTrigger(workflow: WorkflowModel, ...events: string[]): boolean {
  return workflow.triggers.some((trigger) => events.includes(trigger.event));
}

export function trigger(workflow: WorkflowModel, event: string): TriggerModel | undefined {
  return workflow.triggers.find((candidate) => candidate.event === event);
}

export function withString(step: StepModel, key: string): string | undefined {
  const value = step.with.get(key)?.value;
  return value === undefined || value === null ? undefined : String(value);
}
