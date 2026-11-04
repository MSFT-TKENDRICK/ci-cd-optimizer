import { isAlias, isMap, isScalar, isSeq, type Node } from "yaml";
import { fix, replaceOnLine } from "../../fix.js";
import type { JobModel, WorkflowModel } from "../../parsers/workflow.js";
import { field, items, lineOfNode, resolveNode, stringValue, type YamlSource } from "../../parsers/yaml.js";
import type { SourceFile } from "../../types.js";
import { defineRule } from "../helpers.js";

type Os = "ubuntu" | "windows" | "macos";
type Options = Record<Os, string>;

const LATEST = /^(ubuntu|windows|macos)-latest$/i;
const MATRIX_REF = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/;

interface Label {
  node: Node;
  value: string;
  key: string;
  /** False when the value comes from an alias or merge key, so editing it in place is unsafe. */
  direct: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function osOf(label: string): Os {
  return label.toLowerCase().split("-")[0] as Os;
}

function describe(label: string): string {
  return osOf(label) === "ubuntu"
    ? `\`${label}\` is a moving label that is migrating from Ubuntu 24.04 to Ubuntu 26.04 (Oct 19 – Nov 19, 2026), so the same commit can run on different images`
    : `\`${label}\` is a moving label that switches OS images when GitHub migrates it, so the same commit can run on different images`;
}

/** The runs-on labels of a job, with their YAML nodes. Returns undefined for runner groups. */
function runsOnLabels(source: YamlSource, jobNode: unknown, job: JobModel): Label[] | undefined {
  const runsOn = field(source, jobNode, "runs-on");
  if (!runsOn?.value) return [];
  let node: unknown = runsOn.value;
  let key = `${job.key}.runs-on`;
  let direct = runsOn.origin === "direct";
  if (isMap(node)) {
    if (field(source, node, "group")) return undefined;
    const labels = field(source, node, "labels");
    if (!labels?.value) return [];
    node = labels.value;
    key += ".labels";
    direct &&= labels.origin === "direct";
  }
  if (isScalar(node)) {
    const value = stringValue(node);
    return value === undefined ? [] : [{ node, value, key, direct }];
  }
  if (!isSeq(node)) return [];
  return node.items.flatMap((raw, index) => {
    const resolved = resolveNode(source, raw).node;
    const value = isScalar(resolved) ? stringValue(resolved) : undefined;
    return resolved && value !== undefined ? [{ node: resolved, value, key: `${key}[${index}]`, direct: direct && !isAlias(raw) }] : [];
  });
}

/** Literal values a `${{ matrix.<name> }}` reference can take, from the matrix axis and `include` entries. */
function matrixValues(source: YamlSource, jobNode: unknown, job: JobModel, name: string): Label[] {
  const matrix = field(source, field(source, jobNode, "strategy")?.value, "matrix")?.value;
  const result: Label[] = [];
  const axis = field(source, matrix, name)?.value;
  const axisNodes = isSeq(resolveNode(source, axis).node) ? items(source, axis) : axis ? [axis] : [];
  axisNodes.forEach((node, index) => {
    const value = isScalar(node) ? stringValue(node) : undefined;
    if (value !== undefined) result.push({ node, value, key: `${job.key}.strategy.matrix.${name}[${index}]`, direct: false });
  });
  items(source, field(source, matrix, "include")?.value).forEach((entry, index) => {
    const node = field(source, entry, name)?.value;
    const value = isScalar(node) ? stringValue(node) : undefined;
    if (node && value !== undefined) result.push({ node, value, key: `${job.key}.strategy.matrix.include[${index}].${name}`, direct: false });
  });
  return result;
}

function jobNodeOf(workflow: WorkflowModel, job: JobModel): unknown {
  const source = workflow.source;
  return field(source, field(source, source.doc.contents, "jobs")?.value, job.id)?.value;
}

export default defineRule({
  meta: {
    id: "hermeticity/pin-runner",
    ruleset: "hermeticity",
    description: "Jobs should run on a pinned runner image label instead of `*-latest`.",
    rationale:
      "`ubuntu-latest`, `windows-latest` and `macos-latest` move to a new OS image during a gradual multi-week rollout, so identical commits can pass on one run and fail on the next with different toolchains and preinstalled software. `ubuntu-latest` is migrating from Ubuntu 24.04 to 26.04 between Oct 19 and Nov 19, 2026. Pinning makes the upgrade a deliberate, reviewable change.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { ubuntu: "ubuntu-24.04", windows: "windows-2025", macos: "macos-15" } as Options,
    validateOptions: (options) =>
      Object.entries(options)
        .filter(([, value]) => typeof value !== "string" || value.trim() === "" || /-latest$/i.test(value))
        .map(([key]) => `${key} must be a pinned runner label (a non-empty string that does not end in -latest)`),
    references: [
      "https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories",
      "https://github.com/actions/runner-images#available-images",
      "https://github.com/actions/runner-images#ongoing-migrations",
    ],
    impact: "medium",
    fixable: true,
    example: { bad: "runs-on: ubuntu-latest", good: "runs-on: ubuntu-24.04" },
  },
  check({ project, options, report }) {
    for (const workflow of project.workflows) {
      const source = workflow.source;
      const file: SourceFile | undefined = project.files.get(workflow.path);
      for (const job of workflow.jobs) {
        const jobNode = jobNodeOf(workflow, job);
        const labels = runsOnLabels(source, jobNode, job);
        if (!labels || labels.some((label) => label.value.trim().toLowerCase() === "self-hosted")) continue;
        for (const label of labels) {
          const value = label.value.trim();
          const matrixName = MATRIX_REF.exec(value)?.[1];
          if (matrixName) {
            for (const entry of matrixValues(source, jobNode, job, matrixName)) {
              const candidate = entry.value.trim();
              if (!LATEST.test(candidate)) continue;
              const pinned = options[osOf(candidate)];
              report({
                path: workflow.path,
                line: lineOfNode(source, entry.node),
                key: entry.key,
                message: `Matrix value ${describe(candidate)}.`,
                suggestion: `Change the matrix value to \`${pinned}\` (this renames the matrix jobs, so update required status checks and any \`matrix.${matrixName}\` conditions).`,
              });
            }
            continue;
          }
          if (!LATEST.test(value)) continue;
          const pinned = options[osOf(value)];
          const line = lineOfNode(source, label.node);
          const edit =
            label.direct && file !== undefined
              ? replaceOnLine(file, line, new RegExp(`(?<![\\w.-])${escapeRegExp(value)}(?![\\w.-])`), pinned)
              : undefined;
          const autofix = edit ? fix(`Pin runner to ${pinned}`, edit) : undefined;
          report({
            path: workflow.path,
            line,
            key: label.key,
            message: `${describe(value)}.`,
            suggestion: `Pin to \`${pinned}\` and upgrade deliberately in a dedicated change.`,
            ...(autofix ? { fix: autofix } : {}),
          });
        }
      }
    }
  },
});
