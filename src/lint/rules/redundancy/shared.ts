import { isMap, isPair, isScalar, isSeq, type Pair, type YAMLMap } from "yaml";
import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";

export interface SetupAction {
  /** `with` input that selects the toolchain version, when the action has one. */
  version?: string;
  /** `with` inputs that read the version from a file instead. */
  versionFiles?: string[];
}

/** Toolchain setup actions (lowercased `owner/repo[/path]`) and their version inputs. */
export const SETUP_ACTIONS: Record<string, SetupAction> = {
  "actions/setup-node": { version: "node-version", versionFiles: ["node-version-file"] },
  "actions/setup-python": { version: "python-version", versionFiles: ["python-version-file"] },
  "actions/setup-go": { version: "go-version", versionFiles: ["go-version-file"] },
  "actions/setup-java": { version: "java-version", versionFiles: ["java-version-file"] },
  "actions/setup-dotnet": { version: "dotnet-version", versionFiles: ["global-json-file"] },
  "ruby/setup-ruby": { version: "ruby-version" },
  "oven-sh/setup-bun": { version: "bun-version", versionFiles: ["bun-version-file"] },
  "denoland/setup-deno": { version: "deno-version", versionFiles: ["deno-version-file"] },
  "pnpm/action-setup": { version: "version" },
  "astral-sh/setup-uv": { version: "version", versionFiles: ["version-file"] },
  "hashicorp/setup-terraform": { version: "terraform_version" },
  "azure/setup-helm": { version: "version" },
  "azure/setup-kubectl": { version: "version" },
  "shivammathur/setup-php": { version: "php-version", versionFiles: ["php-version-file"] },
  "gradle/actions/setup-gradle": {},
  "dtolnay/rust-toolchain": {},
  "erlef/setup-beam": {},
};

/** Dependency install commands, matched against `commandWords(command).join(" ")`. */
export const INSTALL_COMMAND =
  /^(?:npm (?:ci|install|i)|pnpm (?:install|i)|yarn(?: install)?|bun install|pip3? install|python3? -m pip install|poetry install|uv sync|bundle install|go mod download|composer install|dotnet restore)\b/;

export function setupActionOf(step: StepModel): string | undefined {
  const action = step.uses?.action;
  if (action?.kind !== "remote" || action.name === undefined) return undefined;
  return Object.hasOwn(SETUP_ACTIONS, action.name) ? action.name : undefined;
}

export function hash(text: string): string {
  let value = 5381;
  for (let index = 0; index < text.length; index += 1) value = ((value * 33) ^ text.charCodeAt(index)) >>> 0;
  return value.toString(16).padStart(8, "0");
}

/** Order-independent serialization used to compare parsed YAML values. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function withSignature(step: StepModel): string {
  return stable(Object.fromEntries([...step.with].map(([key, entry]) => [key, entry.value])));
}

/** Drops blank and comment lines and collapses whitespace so formatting differences do not hide identical scripts. */
export function normalizeScript(script: string): string {
  return script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .join("\n")
    .replace(/[ \t]+/g, " ");
}

export function workingDirectory(workflow: WorkflowModel, job: JobModel, step: StepModel): string | undefined {
  return step.workingDirectory ?? job.workingDirectory ?? workflow.workingDirectory;
}

/** A fingerprint of everything that determines what a step does (its name and id are ignored). */
export function stepSignature(workflow: WorkflowModel, job: JobModel, step: StepModel): string {
  return [
    step.uses ? `uses:${step.uses.value.trim().toLowerCase()} with:${withSignature(step)}` : "",
    step.run ? `run:${normalizeScript(step.run.value)}` : "",
    `cwd:${workingDirectory(workflow, job, step) ?? ""}`,
    `if:${step.if ?? ""}`,
    `env:${stable(step.env)}`,
  ].join("\u0000");
}

function directChild(node: unknown, key: string): Pair | undefined {
  if (!isMap(node)) return undefined;
  return node.items.find((item) => isPair(item) && isScalar(item.key) && String(item.key.value) === key);
}

/** The YAML node of a job (`jobs.<id>`) written directly in the workflow. */
export function jobNode(workflow: WorkflowModel, job: JobModel): YAMLMap | undefined {
  const node = directChild(directChild(workflow.source.doc.contents, "jobs")?.value, job.id)?.value;
  return isMap(node) ? node : undefined;
}

/** The YAML node of a step written directly (not through an alias) in a workflow job or composite action. */
export function stepNode(workflow: WorkflowModel, step: StepModel): YAMLMap | undefined {
  const match = /^(?:jobs\.([^.]+)\.steps|runs\.steps)\[(\d+)\]$/.exec(step.key);
  if (!match) return undefined;
  const root = workflow.source.doc.contents;
  const parent =
    match[1] !== undefined ? directChild(directChild(root, "jobs")?.value, match[1])?.value : directChild(root, "runs")?.value;
  const stepsNode = directChild(parent, "steps")?.value;
  if (!isSeq(stepsNode)) return undefined;
  const node = stepsNode.items[Number(match[2])];
  return isMap(node) ? node : undefined;
}

/** The pair `key: value` written directly inside `parent.<mapKey>` (no aliases or merge keys). */
export function nestedPair(parent: unknown, mapKey: string, key: string): { map: YAMLMap; pair: Pair } | undefined {
  const map = directChild(parent, mapKey)?.value;
  if (!isMap(map)) return undefined;
  const pair = directChild(map, key);
  return pair ? { map, pair } : undefined;
}

/** The source text of a scalar node without surrounding quotes (keeps `3.10` from becoming `3.1`). */
export function rawScalar(content: string, node: unknown): string | undefined {
  if (!isScalar(node) || !node.range) return undefined;
  const text = content.slice(node.range[0], node.range[1]).trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(text);
  return quoted ? quoted[2] : text;
}

const VARYING_CONTEXTS = /\b(?:env|steps|job|jobs|matrix|strategy|runner|needs)\s*(?:\.|\[)/;

/** True when a value means the same thing at every level (no expression contexts that vary per job or step). */
export function isPositionIndependent(value: unknown): boolean {
  if (typeof value !== "string") return value === null || typeof value === "number" || typeof value === "boolean";
  const expressions = value.match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
  return expressions.every((expression) => !VARYING_CONTEXTS.test(expression));
}
