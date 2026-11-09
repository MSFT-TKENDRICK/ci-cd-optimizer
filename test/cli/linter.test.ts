import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { run } from "../../src/cli/index.js";
import type { CliIO } from "../../src/cli/io.js";
import { STARTER_CONFIG, UNUSED_DIRECTIVE_RULE_ID } from "../../src/cli/lint.js";
import { parseConfigText } from "../../src/lint/config.js";
import { allRules } from "../../src/lint/rules/index.js";
import type { Diagnostic, LintResult } from "../../src/lint/types.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW = ".github/workflows/ci.yml";
const RELEASE = ".github/workflows/release.yml";
const CONFIG = ".github/ci-cd-optimizer.yml";

/** `workflow/job-timeout` reports on the job key line (line 6); nothing else fires under any preset. */
function workflow(options: { name?: string; timeout?: boolean; before?: string; beforeJob?: string; beforeStep?: string } = {}): string {
  return [
    ...(options.before ? [options.before] : []),
    `name: ${options.name ?? "ci"}`,
    "on:",
    "  push:",
    "    branches: [main]",
    "jobs:",
    ...(options.beforeJob ? [`  ${options.beforeJob}`] : []),
    "  test:",
    "    runs-on: ubuntu-24.04",
    ...(options.timeout ? ["    timeout-minutes: 10"] : []),
    "    steps:",
    ...(options.beforeStep ? [`      ${options.beforeStep}`] : []),
    "      - run: echo hi",
    "    permissions: {}",
    "",
  ].join("\n");
}

