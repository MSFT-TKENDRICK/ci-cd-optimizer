import { trigger, type WorkflowModel } from "../../parsers/workflow.js";
import { field, toJS } from "../../parsers/yaml.js";
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

export default defineRule({
  meta: {
    id: "workflow/duplicate-push-pull-request-trigger",
    ruleset: "workflow",
    description:
      "A workflow accepting both broad `push` and `pull_request` events may repeat overlapping work for same-repository pull requests.",
    rationale:
      "A push to an open same-repository pull request can trigger both push and pull_request runs. They are not equivalent: push usually checks the branch tip, while pull_request checks a synthetic merge commit, and event conditions, paths, permissions and required checks can differ. Review whether that overlap is intentional. Restricting push changes branch and tag coverage, so this rule never edits triggers automatically.",
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
    fixable: false,
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
      const filter =
        branches === undefined ? "`push` has no `branches` filter" : `\`push\` matches \`branches: ${branchList(branches)}\``;
      report({
        path: workflow.path,
        line: push.line,
        key: "on.push",
        message: `${filter} and \`pull_request\` is also a trigger, so pushes to open same-repository pull requests may trigger overlapping work. Push and PR merge refs are different; this does not prove duplicate coverage.`,
        suggestion: `Only if branch-tip, tag and non-PR branch coverage can be changed, consider restricting push to your actual integration branches. Preserve required checks and existing filters; the branch names below are configured suggestions, not discovered defaults:\n\non:\n  push:\n    branches: ${branchList(suggested)}\n  pull_request:`,
      });
    }
  },
});
