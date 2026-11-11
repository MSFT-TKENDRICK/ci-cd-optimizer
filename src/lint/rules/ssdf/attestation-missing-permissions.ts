import { defineRule, steps } from "../helpers.js";
import { effectivePermissions } from "../security/shared.js";

const ATTEST_ACTIONS = new Set(["actions/attest", "actions/attest-build-provenance", "actions/attest-sbom"]);

function hasWritePermission(value: unknown, scope: string): boolean {
  if (value === "write-all") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const permission = (value as Record<string, unknown>)[scope];
  return typeof permission === "string" && permission.trim() === "write";
}

export default defineRule({
  meta: {
    id: "ssdf/attestation-missing-permissions",
    ruleset: "ssdf",
    description: "A GitHub attestation action lacks the explicit token permissions it requires.",
    rationale: "GitHub artifact attestations require id-token: write and attestations: write. Explicitly declaring these job-level capabilities avoids relying on repository defaults and makes the action's authority reviewable.",
    kind: "policy",
    defaultSeverity: "error",
    presets: ["ssdf"],
    requires: ["repository"],
    defaultOptions: {},
    references: ["https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations"],
    impact: "high",
    example: {
      bad: "steps:\n  - uses: actions/attest-build-provenance@<full-commit-sha>",
      good: "permissions:\n  id-token: write\n  attestations: write\nsteps:\n  - uses: actions/attest-build-provenance@<full-commit-sha>",
    },
  },
  check({ project, report }) {
    for (const { workflow, job, step } of steps(project.workflows)) {
      if (!ATTEST_ACTIONS.has(step.uses?.action?.name ?? "")) continue;
      const permissions = effectivePermissions(workflow, job)?.value;
      const missing = ["id-token", "attestations"].filter((scope) => !hasWritePermission(permissions, scope));
      if (missing.length === 0) continue;
      report({
        path: workflow.path,
        line: step.uses?.line ?? step.line,
        key: `${workflow.path}:${job.id}:attestation-permissions`,
        message: `Attestation step \`${step.uses?.action.name}\` in job \`${job.id}\` is missing explicit \`${missing.join(": write` and `")}: write\` permission${missing.length === 1 ? "" : "s"}.`,
        suggestion: "Grant only the required permissions at the job level: `id-token: write` and `attestations: write`.",
      });
    }
  },
});
