import { rules } from "./rules/index.js";
import type { Finding, OptimizerConfig, RepositoryFile, Severity } from "./types.js";
import { matchesGlob } from "./utils.js";

const severityRank: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

export function analyze(files: RepositoryFile[], config: OptimizerConfig): Finding[] {
  if (!config.enabled) return [];

  const includedFiles = files.filter(
    (file) => !config.ignoredPaths.some((pattern) => matchesGlob(file.path, pattern)),
  );
  const context = {
    files: includedFiles,
    fileMap: new Map(includedFiles.map((file) => [file.path, file])),
  };

  return rules
    .filter((rule) => !config.disabledRules.includes(rule.id))
    .flatMap((rule) => rule.evaluate(context))
    .sort(
      (left, right) =>
        severityRank[right.severity] - severityRank[left.severity] ||
        left.ruleId.localeCompare(right.ruleId),
    );
}

export function shouldFail(findings: Finding[], threshold: OptimizerConfig["failOnSeverity"]): boolean {
  if (threshold === "never") return false;
  return findings.some((finding) => severityRank[finding.severity] >= severityRank[threshold]);
}
