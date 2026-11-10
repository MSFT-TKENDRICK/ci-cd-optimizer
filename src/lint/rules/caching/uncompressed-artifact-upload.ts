import { actionVersion, defineRule, stepLine, stepsUsing } from "../helpers.js";
import { listOf } from "./shared.js";

/**
 * Extensions commonly used for compressed contents; extension alone does not establish compressibility.
 */
const COMPRESSED =
  /\.(?:zip|gz|tgz|zst|xz|txz|bz2|tbz2|lz4|7z|br|jar|war|ear|whl|nupkg|snupkg|vsix|apk|aab|ipa|png|jpe?g|webp|gif|mp4|webm|mov|mkv)$/i;

export default defineRule({
  meta: {
    id: "caching/uncompressed-artifact-upload",
    ruleset: "caching",
    description: "Artifacts that only contain already-compressed files should be uploaded with `compression-level: 0`.",
    rationale:
      "Recognized actions/upload-artifact versions default to compression-level 6. Extensions such as .gz and .zip commonly identify compressed content, but archives may contain uncompressed entries and extension alone is not evidence of actual bytes or upload-time savings. Level 0 preserves extracted file contents but changes archive bytes, size and digest. Compare representative transfer/storage cost and consumer expectations before manually changing compression policy.",
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
    fixable: false,
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
      if (major === undefined || major < 4 || major > 7) continue;
      const path = step.with.get("path");
      if (!path || path.kind === "expression" || typeof path.value !== "string") continue;
      const entries = listOf(path.value).filter((entry) => !entry.startsWith("!"));
      if (entries.length === 0 || !entries.every((entry) => COMPRESSED.test(entry))) continue;
      const shown = entries.map((entry) => `\`${entry}\``).join(", ");
      report({
        path: workflow.path,
        line: stepLine(step),
        key: `${step.key}.with.compression-level`,
        message: `\`actions/upload-artifact\` uses default \`compression-level: 6\` for ${shown}, whose extensions commonly identify already-compressed files. Measure compressibility and transfer cost; the filenames do not prove a speed or size benefit from level 0.`,
        suggestion: [
          "If content is already compressed and archive-byte identity is not required, consider level 0 (extracted contents are unchanged; archive bytes/digest/size change):",
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
        confidence: "medium",
      });
    }
  },
});
