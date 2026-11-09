import { isScalar, Scalar, type Node, type YAMLMap } from "yaml";
import { fix, indentOf, insertLinesAfter } from "../../fix.js";
import type { StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { lineOfNode } from "../../parsers/yaml.js";
import type { Fix, SourceFile } from "../../types.js";
import { actionVersion, defineRule, directWith, stepLine, stepsUsing } from "../helpers.js";
import { listOf } from "./shared.js";

/**
 * File types whose contents are already compressed (archives, zip-based packages, and lossy or deflate-coded media),
 * so Zlib at the default level 6 spends CPU for little or no size reduction.
 */
const COMPRESSED =
  /\.(?:zip|gz|tgz|zst|xz|txz|bz2|tbz2|lz4|7z|br|jar|war|ear|whl|nupkg|snupkg|vsix|apk|aab|ipa|png|jpe?g|webp|gif|mp4|webm|mov|mkv)$/i;

const SINGLE_LINE = new Set<unknown>([Scalar.PLAIN, Scalar.QUOTE_DOUBLE, Scalar.QUOTE_SINGLE]);

/** Adds `compression-level: 0` to a block-style `with:` mapping: after its last single-line entry, else before its first. */
function addCompressionLevel(file: SourceFile, workflow: WorkflowModel, step: StepModel): Fix | undefined {
  if ([...step.with.values()].some((entry) => entry.origin !== "direct")) return undefined;
  const withNode: YAMLMap | undefined = directWith(workflow, step);
  const pairs = (withNode?.items ?? []).filter((pair) => isScalar(pair.key) && pair.key.value !== "<<");
  const first = pairs[0];
  const last = pairs[pairs.length - 1];
  if (!first || !last || pairs.length !== withNode?.items.length) return undefined;
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
  const line = `${indent}compression-level: 0`;
  return fix(
    "Set compression-level: 0",
    endsOnKeyLine ? insertLinesAfter(file, lastLine, [line]) : insertLinesAfter(file, firstLine - 1, [line]),
  );
}

export default defineRule({
  meta: {
    id: "caching/uncompressed-artifact-upload",
    ruleset: "caching",
    description: "Artifacts that only contain already-compressed files should be uploaded with `compression-level: 0`.",
    rationale:
      "`actions/upload-artifact` (v4 and later) zips the uploaded files with Zlib at `compression-level: 6` by default. Archives, packages, images and video are already compressed, so a second compression pass spends CPU on the runner (and time in the job) for little or no size reduction. The action's README recommends `compression-level: 0` for large files that are not easily compressed, for significantly faster uploads; the files are still bundled into the artifact zip, only without recompression.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/actions/upload-artifact#altering-compressions-level-speed-v-size",
      "https://github.com/actions/upload-artifact/blob/main/action.yml",
    ],
    impact: "low",
    fixable: true,
    example: {
      bad: "- uses: actions/upload-artifact@v7\n  with:\n    name: bundle\n    path: dist/app.tar.gz",
      good: "- uses: actions/upload-artifact@v7\n  with:\n    name: bundle\n    path: dist/app.tar.gz\n    compression-level: 0",
    },
  },
  check({ project, report }) {
    for (const { workflow, step } of stepsUsing([...project.workflows, ...project.actions], "actions/upload-artifact")) {
      if (step.with.has("compression-level") || step.with.has("archive")) continue;
      const file = project.files.get(workflow.path);
      const major = actionVersion(step, file)?.major;
      if (major === undefined || major < 4) continue;
      const path = step.with.get("path");
      if (!path || path.kind === "expression" || typeof path.value !== "string") continue;
      const entries = listOf(path.value).filter((entry) => !entry.startsWith("!"));
      if (entries.length === 0 || !entries.every((entry) => COMPRESSED.test(entry))) continue;
      const repair = file ? addCompressionLevel(file, workflow, step) : undefined;
      const shown = entries.map((entry) => `\`${entry}\``).join(", ");
      report({
        path: workflow.path,
        line: stepLine(step),
        key: `${step.key}.with.compression-level`,
        message: `\`actions/upload-artifact\` recompresses ${shown} at the default \`compression-level: 6\`, but ${entries.length === 1 ? "this file is" : "these files are"} already compressed, so the upload spends CPU on Zlib for little or no size reduction.`,
        suggestion: [
          "Upload already-compressed files without recompressing them:",
          "",
          `- uses: ${step.uses?.value ?? "actions/upload-artifact@v7"}`,
          "  with:",
          ...[...step.with.entries()]
            .filter(([, entry]) => typeof entry.value !== "object")
            .flatMap(([name, entry]) => {
              const lines = String(entry.value).split(/\r?\n/).filter((text) => text.trim() !== "");
              return lines.length <= 1
                ? [`    ${name}: ${String(entry.value).trim()}`]
                : [`    ${name}: |`, ...lines.map((text) => `      ${text.trim()}`)];
            }),
          "    compression-level: 0",
        ].join("\n"),
        ...(repair ? { fix: repair } : {}),
      });
    }
  },
});
