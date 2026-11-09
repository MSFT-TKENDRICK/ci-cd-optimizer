import { defineRule } from "../helpers.js";
import { isPrivileged, jobHandlesUntrusted, jobPermissions, privilegedTriggers, workflowPermissions, writeScopes, type Permissions } from "./shared.js";

/** Write scopes that are dangerous on privileged triggers whatever the job does. */
const ALWAYS_SENSITIVE = ["contents"];
/** Write scopes that are routine on privileged triggers (labelling, commenting) unless the job also handles untrusted code or input. */
const SENSITIVE_WITH_UNTRUSTED = ["pull-requests", "issues"];

export default defineRule({
  meta: {
    id: "security/excessive-permissions",
    ruleset: "security",
    description:
      "Workflows should declare least-privilege `permissions:` for the `GITHUB_TOKEN`, and never grant `write-all` or write access to code and pull requests on untrusted triggers.",
    rationale:
      "Without a `permissions:` block the token gets the repository or organization default, which on older repositories is read/write to almost every scope. Any compromised dependency, action, or injected script inherits that access. Declaring the scopes each job needs limits the blast radius; on `pull_request_target`, `issue_comment`, and `workflow_run`, where outside contributors influence what runs, write access to contents lets an attacker push code, and write access to pull requests or issues in a job that also runs untrusted code or input lets them approve changes or spam the tracker.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions",
      "https://docs.github.com/en/actions/concepts/security/github_token",
      "https://docs.github.com/en/actions/reference/security/secure-use",
    ],
    impact: "high",
    example: {
      bad: "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make test",
      good: "on: push\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make test",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      if (workflow.kind !== "workflow" || workflow.triggers.length === 0) continue;
      if (workflow.triggers.every((trigger) => trigger.event === "workflow_call")) continue;
      const privileged = isPrivileged(workflow);
      const triggers = privilegedTriggers(workflow).join(", ");
      const top = workflowPermissions(workflow);

      const checkGrant = (permissions: Permissions, key: string, untrusted: boolean): void => {
        const scopes = writeScopes(permissions);
        const all = scopes.includes("*");
        const sensitive = all
          ? ["write-all"]
          : scopes.filter((scope) => ALWAYS_SENSITIVE.includes(scope) || (untrusted && SENSITIVE_WITH_UNTRUSTED.includes(scope)));
        if (privileged && sensitive.length > 0) {
          report({
            path: workflow.path,
            line: permissions.line,
            key,
            impact: "high",
            message: `${sensitive.map((scope) => (scope === "write-all" ? "`write-all`" : `\`${scope}: write\``)).join(" and ")} granted in a workflow triggered by ${triggers}, where untrusted input can drive what the token does.`,
            suggestion:
              "Grant only read access here and move any write operation to a separate job or workflow that does not process untrusted input.",
          });
        } else if (all) {
          report({
            path: workflow.path,
            line: permissions.line,
            key,
            impact: "medium",
            message: "`permissions: write-all` grants the token write access to every scope.",
            suggestion: "List only the scopes this workflow needs, e.g. `permissions: { contents: read }`.",
          });
        }
      };

      if (top) checkGrant(top, "permissions", privileged && workflow.jobs.some((job) => !jobPermissions(workflow, job) && jobHandlesUntrusted(workflow, job)));
      for (const job of workflow.jobs) {
        const own = jobPermissions(workflow, job);
        if (own) {
          checkGrant(own, `${job.key}.permissions`, privileged && jobHandlesUntrusted(workflow, job));
        } else if (!top) {
          report({
            path: workflow.path,
            line: job.line,
            key: `${job.key}.permissions`,
            impact: "medium",
            message: `Job \`${job.id}\` has no \`permissions:\` and the workflow sets none, so the token gets the repository default permissions.`,
            suggestion:
              "Add a top-level `permissions: { contents: read }` (or `{}`) and grant extra scopes only on the jobs that need them.",
          });
        }
      }
    }
  },
});
