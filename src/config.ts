import { load } from "js-yaml";
import type { OptimizerConfig, RepositoryFile } from "./types.js";

export const defaultConfig: OptimizerConfig = {
  enabled: true,
  failOnSeverity: "never",
  disabledRules: [],
  ignoredPaths: ["vendor/**", "node_modules/**", "dist/**", "build/**"],
  maxFiles: 500,
  maxFileBytes: 256_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : fallback;
}

export function parseConfig(file?: RepositoryFile): OptimizerConfig {
  if (!file) return defaultConfig;

  const parsed: unknown = load(file.content);
  if (!isRecord(parsed)) return defaultConfig;

  const failOnSeverity = parsed.failOnSeverity;
  const validFailureThreshold =
    failOnSeverity === "low" ||
    failOnSeverity === "medium" ||
    failOnSeverity === "high" ||
    failOnSeverity === "never";

  return {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaultConfig.enabled,
    failOnSeverity: validFailureThreshold ? failOnSeverity : defaultConfig.failOnSeverity,
    disabledRules: stringArray(parsed.disabledRules, defaultConfig.disabledRules),
    ignoredPaths: stringArray(parsed.ignoredPaths, defaultConfig.ignoredPaths),
    maxFiles:
      typeof parsed.maxFiles === "number" && parsed.maxFiles > 0
        ? Math.floor(parsed.maxFiles)
        : defaultConfig.maxFiles,
    maxFileBytes:
      typeof parsed.maxFileBytes === "number" && parsed.maxFileBytes > 0
        ? Math.floor(parsed.maxFileBytes)
        : defaultConfig.maxFileBytes,
  };
}
