import type { StepModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import { usesAction } from "../caching/shared.js";
import { actionVersion, defineRule } from "../helpers.js";

interface Tool {
  action: string;
  language: string;
  versionInput: string;
  fileInput: string;
  knownMajor: number;
  /** What the action does when neither input is set (quoted from the action's README or source). */
  fallback: string;
  /** Root file the action reads on its own when neither input is set. */
  implicitFile?: string;
  pinExample: string;
  /** Other declarations whose constraints and action support need inspection. */
  rangeFiles?: string[];
  candidates(project: ProjectModel, major: number): string[];
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
function packageJsonPinsNode(project: ProjectModel, major: number): boolean {
  const manifest = json(content(project, "package.json"));
  if (!manifest) return false;
  const volta = record(manifest.volta)?.node;
  if (typeof volta === "string" && volta.trim() !== "") return true;
  if (major < 6) return false;
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
    knownMajor: 6,
    fallback: "the Node.js version already on the runner's PATH is used",
    pinExample: "node-version: 22",
    rangeFiles: ["package.json `engines.node`"],
    candidates: (project, major) => [
      ...[".nvmrc", ".node-version"].filter((path) => nonEmpty(project, path)),
      ...(packageJsonPinsNode(project, major) ? ["package.json"] : []),
      ...(toolVersionsPinsNode(project) ? [".tool-versions"] : []),
    ],
  },
  {
    action: "actions/setup-python",
    language: "Python",
    versionInput: "python-version",
    fileInput: "python-version-file",
    knownMajor: 6,
    fallback: "without a root `.python-version` the Python on the runner's PATH is used",
    implicitFile: ".python-version",
    pinExample: "python-version: '3.13'",
    rangeFiles: ["pyproject.toml `requires-python`", "Pipfile `python_version`"],
    candidates: (project) => {
      const text = content(project, ".tool-versions");
      return text !== undefined && text.split(/\r?\n/).some((line) => /^python\s+v?[^\s]+\s*$/.test(line))
        ? [".tool-versions"]
        : [];
    },
  },
  {
    action: "actions/setup-go",
    language: "Go",
    versionInput: "go-version",
    fileInput: "go-version-file",
    knownMajor: 6,
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
    knownMajor: 5,
    fallback: "without a root `global.json` no SDK is installed and the newest SDK pre-installed on the runner is used",
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

export default defineRule({
  meta: {
    id: "workflow/setup-action-missing-version-file",
    ruleset: "workflow",
    description:
      "Language setup actions (setup-node, setup-python, setup-go, setup-dotnet) should pin the toolchain with a version input or the repository's version file.",
    rationale:
      "Without explicit version inputs or supported implicit version files, setup actions generally fall back to pre-installed toolchains. Hosted image updates or custom runner provisioning may then change the selected version. Reusing the project's supported version file can align CI and local development, but version ranges, aliases and .NET roll-forward policies still permit different releases. A version input is not a hermetic-build guarantee. Selecting a toolchain can change behavior and therefore is never automatically applied.",
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
    fixable: false,
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
          const version = actionVersion(step, file);
          if (!version || version.major < 3 || version.major > tool.knownMajor) continue;
          if (hasInput(step, tool.versionInput) || hasInput(step, tool.fileInput)) continue;
          if (tool.implicitFile !== undefined && (!complete || project.files.has(tool.implicitFile))) continue;
          const candidates = tool.candidates(project, version.major).filter((path) =>
            path !== ".tool-versions" || tool.action === "actions/setup-node" || version.major >= 6,
          );
          const [only] = candidates;
          const uses = step.uses.value;
          const found =
            candidates.length > 0
              ? ` The repository declares ${tool.language} in ${candidates.map((path) => `\`${path}\``).join(", ")}.`
              : "";
          const suggestion =
            candidates.length > 0
              ? `After checking compatibility and ensuring checkout makes this file available at that path, consider reading its version selection:\n\n- uses: ${uses}\n  with:\n    ${tool.fileInput}: ${only ?? ""}`
              : `Pin the toolchain explicitly (example version shown), or add a version file and point \`${tool.fileInput}\` at it:\n\n- uses: ${uses}\n  with:\n    ${tool.pinExample}${
                  tool.rangeFiles ? `\n\nInspect ${tool.rangeFiles.join(" and ")} before reusing them: constraints may allow several releases, and action/file-format support varies by version.` : ""
                }`;
          report({
            path: workflow.path,
            line: step.uses.line,
            key: `${step.key}.with.${tool.versionInput}`,
            message: `\`${tool.action}\` sets neither \`${tool.versionInput}\` nor \`${tool.fileInput}\`, so ${tool.fallback}; runner image or provisioning changes can change that version.${found}`,
            suggestion,
          });
        }
      }
    }
  },
});