const MISSING_TIMEOUT = workflow();
const CLEAN = workflow({ timeout: true });

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cicd-linter-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(path: string, content: string, base = root): Promise<void> {
  await mkdir(dirname(join(base, path)), { recursive: true });
  await writeFile(join(base, path), content, "utf8");
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

const result = (stdout: string) => JSON.parse(stdout) as LintResult;
const ruleIds = (stdout: string) => result(stdout).diagnostics.map((d) => d.ruleId);
const paths = (stdout: string) => [...new Set(result(stdout).diagnostics.map((d) => d.path))].sort();
const unused = (stdout: string): Diagnostic[] => result(stdout).diagnostics.filter((d) => d.ruleId === UNUSED_DIRECTIVE_RULE_ID);

describe("exit codes", () => {
  it("exits 0 when clean, 1 for findings at --fail-on, and 2 for usage or configuration errors", async () => {
    await write(WORKFLOW, CLEAN);
    const clean = cli();
    expect(await clean.run("lint", "--fail-on", "info", "-f", "json")).toBe(0);
    expect(result(clean.stdout).diagnostics).toEqual([]);

    await write(RELEASE, workflow({ name: "release" }));
    expect(await cli().run("lint")).toBe(0);
    expect(await cli().run("lint", "--fail-on", "warn")).toBe(1);

    expect(await cli().run("lint", "--nope")).toBe(2);
    const stdin = cli();
    expect(await stdin.run("lint", "--stdin")).toBe(2);
    expect(stdin.stderr).toContain("--stdin-filename");

    await write(CONFIG, "schemaVersion: 1\nbogus: 1\n");
    const config = cli();
    expect(await config.run("lint")).toBe(2);
    expect(config.stderr).toContain("bogus");
  });
});

describe("path arguments", () => {
  beforeEach(async () => {
    await write(WORKFLOW, MISSING_TIMEOUT);
    await write(RELEASE, workflow({ name: "release" }));
    await write("README.md", "# readme\n");
  });

  it("reports only the named file", async () => {
    const c = cli();
    expect(await c.run("lint", WORKFLOW, "-f", "json")).toBe(0);
    expect(paths(c.stdout)).toEqual([WORKFLOW]);
    const windows = cli();
    await windows.run("lint", ".github\\workflows\\release.yml", "-f", "json");
    expect(paths(windows.stdout)).toEqual([RELEASE]);
    const absolute = cli();
    await absolute.run("lint", join(root, RELEASE), "-f", "json");
    expect(paths(absolute.stdout)).toEqual([RELEASE]);
  });

  it("accepts globs, several paths, and directory prefixes", async () => {
    const glob = cli();
    await glob.run("lint", ".github/workflows/*.yml", "-f", "json");
    expect(paths(glob.stdout)).toEqual([WORKFLOW, RELEASE]);
    const two = cli();
    await two.run("lint", WORKFLOW, RELEASE, "-f", "json");
    expect(paths(two.stdout)).toEqual([WORKFLOW, RELEASE]);
    const prefix = cli();
    await prefix.run("lint", "--root", ".", ".github", "-f", "json");
    expect(paths(prefix.stdout)).toEqual([WORKFLOW, RELEASE]);
    expect(await cli().run("lint", WORKFLOW, RELEASE, "--fail-on", "warn")).toBe(1);
  });

  it("keeps the single-directory behavior", async () => {
    await write(`app/${WORKFLOW}`, MISSING_TIMEOUT);
    const c = cli();
    expect(await c.run("lint", "app", "-f", "json")).toBe(0);
    expect(paths(c.stdout)).toEqual([WORKFLOW]);
  });

  it("explains paths that match nothing and exits 0", async () => {
    const missing = cli();
    expect(await missing.run("lint", "nope.yml", "README.md", "--fail-on", "warn")).toBe(0);
    expect(missing.stderr).toContain("nope.yml: no such file or directory.");
    expect(missing.stderr).toContain("README.md: not a file type ci-cd-optimizer lints.");
    expect(missing.stderr).toContain("No lintable files matched the given paths; nothing to report.");
    const glob = cli();
    expect(await glob.run("lint", "docker/*.Dockerfile")).toBe(0);
    expect(glob.stderr).toContain("docker/*.Dockerfile: no lintable files match.");
    const partial = cli();
    expect(await partial.run("lint", WORKFLOW, "nope.yml", "-f", "json")).toBe(0);
    expect(paths(partial.stdout)).toEqual([WORKFLOW]);
    expect(partial.stderr).toContain("nope.yml: no such file or directory.");
    expect(partial.stderr).not.toContain("No lintable files matched");
  });

  it("rejects paths outside the lint root", async () => {
    const c = cli();
    expect(await c.run("lint", "../elsewhere.yml")).toBe(2);
    expect(c.stderr).toContain("outside the lint root");
    expect(await cli().run("lint", "--root", "missing-dir")).toBe(2);
  });
});

describe("--stdin", () => {
  it("lints stdin content in place of the file on disk and reports only that path", async () => {
    await write(WORKFLOW, CLEAN);
    await write(RELEASE, workflow({ name: "release" }));
    const c = cli({ stdin: async () => MISSING_TIMEOUT });
    expect(await c.run("lint", "--stdin", "--stdin-filename", WORKFLOW, "-f", "json")).toBe(0);
    expect(paths(c.stdout)).toEqual([WORKFLOW]);
    expect(ruleIds(c.stdout)).toContain("workflow/job-timeout");
    expect(await readFile(join(root, WORKFLOW), "utf8")).toBe(CLEAN);

    const added = cli({ stdin: async () => MISSING_TIMEOUT });
    await added.run("lint", "--stdin", "--stdin-filename", ".github/workflows/new.yml", "-f", "json");
    expect(paths(added.stdout)).toEqual([".github/workflows/new.yml"]);

    const fixed = cli({ stdin: async () => CLEAN });
    expect(await fixed.run("lint", "--stdin", "--stdin-filename", RELEASE, "--fail-on", "warn", "-f", "json")).toBe(0);
    expect(result(fixed.stdout).diagnostics).toEqual([]);
  });

  it("validates --stdin combinations", async () => {
    const stdin = async () => CLEAN;
    expect(await cli({ stdin }).run("lint", "--stdin", "--stdin-filename", WORKFLOW, "--fix")).toBe(2);
    expect(await cli({ stdin }).run("lint", "--stdin", "--stdin-filename", WORKFLOW, WORKFLOW)).toBe(2);
    expect(await cli({ stdin }).run("lint", "--stdin-filename", WORKFLOW)).toBe(2);
    expect(await cli({ stdin }).run("lint", "--stdin", "--stdin-filename", ".github/workflows/*.yml")).toBe(2);
    expect(await cli().run("lint", "--stdin", "--stdin-filename", WORKFLOW)).toBe(2);
    const other = cli({ stdin });
    expect(await other.run("lint", "--stdin", "--stdin-filename", "notes.txt")).toBe(0);
    expect(other.stderr).toContain("notes.txt: not a file type ci-cd-optimizer lints");
  });
});

describe("suppressions", () => {
  async function lintWith(content: string, ...args: string[]) {
    await write(WORKFLOW, content);
    const c = cli();
    const code = await c.run("lint", "-f", "json", ...args);
    return { code, stdout: c.stdout, stderr: c.stderr };
  }

  it("suppresses by rule id, ruleset, file, and with a reason", async () => {
    for (const content of [
      workflow({ beforeJob: "# cicd-optimizer-disable-next-line workflow/job-timeout" }),
      workflow({ beforeJob: "# cicd-optimizer-disable-next-line workflow" }),
      workflow({ beforeJob: "# cicd-optimizer-disable-next-line workflow/job-timeout -- the job is a trivial echo" }),
      workflow({ before: "# cicd-optimizer-disable-file workflow/job-timeout" }),
      workflow({ before: "# cicd-optimizer-disable-file" }),
    ]) {
      const { stdout } = await lintWith(content, "--report-unused-disable-directives");
      expect(ruleIds(stdout)).toEqual([]);
      expect(result(stdout).suppressed).toBe(1);
    }
  });

  it("reports unused ids within a directive only when asked", async () => {
    const content = workflow({ beforeJob: "# cicd-optimizer-disable-next-line workflow/job-timeout, caching/setup-cache" });
    const off = await lintWith(content);
    expect(unused(off.stdout)).toEqual([]);
    const { stdout, code } = await lintWith(content, "--report-unused-disable-directives");
    expect(code).toBe(0);
    expect(unused(stdout)).toEqual([
      expect.objectContaining({
        ruleset: "meta",
        severity: "warn",
        line: 6,
        message: 'Unused cicd-optimizer-disable-next-line directive for "caching/setup-cache": no matching problems were suppressed.',
      }),
    ]);
    expect(ruleIds(stdout)).toEqual([UNUSED_DIRECTIVE_RULE_ID]);
  });

  it("reports unused blanket directives and unknown ids", async () => {
    const blanket = await lintWith(workflow({ timeout: true, beforeStep: "# cicd-optimizer-disable-next-line" }), "--report-unused-disable-directives");
    expect(unused(blanket.stdout).map((d) => d.message)).toEqual(["Unused cicd-optimizer-disable-next-line directive: it suppressed no problems."]);
    const typo = await lintWith(workflow({ beforeJob: "# cicd-optimizer-disable-next-line workflow/job-timout" }), "--report-unused-disable-directives");
    expect(unused(typo.stdout)[0]?.message).toContain('Did you mean "workflow/job-timeout"?');
    expect(ruleIds(typo.stdout)).toContain("workflow/job-timeout");
  });

  it("does not report directives that suppressed findings, even under --quiet", async () => {
    const content = workflow({ beforeJob: "# cicd-optimizer-disable-next-line workflow/job-timeout" });
    const quiet = await lintWith(content, "-q", "--report-unused-disable-directives", "error");
    expect(quiet.code).toBe(0);
    expect(unused(quiet.stdout)).toEqual([]);
  });

  it("fails on unused directives in error mode", async () => {
    const content = workflow({ timeout: true, beforeJob: "# cicd-optimizer-disable-next-line workflow/job-timeout" });
    const error = await lintWith(content, "--report-unused-disable-directives", "error");
    expect(error.code).toBe(1);
    expect(unused(error.stdout)[0]?.severity).toBe("error");
    expect((await lintWith(content, "--report-unused-disable-directives=error")).code).toBe(1);
    expect((await lintWith(content, "--report-unused-disable-directives", "off")).code).toBe(0);
    expect((await lintWith(content, "--report-unused-disable-directives=loud")).code).toBe(2);
  });

  it("filters unused directives to the selected paths", async () => {
    await write(RELEASE, workflow({ name: "release", timeout: true, beforeJob: "# cicd-optimizer-disable-next-line workflow/job-timeout" }));
    const selected = await lintWith(CLEAN, "--report-unused-disable-directives", WORKFLOW);
    expect(unused(selected.stdout)).toEqual([]);
    const all = await lintWith(CLEAN, "--report-unused-disable-directives");
    expect(unused(all.stdout).map((d) => d.path)).toEqual([RELEASE]);
  });

  it("describes the unused-directive rule in SARIF", async () => {
    await write(WORKFLOW, workflow({ timeout: true, beforeJob: "# cicd-optimizer-disable-next-line workflow/job-timeout" }));
    expect(await cli().run("lint", "--report-unused-disable-directives", "--sarif", "out.sarif")).toBe(0);
    const log = JSON.parse(await readFile(join(root, "out.sarif"), "utf8"));
    const rules = log.runs[0].tool.driver.rules as { id: string; helpUri?: string }[];
    expect(rules.find((rule) => rule.id === UNUSED_DIRECTIVE_RULE_ID)?.helpUri).toContain("docs/linter.md#suppressions");
    expect(log.runs[0].results.map((r: { ruleId: string }) => r.ruleId)).toEqual([UNUSED_DIRECTIVE_RULE_ID]);
  });
});

describe("local rules", () => {
  const MODULE = ".github/cicd-rules/no-echo.mjs";
  const rule = (id: string, extra = "") => `{
    meta: {
      id: ${JSON.stringify(id)},
      ruleset: "local",
      description: "Steps should do more than echo.",
      rationale: "Echo-only steps waste runner time.",
      kind: "practice",
      defaultSeverity: "warn",
      presets: ["recommended"],
      docsUrl: "https://example.com/rules/no-echo",
      ${extra}
    },
    check({ project, report }) {
      for (const workflow of project.workflows) report({ path: workflow.path, line: 1, message: "Local rule finding." });
    },
  }`;
  const config = (...entries: string[]) => `schemaVersion: 1\nlocalRules:\n${entries.map((entry) => `  - ${JSON.stringify(entry)}\n`).join("")}`;

  beforeEach(async () => {
    await write(WORKFLOW, CLEAN);
    await write(MODULE, `/** @type {import("ci-cd-optimizer").RuleModule[]} */\nexport const rules = [${rule("local/no-echo")}];\n`);
    await write(CONFIG, config(MODULE));
  });

  it("loads local rules only with --allow-local-rules", async () => {
    const denied = cli();
    expect(await denied.run("lint")).toBe(2);
    expect(denied.stderr).toContain("--allow-local-rules");
    const c = cli();
    expect(await c.run("lint", "--allow-local-rules", "-f", "json")).toBe(0);
    expect(result(c.stdout).diagnostics).toEqual([
      expect.objectContaining({ ruleId: "local/no-echo", ruleset: "local", severity: "warn", path: WORKFLOW, docsUrl: "https://example.com/rules/no-echo" }),
    ]);
    expect(await cli().run("lint", "--allow-local-rules", "--fail-on", "warn")).toBe(1);
  });

  it("configures, lists, explains, and prints local rules", async () => {
    await write(CONFIG, `${config(MODULE)}rules:\n  local/no-echo: error\n`);
    expect(await cli().run("lint", "--allow-local-rules")).toBe(1);
    const list = cli();
    expect(await list.run("lint", "--allow-local-rules", "--list-rules")).toBe(0);
    expect(list.stdout.trim().split("\n")).toHaveLength(allRules.length + 1);
    expect(list.stdout).toContain("local/no-echo");
    const explain = cli();
    expect(await explain.run("lint", "--allow-local-rules", "--explain", "local/no-echo")).toBe(0);
    expect(explain.stdout).toContain("Severity:  error (default: warn)");
    expect(explain.stdout).toContain("Docs: https://example.com/rules/no-echo");
    const printed = cli();
    expect(await printed.run("lint", "--allow-local-rules", "--print-config")).toBe(0);
    expect(JSON.parse(printed.stdout).rules["local/no-echo"]).toBe("error");
    const off = cli();
    await off.run("lint", "--allow-local-rules", "--rule", "local/no-echo=off", "-f", "json");
    expect(ruleIds(off.stdout)).toEqual([]);
    const sarif = cli();
    expect(await sarif.run("lint", "--allow-local-rules", "--rule", "local/no-echo=warn", "--sarif", "out.sarif")).toBe(0);
    const log = JSON.parse(await readFile(join(root, "out.sarif"), "utf8"));
    expect(log.runs[0].tool.driver.rules.map((r: { id: string }) => r.id)).toContain("local/no-echo");
  });

  it("accepts a default export", async () => {
    await write(".github/cicd-rules/single.js", `export default ${rule("local/single")};\n`);
    await write(".github/cicd-rules/package.json", '{ "type": "module" }\n');
    await write(CONFIG, config(".github/cicd-rules/single.js"));
    const c = cli();
    expect(await c.run("lint", "--allow-local-rules", "-f", "json")).toBe(0);
    expect(ruleIds(c.stdout)).toEqual(["local/single"]);
  });

  it.each([
    ["an absolute path", "/etc/rules.mjs", "not an absolute path"],
    ["a drive path", "C:/rules/x.mjs", "not an absolute path"],
    ["a drive-relative path", "C:rules/x.mjs", "without drive letters or colons"],
    ["a parent path", "../x.mjs", "must stay inside the repository"],
    ["a normalized parent path", ".github/../../x.mjs", "must stay inside the repository"],
    ["an https URL", "https://example.com/x.mjs", "not a URL"],
    ["a data URL", "data:text/javascript,export default 1", "not a URL"],
    ["a TypeScript file", ".github/cicd-rules/x.ts", "must be a .js or .mjs file"],
    ["a missing file", ".github/cicd-rules/missing.mjs", "does not exist"],
  ])("rejects %s", async (_label, entry, message) => {
    await write(CONFIG, config(entry));
    const c = cli();
    expect(await c.run("lint", "--allow-local-rules")).toBe(2);
    expect(c.stderr).toContain(message);
  });

  it("rejects the in-repository absolute path to a real module", async () => {
    await write(CONFIG, config(join(root, MODULE)));
    const c = cli();
    expect(await c.run("lint", "--allow-local-rules")).toBe(2);
    expect(c.stderr).toContain("not an absolute path");
  });

  it.each([
    ["a bad id", `export const rules = [${rule("no-echo")}];`, "meta.id must match"],
    ["a non-local ruleset", `export const rules = [${rule("local/x").replace('ruleset: "local"', 'ruleset: "workflow"')}];`, 'meta.ruleset must be "local"'],
    ["a bad severity", `export const rules = [${rule("local/x").replace('defaultSeverity: "warn"', 'defaultSeverity: "loud"')}];`, "meta.defaultSeverity"],
    ["a bad preset", `export const rules = [${rule("local/x", 'presets: ["nope"],')}];`, "meta.presets"],
    ["a missing check", "export const rules = [{ meta: { id: 'local/x', ruleset: 'local', description: 'x', kind: 'practice', defaultSeverity: 'warn' } }];", "check must be a function"],
    ["no rules", "export const helper = 1;", "must export `rules`"],
    ["duplicate ids", `export const rules = [${rule("local/x")}, ${rule("local/x")}];`, 'duplicate rule id "local/x"'],
    ["a syntax error", "export const rules = [;", "failed to load"],
  ])("rejects a module with %s", async (_label, source, message) => {
    await write(".github/cicd-rules/bad.mjs", `${source}\n`);
    await write(CONFIG, config(".github/cicd-rules/bad.mjs"));
    const c = cli();
    expect(await c.run("lint", "--allow-local-rules")).toBe(2);
    expect(c.stderr).toContain(message);
  });

  it("rejects duplicate ids across modules", async () => {
    await write(".github/cicd-rules/again.mjs", `export const rules = [${rule("local/no-echo")}];\n`);
    await write(CONFIG, config(MODULE, ".github/cicd-rules/again.mjs"));
    const c = cli();
    expect(await c.run("lint", "--allow-local-rules")).toBe(2);
    expect(c.stderr).toContain('duplicate rule id "local/no-echo"');
  });

  it("rejects links that resolve outside the repository", async (context) => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "cicd-outside-")));
    try {
      await write("rules/escape.mjs", `export const rules = [${rule("local/escape")}];\n`, outside);
      try {
        // Junctions need no privileges on Windows; the type is ignored elsewhere.
        await symlink(join(outside, "rules"), join(root, ".github", "linked"), "junction");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip();
        throw error;
      }
      await write(CONFIG, config(".github/linked/escape.mjs"));
      const c = cli();
      expect(await c.run("lint", "--allow-local-rules")).toBe(2);
      expect(c.stderr).toContain("resolves outside the repository");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("validates the rest of the configuration against built-in and local rules", async () => {
    await write(CONFIG, `${config(MODULE)}rules:\n  local/no-ech: warn\n`);
    const c = cli();
    expect(await c.run("lint", "--allow-local-rules")).toBe(2);
    expect(c.stderr).toContain('Did you mean "local/no-echo"?');
    await write(CONFIG, "schemaVersion: 1\nlocalRules: .github/cicd-rules/no-echo.mjs\n");
    expect(await cli().run("lint", "--allow-local-rules")).toBe(2);
  });
});

