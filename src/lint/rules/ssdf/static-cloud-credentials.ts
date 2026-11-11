import { defineRule, steps } from "../helpers.js";

const STATIC_CREDENTIALS = new Map([
  ["aws-actions/configure-aws-credentials", ["aws-access-key-id", "aws-secret-access-key"]],
  ["azure/login", ["creds"]],
  ["google-github-actions/auth", ["credentials_json"]],
]);

export default defineRule({
  meta: {
    id: "ssdf/static-cloud-credentials",
    ruleset: "ssdf",
    description: "A cloud authentication action receives static credential inputs instead of using workload identity.",
    rationale: "SSDF PO.5.1 calls for separating and protecting development environments. Static long-lived cloud credentials increase exposure risk; workload identity federation can issue short-lived credentials scoped to a workflow identity.",
    kind: "policy",
    defaultSeverity: "warn",
    presets: ["ssdf"],
    requires: ["repository"],
    defaultOptions: {},
    references: ["https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect"],
    impact: "high",
    example: {
      bad: "steps:\n  - uses: aws-actions/configure-aws-credentials@<full-commit-sha>\n    with:\n      aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}",
      good: "permissions:\n  id-token: write\nsteps:\n  - uses: aws-actions/configure-aws-credentials@<full-commit-sha>\n    with:\n      role-to-assume: arn:aws:iam::123456789012:role/deploy",
    },
  },
  check({ project, report }) {
    for (const { workflow, job, step } of steps(project.workflows)) {
      const action = step.uses?.action?.name ?? "";
      const inputs = STATIC_CREDENTIALS.get(action);
      if (!inputs) continue;
      const present = inputs.filter((key) => step.with.has(key));
      if (present.length === 0) continue;
      report({
        path: workflow.path,
        line: step.uses?.line ?? step.line,
        key: `${workflow.path}:${job.id}:${action}:static-credentials`,
        message: `\`${action}\` receives static credential input${present.length === 1 ? "" : "s"} (${present.map((key) => `\`${key}\``).join(", ")}).`,
        suggestion: "Prefer the provider's GitHub Actions OIDC/workload-identity integration with narrowly scoped trust conditions.",
      });
    }
  },
});
