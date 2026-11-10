import { usesAction } from "../caching/shared.js";
import { defineRule, stepLine, steps } from "../helpers.js";

const ACTION = "determinatesystems/nix-installer-action";
/** A Determinate Nix release tag of determinate-nix-action; every `vX.Y.Z` tag installs exactly that release. */
const DETERMINATE_PINNED = "v3.24.2";
/** Inputs that select a specific nix-installer (and therefore Nix) build instead of the latest release. */
const VERSION_INPUTS = [
  "source-tag",
  "source-revision",
  "source-url",
  "source-branch",
  "source-pr",
  "source-binary",
  "nix-package-url",
  "local-root",
  "nix-installer-tag",
  "nix-installer-revision",
  "nix-installer-url",
  "nix-installer-branch",
  "nix-installer-pr",
];

const SHA = /^[0-9a-f]{40}$/i;
const TAG = /^v?\d+(?:\.\d+){0,2}$/;

export default defineRule({
  meta: {
    id: "nix/installer-unpinned-nix-version",
    ruleset: "nix",
    description: "A pinned nix-installer-action still installs whatever Nix version is newest at run time.",
    rationale:
      "DeterminateSystems/nix-installer-action downloads the most recent Determinate Nix Installer on every run, even when the action itself is pinned to a tag or commit, so the Nix version (evaluator, store schema, default settings, built-in fetchers) changes underneath a workflow whose author pinned the action for reproducibility. A Nix upgrade can change evaluation results, error on deprecated syntax, or alter `flake.lock` handling without any change in the repository. determinate-nix-action is tagged for every Determinate Nix release, so `@vX.Y.Z` installs exactly that release and Dependabot can propose upgrades as reviewable pull requests; alternatively `source-tag` pins the installer binary used by nix-installer-action.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict", "insights"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/DeterminateSystems/nix-installer-action#pinning-the-version",
      "https://github.com/DeterminateSystems/determinate-nix-action#-version-pinning-lock-it-down",
      "https://github.com/DeterminateSystems/nix-installer-action/blob/main/action.yml",
    ],
    impact: "low",
    example: {
      bad: "- uses: DeterminateSystems/nix-installer-action@v23",
      good: `- uses: DeterminateSystems/determinate-nix-action@${DETERMINATE_PINNED}`,
    },
  },
  check({ project, report }) {
    for (const { workflow, step } of steps([...project.workflows, ...project.actions])) {
      if (!usesAction(step, ACTION) || !step.uses) continue;
      const ref = step.uses.action.ref ?? "";
      const sha = SHA.test(ref);
      if (!sha && !TAG.test(ref)) continue;
      if (VERSION_INPUTS.some((input) => step.with.has(input))) continue;
      const upstream = /^false$/i.test(String(step.with.get("determinate")?.value ?? "").trim());
      const precise = sha || /^v?\d+\.\d+/.test(ref);
      report({
        path: workflow.path,
        line: stepLine(step),
        key: `${step.key}.nix-version`,
        message: `\`DeterminateSystems/nix-installer-action@${sha ? `${ref.slice(0, 12)}…` : ref}\` is pinned, but the action downloads the most recent Nix installer on every run, so the installed Nix version is not pinned.`,
        suggestion: upstream
          ? "Pin the installer release, which fixes the Nix version it installs:\n- uses: DeterminateSystems/nix-installer-action@<pin>\n  with:\n    determinate: false\n    source-tag: v<nix-installer release>"
          : `Use the action that is tagged per Determinate Nix release and installs exactly that version:\n- uses: DeterminateSystems/determinate-nix-action@${DETERMINATE_PINNED}\n(or keep nix-installer-action and add \`source-tag: v<nix-installer release>\`). Let Dependabot bump the tag.`,
        confidence: precise ? "high" : "medium",
      });
    }
  },
});
