import { fix, replaceOnLine } from "../../fix.js";
import { usesAction } from "../caching/shared.js";
import { actionVersion, defineRule, stepLine, steps } from "../helpers.js";

const ACTION = "determinatesystems/magic-nix-cache-action";
/** First major released after the 2025-02-01 GitHub cache API shutdown broke older releases. */
const FIRST_WORKING_MAJOR = 10;
const CURRENT_MAJOR = "v15";

export default defineRule({
  meta: {
    id: "nix/outdated-magic-nix-cache",
    ruleset: "nix",
    description: "magic-nix-cache-action releases before v10 stopped working when GitHub retired the legacy cache API.",
    rationale:
      "magic-nix-cache runs a local binary-cache daemon that Nix uses as a substituter and that stores NARs in the GitHub Actions cache. Releases before v10 talk to the legacy Actions cache service, which GitHub shut down on 2025-02-01, so on those versions the cache silently stops restoring and saving: every run builds or downloads its whole closure from scratch while the step still succeeds. v10 (2025-06-10) moved to the new cache service. Determinate Systems now recommends FlakeHub Cache (`flakehub-cache-action`) for authenticated, cross-repository caching.",
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
    fixable: true,
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
      const plainTag = version.source === "ref" && /^v\d+$/.test(ref);
      const repair =
        plainTag && file
          ? fix(
              `Update magic-nix-cache-action to ${CURRENT_MAJOR}`,
              replaceOnLine(file, step.uses.line, new RegExp(`(?<=magic-nix-cache-action@)${ref}\\b`, "i"), CURRENT_MAJOR),
            )
          : undefined;
      const pinned = version.source === "comment" ? `a SHA commented as ${version.text}` : `\`${ref}\``;
      report({
        path: workflow.path,
        line: stepLine(step),
        key: `${step.key}.uses`,
        message: `magic-nix-cache-action is pinned to ${pinned}, a release from before v10 that uses GitHub's retired cache API, so it no longer restores or saves anything.`,
        suggestion: `Use \`DeterminateSystems/magic-nix-cache-action@${CURRENT_MAJOR}\` (or a SHA of a v10+ release), or switch to FlakeHub Cache:\n- uses: DeterminateSystems/flakehub-cache-action@v3\n(requires \`permissions: { id-token: write, contents: read }\`).`,
        ...(repair ? { fix: repair } : {}),
      });
    }
  },
});