describe("--init", () => {
  it("writes a starter configuration that parses cleanly and never overwrites", async () => {
    const c = cli();
    expect(await c.run("lint", "--init")).toBe(0);
    expect(c.stdout).toContain(`Created ${join(root, CONFIG)}`);
    const text = await readFile(join(root, CONFIG), "utf8");
    expect(text).toBe(STARTER_CONFIG);
    const parsed = parseConfigText(text, allRules);
    expect(parsed.problems).toEqual([]);
    expect(parsed.config).toMatchObject({ extends: ["recommended"], failOn: "error", localRules: [] });
    const again = cli();
    expect(await again.run("lint", "--init")).toBe(2);
    expect(again.stderr).toContain("already exists");
    expect(await readFile(join(root, CONFIG), "utf8")).toBe(STARTER_CONFIG);
    await write(WORKFLOW, CLEAN);
    expect(await cli().run("lint", "--fail-on", "warn")).toBe(0);
  });

  it("honors -c and refuses when another configuration file exists", async () => {
    const custom = cli();
    expect(await custom.run("lint", "--init", "-c", "config/lint.yml")).toBe(0);
    expect(parseConfigText(await readFile(join(root, "config/lint.yml"), "utf8"), allRules).problems).toEqual([]);
    expect(await cli().run("lint", "--init", "-c", "config/lint.yml")).toBe(2);
    await write(".github/ci-cd-optimizer.yaml", "schemaVersion: 1\n");
    expect(await cli().run("lint", "--init")).toBe(2);
  });
});

