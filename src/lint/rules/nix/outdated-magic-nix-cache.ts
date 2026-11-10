import { usesAction } from "../caching/shared.js";
import { actionVersion, defineRule, stepLine, steps } from "../helpers.js";

const ACTION = "determinatesystems/magic-nix-cache-action";
/** First action major using the replacement cache API. */
const FIRST_WORKING_MAJOR = 10;
const CURRENT_MAJOR = "v15";

export default defineRule({
  meta: {
    id: "nix/outdated-magic-nix-cache",
    ruleset: "nix",
    description: "magic-nix-cache-action releases before v10 stopped working when GitHub retired the legacy cache API.",
    rationale:
      "Older magic-nix-cache releases target the retired GitHub.com cache API; v10 introduced the replacement service support. Exact failure behavior depends on service and action configuration, and GitHub Enterprise Server can have different compatibility. Other Nix caches may still supply outputs. Review a supported release or cache migration, its permissions and trust boundaries; a major upgrade is not an unattended behavior-preserving fix.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://determinate.systems/blog/bringing-back-magic-nix-cache-action/",
      "https://determinate.systems/blog/magic-nix-cache-free-tier-eol/",
      "https://github.com/DeterminateSystems/magic-nix-cache-action",
      "https://github.blog/changelog/2024-09-16-notice-of-upcoming-deprecations-and-changes-in-github-actions-services/",
    ],
    impact: "high",
    fixable: false,
    example: {
      bad: "- uses: DeterminateSystems/magic-nix-cache-action@v8",
      good: `- uses: DeterminateSystems/magic-nix-cache-action@${CURRENT_MAJOR}`,
    },
  },
  check({ project, report }) {
    for (const { workflow, step } of steps([...project.workflows, ...project.actions])) {
      if (!usesAction(step, ACTION) || !step.uses) continue;
      const file = project.files.get(workflow.path);
      const version = actionVersion(step, file);
      if (!version || version.major >= FIRST_WORKING_MAJOR) continue;
      const ref = step.uses.action.ref ?? "";
      const pinned = version.source === "comment" ? `a SHA commented as ${version.text}` : `\`${ref}\``;
      report({
        path: workflow.path,
        line: stepLine(step),
        key: `${step.key}.uses`,
        message: `magic-nix-cache-action is pinned to ${pinned}, a pre-v10 release associated with the legacy cache API. On GitHub.com that API is retired; check the actual host, action release and cache logs before upgrading.`,
        suggestion: `Use \`DeterminateSystems/magic-nix-cache-action@${CURRENT_MAJOR}\` (or a SHA of a v10+ release), or switch to FlakeHub Cache:\n- uses: DeterminateSystems/flakehub-cache-action@v3\n(requires \`permissions: { id-token: write, contents: read }\`).`,
      });
    }
  },
});
