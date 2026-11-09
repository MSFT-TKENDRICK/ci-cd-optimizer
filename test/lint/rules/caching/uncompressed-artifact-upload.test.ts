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
      name: "single tarball: fix appends after the last entry",
      files: job(...upload("v4", "          name: bundle", "          path: dist/app.tar.gz")),
      errors: [
        {
          line: 7,
          messageIncludes:
            "`actions/upload-artifact` recompresses `dist/app.tar.gz` at the default `compression-level: 6`, but this file is already compressed",
        },
      ],
      output: job(...upload("v4", "          name: bundle", "          path: dist/app.tar.gz", "          compression-level: 0")),
    },
    {
      name: "block-scalar path: fix inserts before the first entry",
      files: job(...upload("v5", "          name: packages", "          path: |", "            dist/*.whl", "            dist/*.TAR.GZ")),
      errors: [{ line: 7, messageIncludes: "recompresses `dist/*.whl`, `dist/*.TAR.GZ` at the default" }],
      output: job(
        ...upload(
          "v5",
          "          compression-level: 0",
          "          name: packages",
          "          path: |",
          "            dist/*.whl",
          "            dist/*.TAR.GZ",
        ),
      ),
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
      errors: [{ line: 7, messageIncludes: "recompresses `shots/**/*.png` at the default" }],
      output: job(
        ...upload(
          "ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2",
          "          name: screenshots",
          "          path: |",
          "            shots/**/*.png",
          "            !shots/tmp/*.png",
          "          retention-days: 3",
          "          compression-level: 0",
        ),
      ),
    },
  ],
});
