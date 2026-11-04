import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/index.js";
import type { CliIO } from "../../src/cli/io.js";
import { allRules } from "../../src/lint/rules/index.js";
import type { LintResult } from "../../src/lint/types.js";
import { VERSION } from "../../src/version.js";

const WORKFLOW = ".github/workflows/ci.yml";
const MISSING_TIMEOUT = `name: ci
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo hi
`;

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cicd-cli-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
}

function cli(overrides: Partial<CliIO> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { cwd: root, env: {}, stdout: (text) => out.push(text), stderr: (text) => err.push(text), ...overrides };
  return {
    io,
    run: (...argv: string[]) => run(argv, io),
    get stdout() {
      return out.join("\n");
    },
    get stderr() {
      return err.join("\n");
    },
  };
}

const ruleIds = (stdout: string) => (JSON.parse(stdout) as LintResult).diagnostics.map((d) => d.ruleId);

describe("cli", () => {
  it("prints the version and help", async () => {
    const c = cli();
    expect(await c.run("version")).toBe(0);
    expect(c.stdout).toBe(VERSION);
    const help = cli();
    expect(await help.run("--help")).toBe(0);
    expect(help.stdout).toContain("Usage: ci-cd-optimizer <command>");
    const lintHelp = cli();
    expect(await lintHelp.run("help", "lint")).toBe(0);
    expect(lintHelp.stdout).toContain("Usage: ci-cd-optimizer lint");
  });

  it("rejects unknown commands and flags with exit code 2", async () => {
    const typo = cli();
    expect(await typo.run("lnt")).toBe(2);
    expect(typo.stderr).toContain('Unknown command "lnt"');
    expect(await cli().run("lint", "--nope")).toBe(2);
    expect(await cli().run("lint", "a", "b")).toBe(2);
  });

  it("lints a directory named like a command", async () => {
    await write(`app/${WORKFLOW}`, MISSING_TIMEOUT);
    const c = cli();
    expect(await c.run("app", "-f", "json")).toBe(0);
    expect(ruleIds(c.stdout)).toContain("workflow/job-timeout");
  });

  describe("lint", () => {
    beforeEach(() => write(WORKFLOW, MISSING_TIMEOUT));

    it("reports findings and exits by --fail-on", async () => {
      const c = cli();
      expect(await c.run("lint", "-f", "json")).toBe(0);
      const result = JSON.parse(c.stdout) as LintResult;
      expect(result.diagnostics.find((d) => d.ruleId === "workflow/job-timeout")).toMatchObject({ path: WORKFLOW, severity: "warn" });
      expect(result.filesAnalyzed).toBe(1);
      expect(await cli().run("lint", "--fail-on", "warn")).toBe(1);
      expect(await cli().run("lint", "--fail-on", "never", "--rule", "workflow/job-timeout=error")).toBe(0);
      expect(await cli().run("--rule", "workflow/job-timeout=error")).toBe(1);
      const stylish = cli();
      await stylish.run(".");
      expect(stylish.stdout).toContain(WORKFLOW);
      expect(stylish.stdout).toMatch(/\d+ problem\(s\)/);
    });

    it("applies --rule, --ruleset, and --preset overrides", async () => {
      const off = cli();
      await off.run("-f", "json", "--rule", "workflow/job-timeout=off");
      expect(ruleIds(off.stdout)).not.toContain("workflow/job-timeout");
      const ruleset = cli();
      await ruleset.run("-f", "json", "--ruleset", "workflow=off");
      expect(ruleIds(ruleset.stdout).some((id) => id.startsWith("workflow/"))).toBe(false);
      const preset = cli();
      await preset.run("-f", "json", "--preset", "github");
      expect(ruleIds(preset.stdout)).not.toContain("workflow/job-timeout");
    });

    it("rejects bad overrides and options", async () => {
      const unknown = cli();
      expect(await unknown.run("--rule", "workflow/job-timout=warn")).toBe(2);
      expect(unknown.stderr).toContain('Did you mean "workflow/job-timeout"?');
      expect(await cli().run("--rule", "workflow/job-timeout=loud")).toBe(2);
      expect(await cli().run("--ruleset", "nope=off")).toBe(2);
      expect(await cli().run("--preset", "recomended")).toBe(2);
      expect(await cli().run("--format", "xml")).toBe(2);
      expect(await cli().run("--fail-on", "warning")).toBe(2);
      expect(await cli().run("--max-warnings", "-1")).toBe(2);
      const scope = cli();
      expect(await scope.run("--scope", "changed")).toBe(2);
      expect(scope.stderr).toContain("needs --base");
    });

    it("enforces --max-warnings and --quiet", async () => {
      const many = cli();
      expect(await many.run("--max-warnings", "0")).toBe(1);
      expect(many.stderr).toContain("Too many warnings");
      expect(await cli().run("--max-warnings", "100")).toBe(0);
      const quiet = cli();
      await quiet.run("-q", "-f", "json");
      expect((JSON.parse(quiet.stdout) as LintResult).diagnostics.every((d) => d.severity === "error")).toBe(true);
      expect(ruleIds(quiet.stdout)).not.toContain("workflow/job-timeout");
    });

    it("writes reports and SARIF to files", async () => {
      const c = cli();
      expect(await c.run("-f", "markdown", "-o", "out/report.md", "--sarif", "out/results.sarif")).toBe(0);
      expect(c.stdout).toBe("");
      expect(await readFile(join(root, "out/report.md"), "utf8")).toContain("`workflow/job-timeout`");
      const log = JSON.parse(await readFile(join(root, "out/results.sarif"), "utf8"));
      expect(log.version).toBe("2.1.0");
      expect(log.runs[0].results.some((r: { ruleId: string }) => r.ruleId === "workflow/job-timeout")).toBe(true);
    });

    it("applies autofixes in place", async () => {
      const c = cli();
      expect(await c.run("--fix", "-f", "json")).toBe(0);
      expect(c.stderr).toMatch(/Applied \d+ fix\(es\) to 1 file\(s\)/);
      expect(await readFile(join(root, WORKFLOW), "utf8")).toContain("    timeout-minutes: 30\n");
      expect(ruleIds(c.stdout)).not.toContain("workflow/job-timeout");
    });

    it("loads and validates the repository configuration", async () => {
      await write("custom.yml", "failOn: warn\n");
      expect(await cli().run("-c", "custom.yml")).toBe(1);
      expect(await cli().run("-c", "missing.yml")).toBe(2);

      await write(".github/ci-cd-optimizer.yml", "rules:\n  workflow/job-timeout: [error, { defaultMinutes: 20 }]\n");
      expect(await cli().run()).toBe(1);
      const fixed = cli();
      await fixed.run("--fix", "--fail-on", "never");
      expect(await readFile(join(root, WORKFLOW), "utf8")).toContain("timeout-minutes: 20");

      await write(".github/ci-cd-optimizer.yml", "rules:\n  bogus/rule: warn\n");
      const invalid = cli();
      expect(await invalid.run()).toBe(2);
      expect(invalid.stderr).toContain("Invalid configuration");
      expect(invalid.stderr).toContain("rules.bogus/rule");
    });

    it("reports a migrated legacy configuration", async () => {
      await write(".github/ci-cd-optimizer.yml", "disabledRules: [workflow-timeout]\n");
      const c = cli();
      await c.run("-f", "json");
      expect(c.stderr).toContain("legacy configuration keys were migrated");
      expect(ruleIds(c.stdout)).not.toContain("workflow/job-timeout");
    });
  });

  describe("lint --base", () => {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], { cwd: root, stdio: "pipe" });

    it("reports only findings the change introduces", async () => {
      await write(WORKFLOW, MISSING_TIMEOUT);
      git("init", "-q");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      await write(WORKFLOW, `${MISSING_TIMEOUT}  lint:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo lint\n`);

      const introduced = cli();
      expect(await introduced.run("-f", "json", "--base", "HEAD", "--rule", "workflow/job-timeout=error")).toBe(1);
      const diagnostics = (JSON.parse(introduced.stdout) as LintResult).diagnostics.filter((d) => d.ruleId === "workflow/job-timeout");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.scope).toBe("introduced");
      expect(diagnostics[0]?.line).toBeGreaterThanOrEqual(10);

      const changed = cli();
      await changed.run("-f", "json", "--base", "HEAD", "--scope", "changed");
      const scopes = (JSON.parse(changed.stdout) as LintResult).diagnostics.filter((d) => d.ruleId === "workflow/job-timeout").map((d) => d.scope);
      expect(scopes.sort()).toEqual(["changed-file", "introduced"]);

      const bad = cli();
      expect(await bad.run("--base", "no-such-ref")).toBe(2);
      expect(bad.stderr).toContain("--base no-such-ref");
    }, 60_000);
  });

  describe("rules", () => {
    it("lists rules as text, json, and markdown", async () => {
      const text = cli();
      expect(await text.run("rules")).toBe(0);
      expect(text.stdout.split("\n")).toHaveLength(allRules.length);
      const json = cli();
      await json.run("rules", "--format", "json");
      expect((JSON.parse(json.stdout) as Array<{ id: string }>).map((meta) => meta.id)).toEqual(allRules.map((rule) => rule.meta.id));
      const markdown = cli();
      await markdown.run("rules", "-f", "markdown", "-o", "docs/rules.md");
      expect(await readFile(join(root, "docs/rules.md"), "utf8")).toContain("workflow/job-timeout");
      expect(await cli().run("rules", "--format", "xml")).toBe(2);
    });
  });
});
