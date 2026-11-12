import { ACTIONS_LOCK_PATH, normalizeActionRef, parseActionsLock } from "../../parsers/actions-lock.js";
import { hasTrigger, type WorkflowModel } from "../../parsers/workflow.js";
import { runCommands, defineRule } from "../helpers.js";

const VERIFY_SUGGESTION =
  "Run `gh actions-lock --verify` in a pull-request or push workflow; `--verify-local` checks coverage only, not provenance.";
const UPDATE_SUGGESTION =
  "Run `gh actions-lock` from the repository root to update the generated lockfile, then review and commit it. Do not edit the file by hand.";

function remoteActionSteps(workflow: WorkflowModel) {
  return workflow.jobs.flatMap((job) =>
    job.steps.flatMap((step) => {
      const uses = step.uses;
      return uses?.kind === "literal" && uses.action.kind === "remote"
        ? [{ step, ref: uses.value, shaPinned: uses.action.shaPinned }]
        : [];
    }),
  );
}

function hasNetworkedVerification(workflows: WorkflowModel[]): boolean {
  for (const { workflow, command } of runCommands(workflows)) {
    if (!hasTrigger(workflow, "pull_request", "pull_request_target", "merge_group", "push")) continue;
    const normalized = command.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "");
    if (/^gh\s+actions-lock\s+--verify(?:\s|$)/i.test(normalized)) return true;
  }
  return false;
}

export default defineRule({
  meta: {
    id: "hermeticity/actions-lock",
    ruleset: "hermeticity",
    description: "Use a verified workflow dependency lockfile as an alternative to SHA-pinning mutable action refs.",
    rationale:
      "GitHub's generated actions.lock records commits for direct and transitive action dependencies and can replace mutable refs; full SHA pins remain a valid alternative. This rule checks direct workflow action refs against declared entries, not transitive closure, commit provenance, or runtime enforcement. Use the networked `gh actions-lock --verify` check and review lockfile diffs. The lockfile does not cover remote reusable workflows or container images.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles",
      "https://docs.github.com/en/actions/how-tos/secure-your-work/lock-workflow-dependencies",
      "https://github.com/github/gh-actions-lock",
    ],
    impact: "low",
    example: {
      bad: "on: pull_request\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@v7",
      good: "Run `gh actions-lock` to generate `.github/workflows/actions.lock`, then run `gh actions-lock --verify` in CI.",
    },
  },
  check({ project, input, isPathIgnored, report }) {
    const completeInventory = input.mode === "repository" && input.inventoryComplete;
    const lockFile = project.files.get(ACTIONS_LOCK_PATH);

    for (const { workflow, command, line } of runCommands(project.workflows)) {
      if (/\bgh\s+actions-lock\b/i.test(command) && /(?:^|\s)--accept-moved(?:\s|$)/i.test(command)) {
        report({
          path: workflow.path,
          line,
          key: "actions-lock.accept-moved",
          message: "`gh actions-lock --accept-moved` can accept a moved or downgraded pin; do not use it in automation.",
          suggestion: "Investigate the upstream ref movement and review the lockfile diff before updating it with the normal `gh actions-lock` command.",
        });
      }
    }

    if (!lockFile) {
      if (!completeInventory || isPathIgnored?.(ACTIONS_LOCK_PATH)) return;
      for (const workflow of project.workflows) {
        for (const { step, ref, shaPinned } of remoteActionSteps(workflow)) {
          if (shaPinned) continue;
          report({
            path: workflow.path,
            line: step.uses?.line ?? step.line,
            key: `${step.key}.actions-lock`,
            message: `Action \`${ref}\` is not covered by GitHub's workflow dependency lockfile.`,
            suggestion: `${UPDATE_SUGGESTION} ${VERIFY_SUGGESTION}`,
          });
        }
      }
      return;
    }

    const lock = parseActionsLock(lockFile);
    for (const [index, issue] of lock.issues.entries()) {
      report({
        path: ACTIONS_LOCK_PATH,
        line: issue.line,
        key: `actions-lock.schema.${index}`,
        message: issue.message,
        suggestion: UPDATE_SUGGESTION,
      });
    }
    if (lock.issues.length > 0) return;

    for (const workflow of project.workflows) {
      const actions = remoteActionSteps(workflow);
      if (actions.length === 0) continue;
      const lockedWorkflow = lock.workflows.get(workflow.path);
      for (const { step, ref, shaPinned } of actions) {
        if (shaPinned) continue;
        const line = step.uses?.line ?? step.line;
        if (!lockedWorkflow) {
          report({
            path: workflow.path,
            line,
            key: `${step.key}.actions-lock`,
            message: `Workflow \`${workflow.path}\` is not onboarded in \`${ACTIONS_LOCK_PATH}\`; action \`${ref}\` is not locked.`,
            suggestion: UPDATE_SUGGESTION,
          });
        } else if (!lockedWorkflow.dependencies.has(normalizeActionRef(ref))) {
          report({
            path: workflow.path,
            line,
            key: `${step.key}.actions-lock`,
            message: `Action \`${ref}\` is missing from this workflow's lockfile entry.`,
            suggestion: UPDATE_SUGGESTION,
          });
        } else if (!lock.dependencies.has(normalizeActionRef(ref))) {
          report({
            path: ACTIONS_LOCK_PATH,
            line: lockedWorkflow.line,
            key: `${step.key}.actions-lock-metadata`,
            message: `Action \`${ref}\` has no valid dependency metadata in the lockfile.`,
            suggestion: UPDATE_SUGGESTION,
          });
        }
      }
    }

    if (completeInventory) {
      for (const [path, entry] of lock.workflows) {
        if (!project.files.has(path) && !isPathIgnored?.(path)) {
          report({
            path: ACTIONS_LOCK_PATH,
            line: entry.line,
            key: `actions-lock.stale.${path}`,
            message: `Lockfile entry refers to missing workflow \`${path}\`.`,
            suggestion: "Run `gh actions-lock` without workflow path arguments so deleted workflow entries are pruned.",
          });
        }
      }

      if (lock.workflows.size > 0 && !hasNetworkedVerification(project.workflows)) {
        report({
          path: ACTIONS_LOCK_PATH,
          line: 1,
          key: "actions-lock.verify",
          message: "No pull-request or push workflow was found declaring the networked `gh actions-lock --verify` check.",
          suggestion: VERIFY_SUGGESTION,
        });
      }
    }
  },
});
