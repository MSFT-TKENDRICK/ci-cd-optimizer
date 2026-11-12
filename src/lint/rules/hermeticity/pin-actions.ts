import { parseActionRef } from "../../parsers/workflow.js";
import { ACTIONS_LOCK_PATH, isActionLockCovered, parseActionsLock } from "../../parsers/actions-lock.js";
import { defineRule } from "../helpers.js";

const SUGGESTION =
  "Pin to the full 40-character commit SHA with a version comment, e.g. `uses: owner/repo@<sha> # v1.2.3`, or cover the action in `.github/workflows/actions.lock` and run `gh actions-lock --verify` in CI.";

function describeRef(ref: string | undefined): string {
  if (ref === undefined) return "has no ref";
  if (/^[0-9a-f]{7,39}$/i.test(ref)) return `uses a short SHA (\`${ref}\`) that can collide`;
  return `uses the mutable ref \`${ref}\``;
}

export default defineRule({
  meta: {
    id: "hermeticity/pin-actions",
    ruleset: "hermeticity",
    description: "Third-party actions and reusable workflows should use immutable references or a workflow dependency lockfile.",
    rationale:
      "Tags and branches can be moved, so `@v4` may run different code tomorrow than today. Use a full-length commit SHA, or cover direct and transitive action dependencies in GitHub's workflow dependency lockfile. The lockfile does not cover reusable workflow calls or container images, and static analysis cannot verify provenance or reachability.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["strict"],
    requires: [],
    defaultOptions: { ignoreOwners: [] as string[] },
    validateOptions: (options) =>
      "ignoreOwners" in options && (!Array.isArray(options.ignoreOwners) || !options.ignoreOwners.every((owner) => typeof owner === "string"))
        ? ["ignoreOwners must be an array of strings"]
        : [],
    references: [
      "https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions",
      "https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles",
      "https://github.com/github/gh-actions-lock",
      "https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies",
      "https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot",
    ],
    impact: "low",
    example: {
      bad: "- uses: actions/checkout@v6",
      good: "- uses: actions/checkout@<40-character commit sha> # v6.0.0",
    },
  },
  check({ project, options, report }) {
    const lockFile = project.files.get(ACTIONS_LOCK_PATH);
    const actionsLock = lockFile ? parseActionsLock(lockFile) : undefined;
    const ignored = new Set(options.ignoreOwners.map((owner) => owner.toLowerCase()));
    const skip = (owner: string | undefined) => owner !== undefined && ignored.has(owner);
    for (const workflow of [...project.workflows, ...project.actions]) {
      for (const job of workflow.jobs) {
        if (job.uses && job.uses.kind === "literal") {
          const ref = parseActionRef(job.uses.value);
          if (ref.kind === "remote" && !ref.shaPinned && !skip(ref.owner)) {
            report({
              path: workflow.path,
              line: job.uses.line,
              key: `${job.key}.uses`,
              message: `Reusable workflow \`${ref.raw}\` ${describeRef(ref.ref)} instead of a full commit SHA.`,
              suggestion: SUGGESTION,
            });
          }
        }
        for (const step of job.steps) {
          const uses = step.uses;
          if (!uses || uses.kind !== "literal") continue;
          const action = uses.action;
          if (action.kind === "docker" && !action.shaPinned) {
            report({
              path: workflow.path,
              line: uses.line,
              key: `${step.key}.uses`,
              message: `Docker action image \`${action.raw}\` is not pinned to an \`@sha256:\` digest.`,
              suggestion: "Pin the image by digest, e.g. `docker://alpine:3.22@sha256:<digest>`.",
            });
          } else if (
            action.kind === "remote" &&
            !action.shaPinned &&
            !isActionLockCovered(actionsLock, workflow.path, action.raw) &&
            !skip(action.owner)
          ) {
            report({
              path: workflow.path,
              line: uses.line,
              key: `${step.key}.uses`,
              message: `Action \`${action.raw}\` ${describeRef(action.ref)} instead of a full commit SHA.`,
              suggestion: SUGGESTION,
            });
          }
        }
      }
    }
  },
});
