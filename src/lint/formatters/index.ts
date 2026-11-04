import type { AnyRule, Diagnostic, LintResult } from "../types.js";

export type FormatName = "stylish" | "json" | "sarif" | "markdown" | "github";
export const FORMATS: FormatName[] = ["stylish", "json", "sarif", "markdown", "github"];

const ICON: Record<Diagnostic["severity"], string> = { error: "error", warn: "warning", info: "info" };

export function stylish(result: LintResult): string {
  const lines: string[] = [];
  const byPath = new Map<string, Diagnostic[]>();
  for (const diagnostic of result.diagnostics) {
    byPath.set(diagnostic.path, [...(byPath.get(diagnostic.path) ?? []), diagnostic]);
  }
  for (const [path, diagnostics] of byPath) {
    lines.push(path);
    for (const diagnostic of diagnostics) {
      lines.push(
        `  ${`${diagnostic.line}:${diagnostic.column}`.padEnd(8)} ${ICON[diagnostic.severity].padEnd(8)} ${diagnostic.message}  ${diagnostic.ruleId}${diagnostic.fix ? " (fixable)" : ""}`,
      );
      if (diagnostic.suggestion) lines.push(`  ${"".padEnd(8)} ${"".padEnd(8)} -> ${diagnostic.suggestion}`);
    }
    lines.push("");
  }
  for (const problem of result.parseProblems) lines.push(`${problem.path}:${problem.line} parse error: ${problem.message}`);
  const count = (severity: Diagnostic["severity"]) => result.diagnostics.filter((d) => d.severity === severity).length;
  const fixable = result.diagnostics.filter((d) => d.fix).length;
  lines.push(
    `${result.diagnostics.length} problem(s) (${count("error")} error, ${count("warn")} warning, ${count("info")} info)` +
      `${fixable ? `, ${fixable} fixable with --fix` : ""}; ${result.rulesRun} rules over ${result.filesAnalyzed} files in ${result.durationMs}ms` +
      `${result.skipped.length ? `; ${result.skipped.length} rule(s) skipped` : ""}${result.suppressed ? `; ${result.suppressed} suppressed` : ""}`,
  );
  return lines.join("\n");
}

export function json(result: LintResult): string {
  return JSON.stringify(result, null, 2);
}

/** GitHub Actions workflow commands, rendered as annotations on the run and pull request. */
export function github(result: LintResult): string {
  const escape = (value: string) => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const property = (value: string) => escape(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
  return result.diagnostics
    .map((d) => {
      const level = d.severity === "error" ? "error" : d.severity === "warn" ? "warning" : "notice";
      const body = d.suggestion ? `${d.message} ${d.suggestion}` : d.message;
      return `::${level} file=${property(d.path)},line=${d.line},col=${d.column},title=${property(d.ruleId)}::${escape(body)}`;
    })
    .join("\n");
}

export function markdown(result: LintResult, options: { title?: string; limit?: number } = {}): string {
  const limit = options.limit ?? 50;
  const lines = [`## ${options.title ?? "CI/CD Optimizer"}`, ""];
  if (result.diagnostics.length === 0) {
    lines.push("No CI/CD optimization findings. :rocket:");
  } else {
    lines.push("| Severity | Rule | Location | Finding |", "| --- | --- | --- | --- |");
    for (const d of result.diagnostics.slice(0, limit)) {
      const finding = `${d.message}${d.suggestion ? `<br>**Fix:** ${d.suggestion}` : ""}`.replace(/\|/g, "\\|");
      lines.push(`| ${d.severity} | [\`${d.ruleId}\`](${d.docsUrl}) | \`${d.path}:${d.line}\` | ${finding} |`);
    }
    if (result.diagnostics.length > limit) lines.push("", `_${result.diagnostics.length - limit} more finding(s) omitted._`);
  }
  if (result.skipped.length > 0) {
    lines.push("", "<details><summary>Skipped rules</summary>", "");
    for (const skip of result.skipped) lines.push(`- \`${skip.ruleId}\`: ${skip.reason}`);
    lines.push("", "</details>");
  }
  return lines.join("\n");
}

/** SARIF 2.1.0 for GitHub code scanning (upload with github/codeql-action/upload-sarif or the REST API). */
export function sarif(result: LintResult, rules: AnyRule[], version = "0.0.0"): string {
  const used = rules.filter((rule) => result.diagnostics.some((d) => d.ruleId === rule.meta.id));
  const index = new Map(used.map((rule, position) => [rule.meta.id, position]));
  const level = { error: "error", warn: "warning", info: "note" } as const;
  const securitySeverity = { high: "7.0", medium: "4.0", low: "2.0" } as const;
  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "ci-cd-optimizer",
              informationUri: "https://github.com/MSFT-TKENDRICK/ci-cd-optimizer",
              semanticVersion: version,
              rules: used.map((rule) => ({
                id: rule.meta.id,
                name: rule.meta.id.replace(/[^a-z0-9]+(.)/gi, (_, c: string) => c.toUpperCase()),
                shortDescription: { text: rule.meta.description },
                fullDescription: { text: rule.meta.rationale },
                helpUri: result.diagnostics.find((d) => d.ruleId === rule.meta.id)?.docsUrl,
                help: { text: rule.meta.rationale, markdown: `${rule.meta.rationale}\n\n${rule.meta.references.map((ref) => `- ${ref}`).join("\n")}` },
                defaultConfiguration: { level: level[rule.meta.defaultSeverity] },
                properties: {
                  tags: ["ci-cd", "performance", rule.meta.ruleset, rule.meta.kind],
                  precision: "high",
                  "problem.severity": rule.meta.defaultSeverity === "warn" ? "warning" : rule.meta.defaultSeverity === "info" ? "recommendation" : "error",
                  "security-severity": securitySeverity[rule.meta.impact],
                },
              })),
            },
          },
          automationDetails: { id: "ci-cd-optimizer/" },
          results: result.diagnostics.map((d) => ({
            ruleId: d.ruleId,
            ruleIndex: index.get(d.ruleId),
            level: level[d.severity],
            message: { text: d.suggestion ? `${d.message} ${d.suggestion}` : d.message },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: d.path, uriBaseId: "%SRCROOT%" },
                  region: { startLine: d.line, startColumn: d.column },
                },
              },
            ],
            partialFingerprints: { "ciCdOptimizer/v1": d.fingerprint },
            properties: { impact: d.impact, confidence: d.confidence, ruleset: d.ruleset },
          })),
        },
      ],
    },
    null,
    2,
  );
}

export function format(name: FormatName, result: LintResult, rules: AnyRule[], version?: string): string {
  switch (name) {
    case "json":
      return json(result);
    case "sarif":
      return sarif(result, rules, version);
    case "markdown":
      return markdown(result);
    case "github":
      return github(result);
    default:
      return stylish(result);
  }
}
