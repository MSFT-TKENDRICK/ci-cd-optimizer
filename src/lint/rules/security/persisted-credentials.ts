import { isScalar, Scalar, type Node } from "yaml";
import { fix, indentOf, insertLinesAfter, lineText } from "../../fix.js";
import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { hasTrigger } from "../../parsers/workflow.js";
import { lineOfNode } from "../../parsers/yaml.js";
import type { Fix, SourceFile } from "../../types.js";
import { isFalse, isTrue, listOf, usesAction } from "../caching/shared.js";
import { actionVersion, defineRule, directWith, stepLine } from "../helpers.js";
import { directStep, untrustedCheckoutTarget } from "./shared.js";

const UPLOAD_ACTIONS = ["actions/upload-artifact", "actions/upload-artifact/merge"];
const SINGLE_LINE = new Set<unknown>([Scalar.PLAIN, Scalar.QUOTE_DOUBLE, Scalar.QUOTE_SINGLE]);
const WORKSPACE_ROOT = /^(?:\.\/?|\$\{\{\s*github\.workspace\s*\}\}\/?)$/;

/** Upload steps that could include `.git/config`, where checkout stores the token. */
function uploadsGitDirectory(step: StepModel, file: SourceFile | undefined): boolean {
  if (!usesAction(step, ...UPLOAD_ACTIONS)) return false;
  if (isTrue(step.with.get("include-hidden-files")?.value)) return true;
  const path = step.with.get("path")?.value;
  if (typeof path !== "string" || !listOf(path).some((entry) => WORKSPACE_ROOT.test(entry))) return false;
  // upload-artifact v4.4.0 stopped including hidden files by default; unknown versions are not flagged.
  const version = actionVersion(step, file);
  if (!version) return false;
  return version.major < 4 || (version.major === 4 && version.minor !== undefined && version.minor < 4);
}

function exposure(workflow: WorkflowModel, job: JobModel, file: SourceFile | undefined): string | undefined {
  const upload = job.steps.find((step) => uploadsGitDirectory(step, file));
  if (upload) return `the job uploads an artifact that can include \`.git/config\` (line ${stepLine(upload)})`;
  if (!hasTrigger(workflow, "pull_request_target", "workflow_run")) return undefined;
  const index = job.steps.findIndex((step) => usesAction(step, "actions/checkout") && untrustedCheckoutTarget(step));
  if (index < 0) return undefined;
  const runsCode = job.steps.slice(index + 1).some((step) => step.run !== undefined || step.uses?.action.kind === "local");
  return runsCode ? "the job runs pull request code in a privileged workflow" : undefined;
}

function addPersistCredentials(file: SourceFile, workflow: WorkflowModel, step: StepModel): Fix | undefined {
  const description = "Set persist-credentials: false";
  if (step.with.size > 0 || step.uses?.kind !== "literal") {
    const withNode = directWith(workflow, step);
    const pairs = (withNode?.items ?? []).filter((pair) => isScalar(pair.key) && pair.key.value !== "<<");
    const first = pairs[0];
    const last = pairs[pairs.length - 1];
    if (!first || !last) return undefined;
    const firstLine = lineOfNode(workflow.source, first.key as Node);
    const indent = indentOf(file.content, firstLine);
    const lastLine = lineOfNode(workflow.source, last.key as Node);
    const value = last.value;
    const endsOnKeyLine =
      isScalar(value) &&
      SINGLE_LINE.has(value.type) &&
      value.range !== undefined &&
      value.range !== null &&
      workflow.source.lineCounter.linePos(Math.max(value.range[0], value.range[1] - 1)).line === lastLine;
    const line = `${indent}persist-credentials: false`;
    return fix(description, insertLinesAfter(file, endsOnKeyLine ? lastLine : firstLine - 1, [line]));
  }
  const node = directStep(workflow, step);
  if (!node || node.items.some((pair) => isScalar(pair.key) && pair.key.value === "with")) return undefined;
  const usesPair = node.items.find((pair) => isScalar(pair.key) && pair.key.value === "uses");
  if (!usesPair || !isScalar(usesPair.value) || !SINGLE_LINE.has(usesPair.value.type)) return undefined;
  const usesLine = lineOfNode(workflow.source, usesPair.key as Node);
  const text = lineText(file.content, usesLine);
  const match = /^(\s*)(-\s+)?uses\s*:/.exec(text);
  if (!match) return undefined;
  const indent = (match[1] ?? "") + " ".repeat(match[2]?.length ?? 0);
  return fix(description, insertLinesAfter(file, usesLine, [`${indent}with:`, `${indent}  persist-credentials: false`]));
}

export default defineRule({
  meta: {
    id: "security/persisted-credentials",
    ruleset: "security",
    description:
      "`actions/checkout` should set `persist-credentials: false` in jobs that upload the workspace or run pull request code with elevated privileges.",
    rationale:
      "By default `actions/checkout` writes the job's token into `.git/config` so later git commands can authenticate. Any later step can read it, and an artifact that includes the `.git` directory publishes it to anyone who can download the artifact. When the job does not push, disabling credential persistence removes the token from disk entirely.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/actions/checkout#usage",
      "https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions",
      "https://github.com/actions/upload-artifact#uploading-hidden-files",
    ],
    impact: "medium",
    fixable: true,
    example: {
      bad: "- uses: actions/checkout@v5\n- uses: actions/upload-artifact@v4\n  with:\n    path: .\n    include-hidden-files: true",
      good: "- uses: actions/checkout@v5\n  with:\n    persist-credentials: false\n- uses: actions/upload-artifact@v4\n  with:\n    path: .\n    include-hidden-files: true",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      const file = project.files.get(workflow.path);
      for (const job of workflow.jobs) {
        const checkouts = job.steps.filter(
          (step) => usesAction(step, "actions/checkout") && !isFalse(step.with.get("persist-credentials")?.value),
        );
        if (checkouts.length === 0) continue;
        const reason = exposure(workflow, job, file);
        if (reason === undefined) continue;
        for (const step of checkouts) {
          if (step.with.get("persist-credentials")?.kind === "expression") continue;
          const repair = file ? addPersistCredentials(file, workflow, step) : undefined;
          report({
            path: workflow.path,
            line: stepLine(step),
            key: `${step.key}.with.persist-credentials`,
            message: `Checkout leaves the job token in \`.git/config\` and ${reason}.`,
            suggestion:
              "Add `persist-credentials: false` under `with:`. If a later step must push, pass the token to that step explicitly instead.",
            ...(repair ? { fix: repair } : {}),
          });
        }
      }
    }
  },
});
