import rule from "../../../../src/lint/rules/caching/uncompressed-artifact-upload.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;

const job = (...stepLines: string[]): string =>
  yml("on: push", "jobs:", "  package:", "    runs-on: ubuntu-latest", "    steps:", "      - run: make dist", ...stepLines);

const upload = (version: string, ...withLines: string[]): string[] => [
  `      - uses: actions/upload-artifact@${version}`,
  "        with:",
  ...withLines,
];

ruleTester(rule, {
  valid: [
    {
      name: "compression-level already set",
      files: job(...upload("v4", "          name: bundle", "          path: dist/app.tar.gz", "          compression-level: 0")),
    },
    {
      name: "uncompressed build output",
      files: job(...upload("v4", "          name: dist", "          path: dist/")),
    },
    {
      name: "trap: mixed compressed and text files",
      files: job(...upload("v4", "          name: report", "          path: |", "            dist/app.zip", "            report.json")),
    },
    {
      name: "trap: v3 has no compression-level input",
      files: job(...upload("v3", "          name: bundle", "          path: dist/app.zip")),
    },
    {
      name: "trap: unknown version (branch ref)",
      files: job(...upload("main", "          name: bundle", "          path: dist/app.zip")),
    },
    {
      name: "trap: path from an expression",
      files: job(...upload("v4", "          name: bundle", "          path: ${{ steps.pack.outputs.file }}")),
    },
    {
      name: "trap: archive: false uploads the file as-is",
      files: job(...upload("v7", "          path: dist/app.zip", "          archive: false")),
    },
    {
      name: "trap: download-artifact is not an upload",
      files: job("      - uses: actions/download-artifact@v5", "        with:", "          path: dist/app.zip"),
    },
  ],
  invalid: [
    {
      name: "single tarball: compression is a manual resource tradeoff",
      files: job(...upload("v4", "          name: bundle", "          path: dist/app.tar.gz")),
      errors: [
        {
          line: 7,
          messageIncludes:
            "`actions/upload-artifact` uses default `compression-level: 6` for `dist/app.tar.gz`, whose extensions commonly identify already-compressed files. Measure compressibility and transfer cost; the filenames do not prove a speed or size benefit from level 0.",
        },
      ],
      output: null,
    },
    {
      name: "block-scalar path: compression recommendation leaves YAML unchanged",
      files: job(...upload("v5", "          name: packages", "          path: |", "            dist/*.whl", "            dist/*.TAR.GZ")),
      errors: [{ line: 7, messageIncludes: "`actions/upload-artifact` uses default `compression-level: 6` for `dist/*.whl`, `dist/*.TAR.GZ`, whose extensions commonly identify already-compressed files. Measure compressibility and transfer cost; the filenames do not prove a speed or size benefit from level 0." }],
      output: null,
    },
    {
      name: "negated entries are ignored, pinned SHA with a version comment",
      files: job(
        ...upload(
          "ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2",
          "          name: screenshots",
          "          path: |",
          "            shots/**/*.png",
          "            !shots/tmp/*.png",
          "          retention-days: 3",
        ),
      ),
      errors: [{ line: 7, messageIncludes: "`actions/upload-artifact` uses default `compression-level: 6` for `shots/**/*.png`, whose extensions commonly identify already-compressed files. Measure compressibility and transfer cost; the filenames do not prove a speed or size benefit from level 0." }],
      output: null,
    },
  ],
});
