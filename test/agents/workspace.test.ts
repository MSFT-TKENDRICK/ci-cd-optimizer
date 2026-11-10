import { readFile, stat, symlink } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allRules } from "../../src/lint/rules/index.js";
import {
  AgentError,
  clampLimit,
  confine,
  effectiveConfig,
  explainRule,
  fixPreview,
  lintWorkspace,
  listRules,
  loadConfig,
  MAX_CONTENT_FILES,
  MAX_LIMIT,
  resolveRoot,
  validateReviewProject,
} from "../../src/agents/workspace.js";
import { PROJECT_YAML } from "../review/fixtures.js";
import { forbiddenLocalRule, MISSING_TIMEOUT, tempDirs, WORKFLOW, write } from "./helpers.js";
import { LIMITS } from "../../src/agents/safety.js";
import { readBoundedFile } from "../../src/agents/inventory.js";

vi.mock("node:fs/promises", { spy: true });

const dirs = tempDirs();
let root: string;

beforeEach(async () => {
  root = await dirs.make();
});
afterEach(() => dirs.cleanup());

describe("lintWorkspace", () => {
  it("reports findings with slim, sorted diagnostics and complete counts", async () => {
    await write(root, WORKFLOW, MISSING_TIMEOUT);
    const summary = await lintWorkspace({ root });
    expect(summary.root).toBe(root);
    expect(summary.configPath).toBeNull();
    expect(summary.localRulesIgnored).toBe(false);
    expect(summary.inventoryComplete).toBe(true);
    expect(summary.filesAnalyzed).toBeGreaterThan(0);
    const timeout = summary.diagnostics.find((diagnostic) => diagnostic.ruleId === "workflow/job-timeout");
    expect(timeout).toMatchObject({ path: WORKFLOW, severity: "warn", fixable: true, ruleset: "workflow" });
    expect(timeout?.docsUrl).toMatch(/^https:\/\//);
    expect(timeout).not.toHaveProperty("fix");
    expect(summary.total).toBe(summary.diagnostics.length);
    expect(summary.counts.error + summary.counts.warn + summary.counts.info).toBe(summary.total);
    const ranks = summary.diagnostics.map((diagnostic) => ({ error: 3, warn: 2, info: 1 })[diagnostic.severity]);
    expect(ranks).toEqual([...ranks].sort((left, right) => right - left));
  });

  it("filters by minSeverity and caps the page with limit", async () => {
    await write(root, WORKFLOW, MISSING_TIMEOUT);
    await write(root, ".github/workflows/other.yml", MISSING_TIMEOUT);
    const all = await lintWorkspace({ root });
    expect(all.total).toBeGreaterThan(1);
    const page = await lintWorkspace({ root, limit: 1 });
    expect(page.diagnostics).toHaveLength(1);
    expect(page.truncated).toBe(true);
    expect(page.counts).toEqual(all.counts);
    const errors = await lintWorkspace({ root, minSeverity: "error" });
    expect(errors.diagnostics.every((diagnostic) => diagnostic.severity === "error")).toBe(true);
    expect(errors.counts.warn).toBe(0);
  });

  it("reports only the requested paths and lists unmatched ones", async () => {
    await write(root, WORKFLOW, MISSING_TIMEOUT);
    await write(root, ".github/workflows/other.yml", MISSING_TIMEOUT);
    const summary = await lintWorkspace({ root, paths: [".github/workflows/other.yml", "missing/dir"] });
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.diagnostics.every((diagnostic) => diagnostic.path === ".github/workflows/other.yml")).toBe(true);
    expect(summary.unmatched).toEqual(["missing/dir"]);
    const glob = await lintWorkspace({ root, paths: [".github/workflows/*.yml"] });
    expect(new Set(glob.diagnostics.map((diagnostic) => diagnostic.path))).toEqual(new Set([WORKFLOW, ".github/workflows/other.yml"]));
  });

  it("lints unsaved content instead of the file on disk and reports only that path", async () => {
    await write(root, WORKFLOW, MISSING_TIMEOUT);
    await write(root, ".github/workflows/other.yml", MISSING_TIMEOUT);
    const fixed = MISSING_TIMEOUT.replace("    steps:", "    timeout-minutes: 15\n    steps:");
    const clean = await lintWorkspace({ root, content: [{ path: WORKFLOW, text: fixed }] });
    expect(clean.diagnostics.some((diagnostic) => diagnostic.ruleId === "workflow/job-timeout")).toBe(false);
    expect(clean.diagnostics.every((diagnostic) => diagnostic.path === WORKFLOW)).toBe(true);
    const added = await lintWorkspace({ root, content: [{ path: ".github/workflows/new.yml", text: MISSING_TIMEOUT }] });
    expect(added.diagnostics.some((diagnostic) => diagnostic.path === ".github/workflows/new.yml" && diagnostic.ruleId === "workflow/job-timeout")).toBe(true);
    expect(await readFile(join(root, ...WORKFLOW.split("/")), "utf8")).toBe(MISSING_TIMEOUT);
  });

  it("applies preset, ruleset, and rule overrides", async () => {
    await write(root, WORKFLOW, MISSING_TIMEOUT);
    const off = await lintWorkspace({ root, rules: { "workflow/job-timeout": "off" } });
    expect(off.diagnostics.some((diagnostic) => diagnostic.ruleId === "workflow/job-timeout")).toBe(false);
    const error = await lintWorkspace({ root, rules: { "workflow/job-timeout": "error" } });
    expect(error.diagnostics.find((diagnostic) => diagnostic.ruleId === "workflow/job-timeout")?.severity).toBe("error");
    const silenced = await lintWorkspace({ root, rulesets: { workflow: "off" } });
    expect(silenced.diagnostics.some((diagnostic) => diagnostic.ruleset === "workflow")).toBe(false);
  });

  it("honors the workspace configuration and never loads local rules", async () => {
    await write(root, WORKFLOW, MISSING_TIMEOUT);
    const marker = await forbiddenLocalRule(root);
    await write(root, ".github/ci-cd-optimizer.yml", "schemaVersion: 1\nextends: [recommended]\nlocalRules: [rules/forbidden.mjs]\nrules:\n  workflow/job-timeout: error\n");
    const summary = await lintWorkspace({ root });
    expect(summary.configPath).toBe(".github/ci-cd-optimizer.yml");
    expect(summary.localRulesIgnored).toBe(true);
    expect(summary.diagnostics.find((diagnostic) => diagnostic.ruleId === "workflow/job-timeout")?.severity).toBe("error");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects duplicate overrides, oversized configuration, and oversized requests", async () => {
    const content = { path: WORKFLOW, text: MISSING_TIMEOUT };
    await expect(lintWorkspace({ root, content: [content, content] })).rejects.toThrow("unique paths");
    await expect(lintWorkspace({ root, content: [{ ...content, text: "x".repeat(LIMITS.requestBytes) }] })).rejects.toThrow("byte limit");
    await write(root, ".github/ci-cd-optimizer.yml", "#".repeat(LIMITS.configBytes + 1));
    await expect(lintWorkspace({ root })).rejects.toThrow("Configuration exceeds");
  });

  it("fails closed when an existing configuration cannot be inspected", async () => {
    const inspect = vi.mocked(filesystem.lstat).mockRejectedValueOnce(Object.assign(new Error("Access denied"), { code: "EACCES" }));
    try { await expect(loadConfig(root)).rejects.toThrow("could not be inspected"); }
    finally { inspect.mockRestore(); }
  });

  it.each([[0xff], [0xc3, 0x28], [0xed, 0xa0, 0x80], [0xe2, 0x82]])("rejects malformed UTF-8 rather than returning a lossy preview (%j)", async (...invalid) => {
    const path = await write(root, WORKFLOW, MISSING_TIMEOUT);
    const bytes = Buffer.concat([Buffer.from(`${MISSING_TIMEOUT}#`), Buffer.from(invalid)]);
    await filesystem.writeFile(path, bytes);
    await expect(lintWorkspace({ root })).rejects.toThrow("valid UTF-8");
    await expect(fixPreview({ root })).rejects.toThrow("valid UTF-8");
    expect(await readFile(path)).toEqual(bytes);
  });

  it("preserves UTF-8 BOMs and Unicode in exact preview source text", async () => {
    const text = `\ufeff${MISSING_TIMEOUT}# café 🦊\n`;
    const path = await write(root, WORKFLOW, text);
    const preview = await fixPreview({ root, ruleIds: ["workflow/job-timeout"] });
    expect(preview.files[0]?.oldText).toBe(text);
    expect(await readFile(path)).toEqual(Buffer.from(text));
  });

  it.each([[2, "A"], [3, "A"], [4, "A"], [5, "A🦊"], [6, "A🦊B"]] as const)("decodes a bounded prefix without splitting a UTF-8 character at byte %i", async (limit, text) => {
    const path = await write(root, "package-lock.json", "A🦊B");
    expect(await readBoundedFile(root, path, limit)).toEqual({ text, truncated: limit < 6 });
  });

  it("cannot extend the hard file ceiling with unsaved new files", async () => {
    await Promise.all(Array.from({ length: LIMITS.files }, (_, index) => write(root, `.github/workflows/f${index}.yml`, MISSING_TIMEOUT)));
    await expect(lintWorkspace({ root, content: [{ path: ".github/workflows/new.yml", text: MISSING_TIMEOUT }] })).rejects.toThrow("inventory budget");
  });

  it("cannot extend the hard aggregate byte ceiling with unsaved new content", async () => {
    await Promise.all(Array.from({ length: LIMITS.workspaceBytes / LIMITS.fileBytes }, (_, index) => write(root, `.github/workflows/f${index}.yml`, `#${"x".repeat(LIMITS.fileBytes - 2)}\n`)));
    await expect(lintWorkspace({ root, content: [{ path: ".github/workflows/new.yml", text: MISSING_TIMEOUT }] })).rejects.toThrow("inventory budget");
  });

  it("rejects bad requests with actionable errors", async () => {
    await write(root, WORKFLOW, MISSING_TIMEOUT);
    await expect(lintWorkspace({ root: join(root, "nope") })).rejects.toThrow(/is not a directory/);
    await expect(lintWorkspace({ root, paths: ["../outside"] })).rejects.toThrow(AgentError);
    await expect(lintWorkspace({ root, paths: ["https://example.com/ci.yml"] })).rejects.toThrow(/must be a path, not a URL/);
    await expect(lintWorkspace({ root, content: [{ path: ".github/workflows/*.yml", text: "" }] })).rejects.toThrow(/must name a file/);
    await expect(lintWorkspace({ root, content: [{ path: "", text: "" }] })).rejects.toThrow(/must name a file/);
    const many = Array.from({ length: MAX_CONTENT_FILES + 1 }, (_, index) => ({ path: `f${index}.yml`, text: "" }));
    await expect(lintWorkspace({ root, content: many })).rejects.toThrow(/At most 20 content overrides/);
    await expect(lintWorkspace({ root, limit: 0 })).rejects.toThrow(/limit must be a positive integer/);
    await expect(lintWorkspace({ root, minSeverity: "fatal" as never })).rejects.toThrow(/minSeverity/);
    await expect(lintWorkspace({ root, rules: { "workflow/job-timout": "warn" } })).rejects.toThrow(/Did you mean "workflow\/job-timeout"/i);
    await expect(lintWorkspace({ root, rules: { "workflow/job-timeout": "loud" } })).rejects.toThrow(/severity must be one of/);
    await expect(lintWorkspace({ root, rulesets: { workflw: "off" } })).rejects.toThrow(/Unknown ruleset "workflw"/);
    await expect(lintWorkspace({ root, presets: ["recomended"] })).rejects.toThrow(/Unknown preset "recomended"/);
    await expect(lintWorkspace({ root, config: "missing.yml" })).rejects.toThrow(/does not exist/);
    await write(root, "bad.yml", "schemaVersion: 1\nbogus: true\n");
    await expect(lintWorkspace({ root, config: "bad.yml" })).rejects.toThrow(/Invalid configuration bad.yml/);
  });
});

