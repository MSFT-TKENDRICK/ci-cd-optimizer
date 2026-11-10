import { isAbsolute, posix, relative } from "node:path";
import { didYouMean, resolveRules, type LintConfig } from "./config.js";
import { docsUrl } from "./engine.js";
import { isLockfile, truncateContent, type LoadedInput } from "./inventory.js";
import type { AnyRule, Preset, Severity, SourceFile } from "./types.js";
import { matchesGlob } from "../utils.js";

/**
 * Helpers shared by the `lint` command and the agent integrations (MCP server, ACP agent). They throw
 * `LintInputError` for bad input; callers translate it into their own error type (a CLI usage error, an MCP tool
 * error, an ACP message).
 */
export class LintInputError extends Error {
  override name = "LintInputError";
}

export const SEVERITIES: readonly Severity[] = ["off", "info", "warn", "error"];

/** Normalizes a path argument to a root-relative POSIX selector; "" selects everything. */
export function toSelector(root: string, value: string, label: string, hint = "; pass --root <dir>"): string {
  const raw = isAbsolute(value) ? relative(root, value) : value;
  const path = posix.normalize(raw.replace(/\\/g, "/")).replace(/\/+$/, "");
  if (path === "." || path === "") return "";
  if (path === ".." || path.startsWith("../") || posix.isAbsolute(path) || isAbsolute(path)) {
    throw new LintInputError(`${label} "${value}" is outside the lint root ${root}${hint}.`);
  }
  return path;
}

export const isGlob = (selector: string) => /[*?]/.test(selector);

export function selects(selector: string, path: string): boolean {
  if (selector === "") return true;
  if (isGlob(selector)) return matchesGlob(path, selector) || matchesGlob(path, `${selector}/**`);
  return path === selector || path.startsWith(`${selector}/`);
}

/** Adds or replaces one file (stdin or editor content), applying the same size limits as the on-disk inventory. */
export function withFile(input: LoadedInput, file: SourceFile, limits: LintConfig["limits"], label = "--stdin content"): LoadedInput {
  const oversized = Buffer.byteLength(file.content, "utf8") > limits.maxFileBytes;
  if (oversized && !isLockfile(file.path)) throw new LintInputError(`${label} exceeds limits.maxFileBytes (${limits.maxFileBytes} bytes).`);
  const replacement = oversized ? { path: file.path, content: truncateContent(file.content) } : file;
  const files = [...input.files.filter((existing) => existing.path !== file.path), replacement].sort((left, right) => left.path.localeCompare(right.path));
  const truncated = input.truncated.filter((path) => path !== file.path);
  return { ...input, files, truncated: oversized ? [...truncated, file.path] : truncated };
}

/** Every rule's effective severity: "off" unless a preset, ruleset, or rule setting enables it. */
export function effectiveSeverities(config: LintConfig, rules: readonly AnyRule[], presets: Preset[] | undefined): Map<string, Severity> {
  const severities = new Map<string, Severity>(rules.map((rule) => [rule.meta.id, "off"]));
  for (const { rule, severity } of resolveRules(config, [...rules], presets)) severities.set(rule.meta.id, severity);
  return severities;
}

export function unknownRuleMessage(label: string, id: string, rules: readonly AnyRule[]): string {
  return `${label}: unknown rule "${id}".${didYouMean(id, rules.map((candidate) => candidate.meta.id))}`;
}

/** Plain-text explanation of a rule, or undefined when the id is unknown. */
export function explainRuleText(id: string, rules: readonly AnyRule[], severities: ReadonlyMap<string, Severity>): string | undefined {
  const rule = rules.find((candidate) => candidate.meta.id === id);
  if (!rule) return undefined;
  const { meta } = rule;
  const indent = (text: string) => text.replace(/\n$/, "").split("\n").map((line) => `    ${line}`).join("\n");
  const lines = [
    meta.id,
    "",
    `  Ruleset:   ${meta.ruleset}`,
    `  Kind:      ${meta.kind}`,
    `  Severity:  ${severities.get(meta.id) ?? "off"} (default: ${meta.defaultSeverity})`,
    `  Presets:   ${meta.presets.length > 0 ? meta.presets.join(", ") : "(none)"}`,
    `  Fixable:   ${meta.fixable ? "yes" : "no"}`,
    `  Impact:    ${meta.impact}`,
    ...(meta.requires.length > 0 ? [`  Requires:  ${meta.requires.join(", ")}`] : []),
    "",
    meta.description,
  ];
  if (meta.rationale) lines.push("", meta.rationale);
  if (meta.example) lines.push("", "  Before:", indent(meta.example.bad), "", "  After:", indent(meta.example.good));
  if (meta.references.length > 0) lines.push("", "References:", ...meta.references.map((reference) => `  ${reference}`));
  lines.push("", `Docs: ${meta.docsUrl ?? docsUrl(meta.id)}`);
  return lines.join("\n");
}
