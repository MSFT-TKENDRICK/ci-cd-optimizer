import type { Finding } from "./types.js";

const icon = { high: "🔴", medium: "🟡", low: "🔵" } as const;

export function createSummary(findings: Finding[], truncated: boolean): string {
  if (findings.length === 0) {
    return [
      "## No CI/CD optimization findings",
      "",
      "The analyzed workflows and build files did not match any enabled optimization rule.",
      truncated ? "\n> The repository snapshot was truncated by GitHub or configured scan limits." : "",
    ].join("\n");
  }

  const counts = {
    high: findings.filter((finding) => finding.severity === "high").length,
    medium: findings.filter((finding) => finding.severity === "medium").length,
    low: findings.filter((finding) => finding.severity === "low").length,
  };
  const rows = findings.slice(0, 25).map(
    (finding) =>
      `| ${icon[finding.severity]} ${finding.severity} | ${escapeCell(finding.title)} | ${finding.effort} | ${escapeCell(finding.estimatedImpact)} |`,
  );

  return [
    `## ${findings.length} CI/CD optimization finding${findings.length === 1 ? "" : "s"}`,
    "",
    `**High:** ${counts.high} · **Medium:** ${counts.medium} · **Low:** ${counts.low}`,
    "",
    "| Priority | Finding | Effort | Expected impact |",
    "|---|---|---|---|",
    ...rows,
    findings.length > 25 ? `\n_Only the first 25 of ${findings.length} findings are shown._` : "",
    truncated ? "\n> The repository snapshot was truncated by GitHub or configured scan limits." : "",
    "",
    "Findings are advisory estimates. Validate changes against workload measurements before rollout.",
  ].join("\n");
}

export function createAnnotations(findings: Finding[]) {
  return findings.slice(0, 50).map((finding) => ({
    path: finding.evidence.path,
    start_line: finding.evidence.line ?? 1,
    end_line: finding.evidence.line ?? 1,
    annotation_level: finding.severity === "high" ? ("warning" as const) : ("notice" as const),
    title: finding.title.slice(0, 255),
    message: `${finding.explanation}\n\nRecommendation: ${finding.recommendation}`.slice(0, 65_535),
    raw_details: [
      `Rule: ${finding.ruleId}`,
      `Confidence: ${finding.confidence}`,
      `Estimated impact: ${finding.estimatedImpact}`,
      finding.documentationUrl ? `Documentation: ${finding.documentationUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  }));
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