describe("clampLimit", () => {
  it("defaults, clamps, and validates", () => {
    expect(clampLimit(undefined)).toBe(100);
    expect(clampLimit(MAX_LIMIT + 1)).toBe(MAX_LIMIT);
    expect(() => clampLimit(1.5)).toThrow(AgentError);
  });
});

describe("confine and resolveRoot", () => {
  it("accepts paths inside the root and rejects escapes and URLs", async () => {
    expect(await confine(root, "a/b.yml", "Path")).toEqual({ path: "a/b.yml", absolute: join(root, "a", "b.yml") });
    expect((await confine(root, join(root, "a", "b.yml"), "Path")).path).toBe("a/b.yml");
    await expect(confine(root, "../x", "Path")).rejects.toThrow(/outside the lint root/);
    await expect(confine(root, ".", "Path")).rejects.toThrow(/must name a file inside the workspace/);
    await expect(confine(root, "file:///etc/passwd", "Path")).rejects.toThrow(/must be a path, not a URL/);
    await expect(resolveRoot(join(root, "missing"))).rejects.toThrow(/is not a directory/);
  });

  it("rejects a path that escapes through a symlink", async (context) => {
    const outside = await dirs.make("cicd-agents-outside-");
    await write(outside, "secret.yml", "x: 1\n");
    try {
      // Junctions need no privileges on Windows; the type is ignored elsewhere.
      await symlink(outside, join(root, "linked"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip();
      throw error;
    }
    await expect(confine(root, "linked/secret.yml", "Path")).rejects.toThrow(/resolves outside the workspace/);
    await expect(loadConfig(root, "linked/secret.yml")).rejects.toThrow(/resolves outside the workspace/);
  });
});

describe("fixPreview", () => {
  it("previews safe autofixes without writing", async () => {
    await write(root, WORKFLOW, MISSING_TIMEOUT);
    const before = await stat(join(root, ...WORKFLOW.split("/")), { bigint: true });
    const preview = await fixPreview({ root, ruleIds: ["workflow/job-timeout"] });
    expect(preview.written).toBe(false);
    expect(preview).toMatchObject({ inventoryComplete: true, localRulesIgnored: false, parseProblemCount: 0 });
    expect(preview.applied).toBe(1);
    expect(preview.files).toHaveLength(1);
    const [file] = preview.files;
    expect(file?.path).toBe(WORKFLOW);
    expect(file?.oldText).toBe(MISSING_TIMEOUT);
    expect(file?.newText).toMatch(/timeout-minutes: \d+/);
    expect(file?.fixes[0]).toMatch(/^workflow\/job-timeout: /);
    expect(await readFile(join(root, ...WORKFLOW.split("/")), "utf8")).toBe(MISSING_TIMEOUT);
    expect((await stat(join(root, ...WORKFLOW.split("/")), { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  });

  it("counts omitted diffs and never supplies partial old/new file text", async () => {
    await Promise.all(Array.from({ length: 22 }, (_, index) => write(root, `.github/workflows/f${index}.yml`, MISSING_TIMEOUT)));
    const preview = await fixPreview({ root, ruleIds: ["workflow/job-timeout"] });
    expect(preview.omittedFiles).toBe(2);
    expect(preview.files.filter((file) => !file.omitted)).toHaveLength(20);
    for (const file of preview.files.filter((entry) => entry.omitted)) {
      expect(file).not.toHaveProperty("oldText");
      expect(file).not.toHaveProperty("newText");
    }
    await write(root, WORKFLOW, `${MISSING_TIMEOUT}#${"x".repeat(34_000)}\n`);
    const large = await fixPreview({ root, paths: [WORKFLOW], ruleIds: ["workflow/job-timeout"] });
    expect(large.files).toEqual([expect.objectContaining({ path: WORKFLOW, omitted: true })]);
    expect(large.omittedFiles).toBe(1);
  });

  it("reports incomplete coverage, parse failures, and ignored local rules even when no diff is returned", async () => {
    const marker = await forbiddenLocalRule(root);
    await write(root, WORKFLOW, "jobs: [unterminated\n");
    const broken = await fixPreview({ root });
    expect(broken).toMatchObject({ inventoryComplete: true, localRulesIgnored: true, parseProblemCount: 1, files: [], written: false });
    await write(root, WORKFLOW, "#".repeat(LIMITS.fileBytes + 1));
    expect(await fixPreview({ root })).toMatchObject({ inventoryComplete: false, localRulesIgnored: true, files: [], written: false });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns nothing when no selected fix applies and rejects unknown rule ids", async () => {
    await write(root, WORKFLOW, MISSING_TIMEOUT);
    const none = await fixPreview({ root, paths: ["missing.yml"] });
    expect(none).toMatchObject({ applied: 0, files: [], written: false });
    await expect(fixPreview({ root, ruleIds: ["workflow/nope"] })).rejects.toThrow(/unknown rule "workflow\/nope"/);
  });
});

describe("rules", () => {
  it("lists and filters the built-in rules", () => {
    expect(listRules()).toHaveLength(allRules.length);
    const workflow = listRules({ ruleset: "workflow" });
    expect(workflow.length).toBeGreaterThan(0);
    expect(workflow.every((rule) => rule.ruleset === "workflow")).toBe(true);
    expect(listRules({ fixable: true }).map((rule) => rule.id)).toContain("workflow/job-timeout");
    expect(listRules({ query: "TIMEOUT" }).map((rule) => rule.id)).toContain("workflow/job-timeout");
    expect(listRules({ preset: "agentic" }).every((rule) => rule.presets.includes("agentic"))).toBe(true);
    expect(() => listRules({ ruleset: "workflw" })).toThrow(/Unknown ruleset/);
    expect(() => listRules({ preset: "strct" })).toThrow(/Unknown preset/);
  });

  it("explains a rule with its effective severity", async () => {
    const explanation = await explainRule("workflow/job-timeout");
    expect(explanation).toMatchObject({ id: "workflow/job-timeout", ruleset: "workflow", fixable: true, effectiveSeverity: "warn" });
    expect(explanation.rationale.length).toBeGreaterThan(0);
    expect(explanation.text).toContain("workflow/job-timeout");
    await write(root, ".github/ci-cd-optimizer.yml", "schemaVersion: 1\nextends: [recommended]\nrules:\n  workflow/job-timeout: off\n");
    expect((await explainRule("workflow/job-timeout", { root })).effectiveSeverity).toBe("off");
    await expect(explainRule("workflow/job-timout")).rejects.toThrow(/Did you mean "workflow\/job-timeout"/i);
  });

  it("reports the effective configuration with overrides", async () => {
    const base = await effectiveConfig({ root });
    expect(base.configPath).toBeNull();
    expect(base.rules["workflow/job-timeout"]).toBe("warn");
    const changed = await effectiveConfig({ root, rules: { "workflow/job-timeout": "error" }, presets: ["strict"] });
    expect(changed.rules["workflow/job-timeout"]).toBe("error");
    expect(changed.config.extends).toEqual(["strict"]);
  });
});

describe("validateReviewProject", () => {
  it("validates a project.yaml and reports problems", async () => {
    await write(root, "projects/widget/project.yaml", PROJECT_YAML);
    const valid = await validateReviewProject(root, "projects/widget/project.yaml");
    expect(valid).toMatchObject({ path: "projects/widget/project.yaml", valid: true, problems: [] });
    expect(valid.project?.name).toBe("widget");
    await write(root, "projects/gadget/project.yaml", PROJECT_YAML);
    const mismatch = await validateReviewProject(root, "projects/gadget/project.yaml");
    expect(mismatch.valid).toBe(false);
    expect(mismatch.problems.length).toBeGreaterThan(0);
    expect(mismatch).not.toHaveProperty("project");
    await expect(validateReviewProject(root, "projects/none/project.yaml")).rejects.toThrow(/does not exist/);
    await expect(validateReviewProject(root, "projects/widget/other.yaml")).rejects.toThrow(/must be named project.yaml/);
    await expect(validateReviewProject(root, "../project.yaml")).rejects.toThrow(AgentError);
  });
});