describe("--explain, --list-rules, and --print-config", () => {
  it("explains a rule", async () => {
    const c = cli();
    expect(await c.run("lint", "--explain", "workflow/job-timeout")).toBe(0);
    const rule = allRules.find((candidate) => candidate.meta.id === "workflow/job-timeout");
    expect(c.stdout.split("\n")[0]).toBe("workflow/job-timeout");
    expect(c.stdout).toContain("Severity:  warn (default: warn)");
    expect(c.stdout).toContain(rule?.meta.rationale);
    expect(c.stdout).toContain("Before:");
    expect(c.stdout).toContain("Docs: https://github.com/MSFT-TKENDRICK/ci-cd-optimizer/blob/main/docs/rules.md#");
    const effective = cli();
    await effective.run("lint", "--explain", "workflow/job-timeout", "--rule", "workflow/job-timeout=error");
    expect(effective.stdout).toContain("Severity:  error (default: warn)");
    const meta = cli();
    expect(await meta.run("lint", "--explain", UNUSED_DIRECTIVE_RULE_ID)).toBe(0);
    expect(meta.stdout).toContain("docs/linter.md#suppressions");
  });

  it("rejects unknown rules and combined actions", async () => {
    const c = cli();
    expect(await c.run("lint", "--explain", "workflow/job-timout")).toBe(2);
    expect(c.stderr).toContain('Did you mean "workflow/job-timeout"?');
    expect(await cli().run("lint", "--explain", "workflow/job-timeout", "--list-rules")).toBe(2);
  });

  it("lists rules like the rules command", async () => {
    const list = cli();
    expect(await list.run("lint", "--list-rules")).toBe(0);
    expect(list.stdout.trim().split("\n")).toHaveLength(allRules.length);
    const rules = cli();
    await rules.run("rules");
    expect(list.stdout).toBe(rules.stdout);
  });

  it("prints the effective configuration", async () => {
    const c = cli();
    expect(await c.run("lint", "--print-config", "--rule", "workflow/job-timeout=error", "--ruleset", "caching=off")).toBe(0);
    const printed = JSON.parse(c.stdout) as { configPath: string | null; config: { extends: string[] }; rules: Record<string, string> };
    expect(printed.configPath).toBeNull();
    expect(printed.config.extends).toEqual(["recommended"]);
    expect(printed.rules["workflow/job-timeout"]).toBe("error");
    expect(printed.rules["caching/setup-cache"]).toBe("off");
    expect(Object.keys(printed.rules)).toHaveLength(allRules.length);
    await write(CONFIG, "schemaVersion: 1\nextends: [strict]\n");
    const configured = cli();
    await configured.run("lint", "--print-config", "--preset", "github");
    const withFile = JSON.parse(configured.stdout) as typeof printed;
    expect(withFile.configPath).toContain("ci-cd-optimizer.yml");
    expect(withFile.config.extends).toEqual(["github"]);
  });
});

