import { isScalar, Scalar, type Node, type YAMLMap } from "yaml";
import { fix, indentOf, insertLinesAfter } from "../../fix.js";
import type { StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { lineOfNode } from "../../parsers/yaml.js";
import type { Fix, SourceFile } from "../../types.js";
import { defineRule, directWith, stepLine, steps } from "../helpers.js";

const UPLOAD_ACTIONS = new Set(["actions/upload-artifact", "actions/upload-artifact/merge"]);
const SINGLE_LINE = new Set<unknown>([Scalar.PLAIN, Scalar.QUOTE_DOUBLE, Scalar.QUOTE_SINGLE]);

function retentionDays(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return Number(value);
  return undefined;
}

/** Adds `retention-days` to a block-style `with:` mapping: after its last single-line entry, else before its first. */
function addRetention(file: SourceFile, workflow: WorkflowModel, step: StepModel, days: number): Fix | undefined {
  const withNode: YAMLMap | undefined = directWith(workflow, step);
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
  const line = `${indent}retention-days: ${days}`;
  return fix(
    `Set retention-days: ${days}`,
    endsOnKeyLine ? insertLinesAfter(file, lastLine, [line]) : insertLinesAfter(file, firstLine - 1, [line]),
  );
}

export default defineRule({
  meta: {
    id: "workflow/artifact-retention",
    ruleset: "workflow",
    description: "Uploaded artifacts should set a short `retention-days` instead of the repository default.",
    rationale:
      "Artifacts are kept for the repository default (90 days unless changed) and count against Actions storage. Agent-driven repositories produce many runs per day, so build outputs that only feed later jobs pile up quickly; a short retention keeps storage and quota headroom without slowing anything down.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: { maxDays: 7 },
    validateOptions: (options) =>
      Object.entries(options)
        .filter(([, value]) => typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 90)
        .map(([key]) => `${key} must be an integer between 1 and 90`),
    references: [
      "https://github.com/actions/upload-artifact#retention-period",
      "https://docs.github.com/en/actions/how-tos/manage-workflow-runs/remove-workflow-artifacts#setting-the-retention-period-for-an-artifact",
    ],
    impact: "low",
    fixable: true,
    example: {
      bad: "- uses: actions/upload-artifact@v7\n  with:\n    name: dist\n    path: dist/",
      good: "- uses: actions/upload-artifact@v7\n  with:\n    name: dist\n    path: dist/\n    retention-days: 7",
    },
  },
  check({ project, options, report }) {
    const maxDays = options.maxDays;
    for (const { workflow, step } of steps([...project.workflows, ...project.actions])) {
      const action = step.uses?.action;
      if (action?.kind !== "remote" || action.name === undefined || !UPLOAD_ACTIONS.has(action.name)) continue;
      const retention = step.with.get("retention-days");
      if (!retention) {
        const file = project.files.get(workflow.path);
        const repair = file ? addRetention(file, workflow, step, maxDays) : undefined;
        report({
          path: workflow.path,
          line: stepLine(step),
          key: `${step.key}.with.retention-days`,
          message: "Artifact upload has no retention-days, so it is kept for the repository default (up to 90 days).",
          suggestion: `Add \`retention-days: ${maxDays}\` to the step's \`with:\` block; artifacts passed between jobs or kept for debugging rarely need more.`,
          ...(repair ? { fix: repair } : {}),
        });
        continue;
      }
      if (retention.kind !== "literal") continue;
      const days = retentionDays(retention.value);
      if (days === undefined) continue;
      if (days === 0) {
        report({
          path: workflow.path,
          line: retention.line,
          key: `${step.key}.with.retention-days`,
          message: "`retention-days: 0` falls back to the repository default retention (up to 90 days).",
          suggestion: `Set \`retention-days: ${maxDays}\` or less.`,
        });
      } else if (days > maxDays) {
        report({
          path: workflow.path,
          line: retention.line,
          key: `${step.key}.with.retention-days`,
          message: `Artifact is kept for ${days} days, above the configured maximum of ${maxDays}.`,
          suggestion: `Lower \`retention-days\` to ${maxDays} or less unless this artifact is a release deliverable that must outlive the run.`,
        });
      }
    }
  },
});
