import { actionVersion, defineRule, steps } from "../helpers.js";

const ACTION = "tj-actions/changed-files";
const MALICIOUS_SHA = "0e58ed8671d6b60d0890c21b07f8835ace038e67";
const ADVISORY = "CVE-2025-30066 (GHSA-mrrh-fwg8-r2c3)";

const SUGGESTION =
  "Pin `tj-actions/changed-files` to the full commit SHA of v46.0.1 or later (with a `# v46.x.y` comment), or replace it with `dorny/paths-filter@v4` or a plain `git diff --name-only` step. If this workflow ran on 2025-03-14 or 2025-03-15, review those run logs and rotate every secret the job could read.";

export default defineRule({
  meta: {
    id: "affected/trusted-change-detection",
    ruleset: "affected",
    description: "Change-detection steps must not use tj-actions/changed-files versions affected by CVE-2025-30066.",
    rationale:
      "Change detection runs on every pull request, often with secrets in scope. In March 2025 the tags of tj-actions/changed-files were repointed to a malicious commit that dumped runner memory, including secrets, into workflow logs (CVE-2025-30066). Versions before v46.0.1 are in the advisory's affected range; agents copying an old snippet reintroduce it.",
    kind: "practice",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/advisories/GHSA-mrrh-fwg8-r2c3",
      "https://nvd.nist.gov/vuln/detail/CVE-2025-30066",
      "https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions",
      "https://github.com/dorny/paths-filter",
    ],
    impact: "high",
    example: {
      bad: "- uses: tj-actions/changed-files@v45",
      good: "- uses: dorny/paths-filter@v4",
    },
  },
  check({ project, report }) {
    for (const { workflow, step } of steps([...project.workflows, ...project.actions])) {
      const uses = step.uses;
      if (!uses || uses.action.kind !== "remote" || uses.action.name !== ACTION) continue;
      const ref = uses.action.ref?.toLowerCase();
      const location = { path: workflow.path, line: uses.line, key: `${step.key}.uses`, suggestion: SUGGESTION };
      if (ref === MALICIOUS_SHA) {
        report({
          ...location,
          message: `${ACTION} is pinned to ${MALICIOUS_SHA.slice(0, 7)}, the malicious commit from ${ADVISORY} that dumps runner memory, including secrets, into the workflow log.`,
        });
        continue;
      }
      const version = actionVersion(step, project.files.get(workflow.path));
      if (!version) continue;
      const vulnerable = version.major < 46 || (version.major === 46 && version.minor === 0 && version.patch === 0);
      if (!vulnerable) continue;
      const shown = version.source === "comment" ? `${ACTION}@${ref?.slice(0, 7) ?? ""} (${version.text})` : `${ACTION}@${version.text}`;
      report({
        ...location,
        message: `${shown} is in the range affected by ${ADVISORY}, the March 2025 compromise that leaked CI secrets; the fix is v46.0.1.`,
        ...(version.source === "comment" ? { confidence: "medium" as const } : {}),
      });
    }
  },
});