describe("stylish output", () => {
  it("ends with links to the docs for each rule that reported", async () => {
    await write(WORKFLOW, MISSING_TIMEOUT);
    const c = cli();
    await c.run("lint");
    const footer = c.stdout.slice(c.stdout.indexOf("Rule docs:"));
    expect(footer).toMatch(/^Rule docs:\n {2}workflow\/job-timeout {2}https:\/\/\S+docs\/rules\.md#\S+/);
    await write(WORKFLOW, CLEAN);
    const clean = cli();
    await clean.run("lint");
    expect(clean.stdout).not.toContain("Rule docs:");
  });
});

describe("packaging", () => {
  it("ships cicd-lint as shorthand for `ci-cd-optimizer lint`", async () => {
    const source = await readFile(join(REPO_ROOT, "src/lint-bin.ts"), "utf8");
    expect(source).toMatch(/^#!\/usr\/bin\/env node\r?\n/);
    expect(source).toContain('run(["lint", ...process.argv.slice(2)]');
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.bin).toMatchObject({ "ci-cd-optimizer": "dist/bin.js", "cicd-lint": "dist/lint-bin.js" });
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "action.yml"]));
    expect(pkg.scripts.prepack).toBe("npm run build");
  });

  it("defines a pre-commit hook for the files the linter reads", async () => {
    const hooks = parseYaml(await readFile(join(REPO_ROOT, ".pre-commit-hooks.yaml"), "utf8")) as Record<string, unknown>[];
    expect(hooks).toEqual([expect.objectContaining({ id: "cicd-lint", entry: "scripts/cicd-lint-hook.mjs", language: "script", pass_filenames: false })]);
    const files = new RegExp(String(hooks[0]?.files));
    for (const path of [WORKFLOW, "action.yml", "sub/action.yaml", "Dockerfile", "api.Dockerfile", "docker/Dockerfile.prod", "Containerfile", "package.json", "web/package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
      expect(files.test(path), path).toBe(true);
    }
    for (const path of ["src/index.ts", "README.md", ".github/workflows/nested/x.yml", "docs/workflows/ci.yml"]) {
      expect(files.test(path), path).toBe(false);
    }
  });

  it("runs the pre-commit hook script as `cicd-lint` from the committed Action bundle", { timeout: 60_000 }, async () => {
    const hook = join(REPO_ROOT, "scripts/cicd-lint-hook.mjs");
    expect(await readFile(hook, "utf8")).toMatch(/^#!\/usr\/bin\/env node\r?\n/);
    await write(WORKFLOW, MISSING_TIMEOUT);
    const exec = (...args: string[]) =>
      new Promise<{ code: number; stdout: string }>((resolve) => {
        execFile(process.execPath, [hook, ...args], { cwd: root }, (error, stdout) => resolve({ code: error ? Number(error.code) : 0, stdout }));
      });
    const failing = await exec("--format", "json", "--fail-on", "warn");
    expect(failing.code).toBe(1);
    expect(result(failing.stdout).diagnostics.map((d) => d.ruleId)).toEqual(["workflow/job-timeout"]);
    expect((await exec("--fail-on", "error")).code).toBe(0);
  });
});

describe("repository dogfood", () => {
  it("lints the repository's own workflows and action without errors", { timeout: 120_000 }, async () => {
    const c = cli({ cwd: REPO_ROOT });
    const code = await c.run("lint", "--root", REPO_ROOT, ".github/workflows/*.yml", "action.yml", "-f", "json", "--fail-on", "error");
    const linted = result(c.stdout);
    expect(linted.parseProblems).toEqual([]);
    expect(linted.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(code).toBe(0);
    expect(c.stderr).not.toContain("No lintable files matched");
    const reusable = parseYaml(await readFile(join(REPO_ROOT, ".github/workflows/lint-reusable.yml"), "utf8"));
    expect(reusable.on.workflow_call).toBeDefined();
    expect(reusable.permissions).toEqual({ contents: "read" });
  });
});
