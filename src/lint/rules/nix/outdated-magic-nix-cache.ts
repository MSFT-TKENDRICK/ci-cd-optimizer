import { usesAction } from "../caching/shared.js";
import { actionVersion, defineRule, stepLine, steps } from "../helpers.js";

const ACTION = "determinatesystems/magic-nix-cache-action";
/** v11's upstream source explicitly restores support and supplies GITHUB_CONTEXT to the daemon. */
const FIRST_RESTORED_MAJOR = 11;
const CURRENT_MAJOR = "v15";

export default defineRule({
  meta: {
    id: "nix/outdated-magic-nix-cache",
    ruleset: "nix",
    description: "Review Magic Nix Cache action refs that predate v11's restored support.",
    rationale:
      "Upstream v11 explicitly restored support, removed the retirement warning and added GITHUB_CONTEXT to the downloaded daemon's environment. The action wrapper version alone does not determine the downloaded binary or prove an actual cache failure: source overrides, service configuration and GitHub Enterprise Server differ. Review runtime logs and supported versions before an upgrade or migration; neither is an unattended behavior-preserving fix.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://determinate.systems/blog/bringing-back-magic-nix-cache-action/",
      "https://determinate.systems/blog/magic-nix-cache-free-tier-eol/",
      "https://github.com/DeterminateSystems/magic-nix-cache-action",
      "https://github.com/DeterminateSystems/magic-nix-cache-action/releases/tag/v11",
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
      if ([...step.with.keys()].some((key) => key.startsWith("source-"))) continue;
      if (/^(?:false|disabled)$/i.test(String(step.with.get("use-gha-cache")?.value ?? ""))) continue;
      const file = project.files.get(workflow.path);
      const version = actionVersion(step, file);
      if (!version || version.major >= FIRST_RESTORED_MAJOR) continue;
      const ref = step.uses.action.ref ?? "";
      const pinned = version.source === "comment" ? `a SHA commented as ${version.text}` : `\`${ref}\``;
      report({
        path: workflow.path,
        line: stepLine(step),
        key: `${step.key}.uses`,
        message: `magic-nix-cache-action is pinned to ${pinned}, predating v11's restored support and daemon context changes. This does not establish a cache failure; check the host, downloaded binary and actual cache logs before upgrading.`,
        suggestion: `Review a supported release such as \`DeterminateSystems/magic-nix-cache-action@${CURRENT_MAJOR}\`, pin its reviewed commit and verify restore/save behavior. Preserve the intended backend, authentication and permissions; changing cache providers is a separate policy decision.`,
        confidence: "medium",
      });
    }
  },
});
