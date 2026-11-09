import { isAlias, isMap, isPair, isScalar, isSeq } from "yaml";
import { fix, indentOf, insertLinesAfter, lineText } from "../../fix.js";
import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { lineOfNode } from "../../parsers/yaml.js";
import type { ProjectModel } from "../../project.js";
import type { Fix, SourceFile } from "../../types.js";
import { usesAction } from "../caching/shared.js";
import { defineRule } from "../helpers.js";

interface Tool {
  action: string;
  language: string;
  versionInput: string;
  fileInput: string;
  /** What the action does when neither input is set (quoted from the action's README or source). */
  fallback: string;
  /** Root file the action reads on its own when neither input is set. */
  implicitFile?: string;
  pinExample: string;
  /** Files that also declare a version but only as a range, so they are mentioned but never auto-applied. */
  rangeFiles?: string[];
  candidates(project: ProjectModel): string[];
}

function content(project: ProjectModel, path: string): string | undefined {
  return project.files.get(path)?.content;
}

function json(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** setup-node reads package.json `volta.node`, then a `devEngines.runtime` entry named node that has a version. */
function packageJsonPinsNode(project: ProjectModel): boolean {
  const manifest = json(content(project, "package.json"));
  if (!manifest) return false;
  if (typeof record(manifest.volta)?.node === "string") return true;
  const runtime = record(manifest.devEngines)?.runtime;
  const entries = Array.isArray(runtime) ? runtime : [runtime];
  return entries.some((entry) => {
    const item = record(entry);
    return typeof item?.name === "string" && item.name.toLowerCase() === "node" && typeof item.version === "string" && item.version !== "";
  });
}

/** setup-node takes the first line matching this pattern; only offer `.tool-versions` when that line names node. */
function toolVersionsPinsNode(project: ProjectModel): boolean {
  const text = content(project, ".tool-versions");
  const found = text === undefined ? null : /^(?:node(js)?\s+)?v?(?<version>[^\s]+)$/m.exec(text);
  return found !== null && /^node/.test(found[0]);
}

function nonEmpty(project: ProjectModel, path: string): boolean {
  const text = content(project, path);
  return text !== undefined && text.trim() !== "";
}

const TOOLS: Tool[] = [
  {
    action: "actions/setup-node",
    language: "Node.js",
    versionInput: "node-version",
    fileInput: "node-version-file",
    fallback: "the Node.js version already on the runner's PATH is used",
    pinExample: "node-version: 22",
    rangeFiles: ["package.json `engines.node`"],
    candidates: (project) => [
      ...[".nvmrc", ".node-version"].filter((path) => nonEmpty(project, path)),
      ...(packageJsonPinsNode(project) ? ["package.json"] : []),
      ...(toolVersionsPinsNode(project) ? [".tool-versions"] : []),
    ],
  },
  {
    action: "actions/setup-python",
    language: "Python",
    versionInput: "python-version",
    fileInput: "python-version-file",
    fallback: "there is no root `.python-version`, so the Python on the runner's PATH is used",
    implicitFile: ".python-version",
    pinExample: "python-version: '3.13'",
    rangeFiles: ["pyproject.toml `requires-python`", "Pipfile `python_version`"],
    candidates: (project) => {
      const text = content(project, ".tool-versions");
      return text !== undefined && text.split(/\r?\n/).some((line) => /^\s*python\s*v?\s*[^\s]+\s*$/.test(line))
        ? [".tool-versions"]
        : [];
    },
  },
  {
    action: "actions/setup-go",
    language: "Go",
    versionInput: "go-version",
    fileInput: "go-version-file",
    fallback: "the action uses the Go version pre-installed on the runner",
    pinExample: "go-version: '1.24'",
    candidates: (project) => {
      const gomod = content(project, "go.mod");
      if (gomod !== undefined && /^\s*(go\s+\d|toolchain\s+go\d)/m.test(gomod)) return ["go.mod"];
      return [
        ...["go.work", ".go-version"].filter((path) => nonEmpty(project, path)),
        ...(/^golang\s+[^\n#]+/m.test(content(project, ".tool-versions") ?? "") ? [".tool-versions"] : []),
      ];
    },
  },
  {
    action: "actions/setup-dotnet",
    language: ".NET",
    versionInput: "dotnet-version",
    fileInput: "global-json-file",
    fallback: "there is no root `global.json`, so no SDK is installed and the newest SDK pre-installed on the runner is used",
    implicitFile: "global.json",
    pinExample: "dotnet-version: '9.0.x'",
    candidates: (project) => {
      const globals = [...project.files.keys()].filter((path) => path.endsWith("/global.json"));
      if (globals.length !== 1) return [];
      const sdk = record(json(content(project, globals[0] ?? ""))?.sdk);
      return typeof sdk?.version === "string" && sdk.version !== "" ? globals : [];
    },
  },
];

function hasInput(step: StepModel, name: string): boolean {
  const value = step.with.get(name)?.value;
  return value !== undefined && value !== null && String(value).trim() !== "";
}

/** The version file is only on disk when an earlier checkout put the repository at the workspace root. */
function workspaceCheckedOut(job: JobModel, step: StepModel): boolean {
  const checkouts = job.steps.filter((candidate) => candidate.index < step.index && usesAction(candidate, "actions/checkout"));
  return (
    checkouts.length > 0 &&
    checkouts.every((checkout) => !["path", "repository", "sparse-checkout"].some((input) => checkout.with.has(input)))
  );
}

function directChild(node: unknown, key: string): unknown {
  if (!isMap(node)) return undefined;
  const pair = node.items.find((item) => isPair(item) && isScalar(item.key) && String(item.key.value) === key);
  return pair && !isAlias(pair.value) ? pair.value : undefined;
}

/** The step's block mapping when the step and the path to it are written inline (no anchors, aliases or merge keys). */
function stepNode(workflow: WorkflowModel, step: StepModel): ReturnType<typeof directChild> {
  const match = /^jobs\.([^.]+)\.steps\[(\d+)\]$/.exec(step.key);
  if (!match) return undefined;
  const steps = directChild(directChild(directChild(workflow.source.doc.contents, "jobs"), match[1] ?? ""), "steps");
  if (!isSeq(steps)) return undefined;
  const node = steps.items[Number(match[2])];
  if (!isMap(node) || node.flow || lineOfNode(workflow.source, node) !== step.line) return undefined;
  return node;
}

function addInput(file: SourceFile, workflow: WorkflowModel, step: StepModel, input: string, path: string): Fix | undefined {
  const description = `Add \`${input}: ${path}\``;
  const node = stepNode(workflow, step);
  if (!isMap(node) || !step.uses) return undefined;
  if (node.items.some((item) => isPair(item) && isScalar(item.key) && item.key.value === "<<")) return undefined;
  const withNode = directChild(node, "with");
  if (withNode !== undefined) {
    if (!isMap(withNode) || withNode.flow) return undefined;
    const entries = [...step.with.values()];
    if (entries.length === 0 || entries.some((entry) => entry.origin !== "direct" || entry.line <= step.line)) return undefined;
    const first = Math.min(...entries.map((entry) => entry.line));
    const text = lineText(file.content, first);
    if (!/^\s*[A-Za-z0-9_-]+\s*:/.test(text) || /[{}]/.test(text)) return undefined;
    for (let line = first - 1; line >= step.line; line -= 1) {
      const candidate = lineText(file.content, line);
      if (/^\s*(-\s+)?with\s*:\s*(#.*)?$/.test(candidate)) {
        return fix(description, insertLinesAfter(file, first - 1, [`${indentOf(file.content, first)}${input}: ${path}`]));
      }
      if (candidate.trim() !== "" && !candidate.trim().startsWith("#")) return undefined;
    }
    return undefined;
  }
  if (step.with.size > 0) return undefined;
  const usesText = lineText(file.content, step.uses.line);
  const match = /^(\s*(?:-\s+)?)uses\s*:\s*[^\s#]+\s*(#.*)?$/.exec(usesText);
  if (!match) return undefined;
  const pad = (match[1] ?? "").length;
  const lines = file.content.split(/\r?\n/);
  const next = lines.slice(step.uses.line).find((line) => line.trim() !== "");
  if (next !== undefined && (indentOf(next, 1).length > pad || next.trim().startsWith("#"))) return undefined;
  return fix(
    description,
    insertLinesAfter(file, step.uses.line, [`${" ".repeat(pad)}with:`, `${" ".repeat(pad + 2)}${input}: ${path}`]),
  );
}

export default defineRule({
  meta: {
    id: "workflow/setup-action-missing-version-file",
    ruleset: "workflow",
    description:
      "Language setup actions (setup-node, setup-python, setup-go, setup-dotnet) should pin the toolchain with a version input or the repository's version file.",
    rationale:
      "Without `node-version`/`python-version`/`go-version`/`dotnet-version` or the matching `*-version-file`/`global-json-file` input, the setup action does not install a chosen toolchain: setup-node and setup-python fall back to the version on the runner's PATH, setup-go to the pre-installed Go, and setup-dotnet to the newest pre-installed SDK. Those versions change whenever GitHub updates the runner image, so the same commit can build with a different compiler or interpreter from one week to the next, and local development (which follows `.nvmrc`, `go.mod`, `.python-version` or `global.json`) drifts from CI. Pointing the action at the version file the project already maintains makes CI hermetic with a single source of truth.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/actions/setup-node#usage",
      "https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md#node-version-file",
      "https://github.com/actions/setup-python#basic-usage",
      "https://github.com/actions/setup-python/blob/main/docs/advanced-usage.md#using-the-python-version-file-input",
      "https://github.com/actions/setup-go/blob/main/docs/advanced-usage.md#using-the-go-version-file-input",
      "https://github.com/actions/setup-dotnet#using-the-global-json-file-input",
    ],
    impact: "medium",
    fixable: true,
    example: {
      bad: "- uses: actions/checkout@v5\n- uses: actions/setup-node@v5\n- run: npm ci",
      good: "- uses: actions/checkout@v5\n- uses: actions/setup-node@v5\n  with:\n    node-version-file: .nvmrc\n- run: npm ci",
    },
  },
  check({ project, input, report }) {
    const complete = input.mode === "repository" && input.inventoryComplete;
    for (const workflow of [...project.workflows, ...project.actions]) {
      const file = project.files.get(workflow.path);
      for (const job of workflow.jobs) {
        for (const step of job.steps) {
          const tool = TOOLS.find((candidate) => usesAction(step, candidate.action));
          if (!tool || !step.uses) continue;
          if (hasInput(step, tool.versionInput) || hasInput(step, tool.fileInput)) continue;
          if (tool.implicitFile !== undefined && (!complete || project.files.has(tool.implicitFile))) continue;
          const candidates = tool.candidates(project);
          const [only] = candidates;
          const repair =
            candidates.length === 1 && only !== undefined && file && workflow.kind === "workflow" && workspaceCheckedOut(job, step)
              ? addInput(file, workflow, step, tool.fileInput, only)
              : undefined;
          const uses = step.uses.value;
          const found =
            candidates.length > 0
              ? ` The repository already pins ${tool.language} in ${candidates.map((path) => `\`${path}\``).join(", ")}.`
              : "";
          const suggestion =
            candidates.length > 0
              ? `Read the version from the file the project already maintains:\n\n- uses: ${uses}\n  with:\n    ${tool.fileInput}: ${only ?? ""}`
              : `Pin the toolchain explicitly (example version shown), or add a version file and point \`${tool.fileInput}\` at it:\n\n- uses: ${uses}\n  with:\n    ${tool.pinExample}${
                  tool.rangeFiles ? `\n\n${tool.rangeFiles.join(" and ")} only declare a range, which resolves to whatever is newest at run time.` : ""
                }`;
          report({
            path: workflow.path,
            line: step.uses.line,
            key: `${step.key}.with.${tool.versionInput}`,
            message: `\`${tool.action}\` sets neither \`${tool.versionInput}\` nor \`${tool.fileInput}\`, so ${tool.fallback}; that version changes whenever the runner image is updated.${found}`,
            suggestion,
            ...(repair ? { fix: repair } : {}),
          });
        }
      }
    }
  },
});
