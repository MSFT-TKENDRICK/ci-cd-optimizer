import { fix, indentOf, insertLinesAfter, lineText } from "../../fix.js";
import { actionVersion, defineRule, directWith, stepsUsing } from "../helpers.js";

export default defineRule({
  meta: {
    id: "checkout/partial-clone",
    ruleset: "checkout",
    description: "Full-history checkouts (`fetch-depth: 0`) should use a blobless partial clone (`filter: blob:none`).",
    rationale:
      "`fetch-depth: 0` downloads every version of every file ever committed, which dominates checkout time in large or long-lived repositories. A blobless partial clone keeps the full commit graph that history-aware tools (affected detection, changelogs, versioning) need, and fetches file contents lazily only when a command reads them. Agent-driven repositories run many more jobs, so the saving compounds.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/actions/checkout#usage",
      "https://github.blog/open-source/git/get-up-to-speed-with-partial-clone-and-shallow-clone/",
    ],
    impact: "medium",
    fixable: true,
    example: {
      bad: "- uses: actions/checkout@v7\n  with:\n    fetch-depth: 0",
      good: "- uses: actions/checkout@v7\n  with:\n    fetch-depth: 0\n    filter: blob:none",
    },
  },
  check({ project, report }) {
    for (const { workflow, step } of stepsUsing([...project.workflows, ...project.actions], "actions/checkout")) {
      const depth = step.with.get("fetch-depth");
      if (!depth || depth.kind !== "literal" || !(depth.value === 0 || depth.value === "0")) continue;
      if (step.with.has("filter") || step.with.has("sparse-checkout")) continue;
      const file = project.files.get(workflow.path);
      const version = actionVersion(step, file);
      // The `filter` input exists since actions/checkout v4.1.0; older pins would ignore it with a warning.
      const supportsFilter = !version || version.major > 4 || (version.major === 4 && version.minor !== 0);
      const directLine =
        file &&
        supportsFilter &&
        depth.origin === "direct" &&
        directWith(workflow, step) !== undefined &&
        /^\s*fetch-depth\s*:/.test(lineText(file.content, depth.line));
      report({
        path: workflow.path,
        line: depth.line,
        key: `${step.key}.with.filter`,
        message: "Checkout fetches the full history including every historical file version (fetch-depth: 0 without a filter).",
        suggestion: supportsFilter
          ? "Add `filter: blob:none` to keep the full commit history but download file contents only when a command needs them (for example `git diff` or `git blame` on old revisions)."
          : "Upgrade to a current actions/checkout major, which supports `filter: blob:none`, then add it to keep the full commit history while downloading file contents on demand.",
        ...(directLine
          ? {
              fix: fix(
                "Add filter: blob:none",
                insertLinesAfter(file, depth.line, [`${indentOf(file.content, depth.line)}filter: blob:none`]),
              ),
            }
          : {}),
      });
    }
  },
});
