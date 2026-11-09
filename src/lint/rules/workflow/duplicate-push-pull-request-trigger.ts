import { isMap, isScalar, type Node } from "yaml";
import { fix, indentOf, insertLinesAfter, lineText } from "../../fix.js";
import { trigger, type WorkflowModel } from "../../parsers/workflow.js";
import { entries, field, lineOfNode, toJS } from "../../parsers/yaml.js";
import type { Fix, SourceFile } from "../../types.js";
import { defineRule } from "../helpers.js";

const ALL_BRANCHES = new Set(["*", "**"]);
const PLAIN_BRANCH = /^[A-Za-z0-9._/-]+$/;
const SYNC_TYPES = new Set(["synchronize"]);

function stringList(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(String);
  return undefined;
}

/** Jobs that branch on the event or the PR head repository usually de-duplicate push/pull_request runs themselves. */
function dedupesItself(workflow: WorkflowModel): boolean {
  const concurrency = JSON.stringify(workflow.concurrency?.value ?? "");
  if (/head_ref/.test(concurrency)) return true;
  return workflow.jobs.some((job) => /event_name|head\.repo|head_ref/.test(job.if ?? ""));
}

function branchList(branches: string[]): string {
  return `[${branches.join(", ")}]`;
}

/** Adds `branches: [...]` under a block-map `on.push:` that has no branch or tag filter. */
function addBranches(file: SourceFile, workflow: WorkflowModel, branches: string[]): Fix | undefined {
  const source = workflow.source;
  const onField = field(source, source.doc.contents, "on");
  if (!onField || onField.origin !== "direct" || !isMap(onField.value) || onField.value.flow) return undefined;
  const push = field(source, onField.value, "push");
  if (!push || push.origin !== "direct") return undefined;
  const description = `Restrict push to ${branchList(branches)}`;
  if (push.value === null || (isScalar(push.value) && push.value.value === null)) {
    const text = lineText(file.content, push.line);
    if (!/^\s*["']?push["']?\s*:\s*(#.*)?$/.test(text)) return undefined;
    const pushIndent = indentOf(file.content, push.line).length;
    const firstEvent = entries(source, onField.value)[0];
    const eventIndent = firstEvent ? indentOf(file.content, firstEvent.line).length : pushIndent;
    const onIndent = indentOf(file.content, onField.line).length;
    const step = eventIndent > onIndent ? eventIndent - onIndent : 2;
    return fix(description, insertLinesAfter(file, push.line, [`${" ".repeat(pushIndent + step)}branches: ${branchList(branches)}`]));
  }
  if (!isMap(push.value) || push.value.flow) return undefined;
  const first = push.value.items[0];
  if (!first || !isScalar(first.key) || first.key.value === "<<") return undefined;
  const firstLine = lineOfNode(source, first.key as Node);
  if (firstLine <= push.line || !/^\s*[A-Za-z_-]+\s*:/.test(lineText(file.content, firstLine))) return undefined;
  return fix(
    description,
    insertLinesAfter(file, firstLine - 1, [`${indentOf(file.content, firstLine)}branches: ${branchList(branches)}`]),
  );
}

export default defineRule({
  meta: {
    id: "workflow/duplicate-push-pull-request-trigger",
    ruleset: "workflow",
    description:
      "A workflow triggered by both `push` (on every branch) and `pull_request` runs twice for every commit pushed to a same-repository pull request branch.",
    rationale:
      "A commit pushed to a branch that has an open pull request in the same repository fires a `push` event for the branch and a `pull_request` (`synchronize`) event for the PR. When `push` has no `branches` filter (or uses `*`/`**`), both events match and every job runs twice on the same code, doubling runner minutes and queue pressure. Restricting `push` to the default/release branches keeps post-merge coverage while PR commits are validated once by `pull_request`.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { defaultBranches: ["main"] as string[] },
    validateOptions: (options) => {
      const branches = options.defaultBranches;
      return Array.isArray(branches) &&
        branches.length > 0 &&
        branches.every((branch) => typeof branch === "string" && PLAIN_BRANCH.test(branch))
        ? []
        : ["defaultBranches must be a non-empty array of plain branch names"];
    },
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushbranchestagsbranches-ignoretags-ignore",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push",
    ],
    impact: "medium",
    fixable: true,
    example: {
      bad: "on:\n  push:\n  pull_request:",
      good: "on:\n  push:\n    branches: [main]\n  pull_request:",
    },
  },
  check({ project, options, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow") continue;
      const push = trigger(workflow, "push");
      const pullRequest = trigger(workflow, "pull_request");
      if (!push || !pullRequest) continue;
      if (pullRequest.types && !pullRequest.types.some((type) => SYNC_TYPES.has(type))) continue;
      const source = workflow.source;
      const onNode = field(source, source.doc.contents, "on")?.value;
      const pushConfig = toJS(source, field(source, onNode, "push")?.value);
      const config = pushConfig && typeof pushConfig === "object" && !Array.isArray(pushConfig)
        ? (pushConfig as Record<string, unknown>)
        : {};
      if (config["branches-ignore"] !== undefined) continue;
      const branches = stringList(config.branches);
      if (branches === undefined && (config.tags !== undefined || config["tags-ignore"] !== undefined)) continue;
      if (config.branches !== undefined && branches === undefined) continue;
      if (branches !== undefined) {
        if (branches.some((branch) => branch.startsWith("!"))) continue;
        if (!branches.some((branch) => ALL_BRANCHES.has(branch.trim()))) continue;
      }
      if (dedupesItself(workflow)) continue;
      const targets = (pullRequest.branches ?? []).filter((branch) => PLAIN_BRANCH.test(branch));
      const suggested =
        pullRequest.branches && pullRequest.branches.length > 0 && targets.length === pullRequest.branches.length
          ? targets
          : options.defaultBranches;
      const file = project.files.get(workflow.path);
      const repair = branches === undefined && file ? addBranches(file, workflow, suggested) : undefined;
      const filter =
        branches === undefined ? "`push` has no `branches` filter" : `\`push\` matches \`branches: ${branchList(branches)}\``;
      report({
        path: workflow.path,
        line: push.line,
        key: "on.push",
        message: `${filter} and \`pull_request\` is also a trigger, so every commit pushed to a same-repository pull request branch runs this workflow twice.`,
        suggestion: `Limit \`push\` to the branches you merge into and let \`pull_request\` validate PR commits:\n\non:\n  push:\n    branches: ${branchList(suggested)}\n  pull_request:`,
        ...(repair ? { fix: repair } : {}),
      });
    }
  },
});
