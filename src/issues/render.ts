import type { IssuesConfig } from "../lint/config.js";
import { atLeast } from "../lint/engine.js";
import type { AnyRule, Diagnostic, Impact } from "../lint/types.js";
import { marker, signatureOf } from "./markers.js";
import type { DesiredIssue } from "./plan.js";

const IMPACT_RANK: Record<Impact, number> = { low: 1, medium: 2, high: 3 };
const SEVERITY_RANK = { info: 1, warn: 2, error: 3 } as const;

export interface IssueContext {
  owner: string;
  repo: string;
  /** Commit the findings were computed on (used for permalinks). */
  sha: string;
  rules: readonly AnyRule[];
}

/** Whether a diagnostic should become (part of) an issue under the configured triage policy. */
export function qualifies(diagnostic: Diagnostic, config: IssuesConfig): boolean {
  const override = config.rules[diagnostic.ruleId];
  if (override !== undefined) return override;
  return atLeast(diagnostic.severity, config.minSeverity) && IMPACT_RANK[diagnostic.impact] >= IMPACT_RANK[config.minImpact];
}

function permalink(context: IssueContext, diagnostic: Diagnostic): string {
  return `https://github.com/${context.owner}/${context.repo}/blob/${context.sha}/${diagnostic.path}#L${diagnostic.line}`;
}

function labelsFor(diagnostics: readonly Diagnostic[], config: IssuesConfig): string[] {
  const first = diagnostics[0] as Diagnostic;
  const severity = diagnostics.reduce((max, d) => (SEVERITY_RANK[d.severity] > SEVERITY_RANK[max] ? d.severity : max), first.severity);
  const impact = diagnostics.reduce((max, d) => (IMPACT_RANK[d.impact] > IMPACT_RANK[max] ? d.impact : max), first.impact);
  return [...new Set(["cicd-optimizer", `ruleset:${first.ruleset}`, `severity:${severity}`, `impact:${impact}`, ...config.labels])];
}

function priority(diagnostics: readonly Diagnostic[]): number {
  return Math.max(...diagnostics.map((d) => SEVERITY_RANK[d.severity] * 10 + IMPACT_RANK[d.impact])) * 1000 + diagnostics.length;
}

function agentInstructions(ruleId: string, rule: AnyRule | undefined): string[] {
  return [
    "### Instructions for coding agents",
    "",
    "This issue is written to be picked up by a background coding agent (for example the Copilot coding agent).",
    "",
    "1. Fix every unchecked finding above with the smallest behavior-preserving change; follow **Suggested fix**.",
    `2. Verify: the **CI/CD Optimizer** check on your pull request reports no \`${ruleId}\` findings (or run \`ci-cd-optimizer lint --rule ${ruleId}\` locally), and the repository's existing CI passes.`,
    "3. Do not add top-level `on.pull_request.paths` filters to workflows that provide required checks, never enable `cancel-in-progress` on deploy/release workflows, and do not weaken security settings (permissions, pinning).",
    "4. Describe measured or expected CI time savings in the pull request description.",
    ...(rule?.meta.fixable ? ["", `_Some findings have deterministic autofixes: \`ci-cd-optimizer lint --fix --rule ${ruleId}\`._`] : []),
  ];
}

function renderRuleIssue(ruleId: string, diagnostics: readonly Diagnostic[], context: IssueContext): { title: string; body: string } {
  const rule = context.rules.find((candidate) => candidate.meta.id === ruleId);
  const first = diagnostics[0] as Diagnostic;
  const title = `CI/CD: ${rule?.meta.description.replace(/\.$/, "") ?? ruleId} (${diagnostics.length} finding${diagnostics.length === 1 ? "" : "s"})`;
  const lines = [
    `## \`${ruleId}\``,
    "",
    `**Severity:** ${first.severity} · **Impact:** ${first.impact} · **Ruleset:** \`${first.ruleset}\` · **Kind:** ${first.kind}`,
    "",
    "### Why this matters",
    "",
    rule?.meta.rationale ?? first.message,
    "",
    "### Findings",
    "",
  ];
  for (const diagnostic of diagnostics.slice(0, 50)) {
    lines.push(`- [ ] [\`${diagnostic.path}:${diagnostic.line}\`](${permalink(context, diagnostic)}): ${diagnostic.message}`);
    if (diagnostic.suggestion) lines.push(`  - **Suggested fix:** ${diagnostic.suggestion}`);
  }
  if (diagnostics.length > 50) lines.push(`- _…and ${diagnostics.length - 50} more._`);
  if (rule?.meta.example) {
    lines.push("", "### Example", "", "Before:", "", "```yaml", rule.meta.example.bad, "```", "", "After:", "", "```yaml", rule.meta.example.good, "```");
  }
  lines.push("", ...agentInstructions(ruleId, rule), "", `[Rule documentation](${first.docsUrl})`);
  if (rule && rule.meta.references.length > 0) lines.push("", ...rule.meta.references.map((reference) => `- <${reference}>`));
  lines.push(
    "",
    "<sub>Opened by CI/CD Optimizer. It updates this issue as findings change and closes it when they are resolved. Close it as **not planned** to dismiss this rule's findings.</sub>",
  );
  return { title, body: lines.join("\n") };
}

/** Converts lint diagnostics into desired issues according to `issues` config (grouped per rule by default). */
export function desiredIssues(diagnostics: readonly Diagnostic[], config: IssuesConfig, context: IssueContext): DesiredIssue[] {
  const selected = diagnostics.filter((diagnostic) => qualifies(diagnostic, config));
  const groups = new Map<string, Diagnostic[]>();
  for (const diagnostic of selected) {
    const key = config.groupBy === "rule" ? `rule:${diagnostic.ruleId}` : `finding:${diagnostic.fingerprint}`;
    groups.set(key, [...(groups.get(key) ?? []), diagnostic]);
  }
  return [...groups.entries()].map(([fingerprint, group]) => {
    const ruleId = (group[0] as Diagnostic).ruleId;
    const signature = signatureOf(group.map((d) => `${d.fingerprint}|${d.severity}|${d.message}|${d.suggestion ?? ""}`).sort());
    const rendered = renderRuleIssue(ruleId, group, context);
    return {
      fingerprint,
      signature,
      title: rendered.title,
      body: `${marker("finding", fingerprint, { signature, rule: ruleId })}\n${rendered.body}`,
      labels: labelsFor(group, config),
      assignees: config.assignees,
      assignCopilot: config.assignCopilot,
      priority: priority(group),
    };
  });
}
