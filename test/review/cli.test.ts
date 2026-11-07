import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/index.js";
import type { CliIO } from "../../src/cli/io.js";
import type { GitHubClient } from "../../src/github/client.js";
import { serializeIntakeArtifact } from "../../src/review/intake.js";
import type { ReviewReport } from "../../src/review/report.js";
import { HEAD_SHA, NEW_HEAD_SHA, PROJECT_YAML, REGISTRY_NAME, STRICT_PROJECT_YAML, submitted, world } from "./fixtures.js";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cicd-review-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(path: string, content: string): Promise<string> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
  return path;
}

function cli(client?: GitHubClient, cwd = root) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { cwd, env: {}, stdout: (text) => out.push(text), stderr: (text) => err.push(text), ...(client ? { github: () => client } : {}) };
  return {
    run: (...argv: string[]) => run(argv, io),
    get stdout() {
      return out.join("\n");
    },
    get stderr() {
      return err.join("\n");
    },
  };
}

describe("review CLI", () => {
  it("documents the review command", async () => {
    const help = cli();
    expect(await help.run("help")).toBe(0);
    expect(help.stdout).toContain("review");
    const review = cli();
    expect(await review.run("review", "--help")).toBe(0);
    expect(review.stdout).toContain("Usage: ci-cd-optimizer review <command>");
    expect(await cli().run("review", "bogus")).toBe(2);
  });

  describe("validate", () => {
    it("accepts this repository's own registration", async () => {
      const c = cli(undefined, process.cwd());
      expect(await c.run("review", "validate", "projects/ci-cd-optimizer/project.yaml")).toBe(0);
      expect(c.stdout).toBe("projects/ci-cd-optimizer/project.yaml: ok");
    });

    it("reports schema problems with exit code 1", async () => {
      const good = await write("projects/widget/project.yaml", PROJECT_YAML);
      const bad = await write("projects/gadget/project.yaml", PROJECT_YAML);
      const c = cli();
      expect(await c.run("review", "validate", good, bad)).toBe(1);
      expect(c.stdout).toContain(`${good}: ok`);
      expect(c.stdout).toContain(`${bad}: invalid`);
      expect(c.stdout).toMatch(/must equal its directory name/);
    });

    it("rejects oversized files without parsing them", async () => {
      const path = await write("projects/widget/project.yaml", `${PROJECT_YAML}#${"x".repeat(9000)}\n`);
      const c = cli();
      expect(await c.run("review", "validate", path)).toBe(1);
      expect(c.stdout).toContain("the limit is 8192 bytes");
    });

    it("refuses files that are not named project.yaml", async () => {
      const path = await write("projects/widget/project.yml", PROJECT_YAML);
      expect(await cli().run("review", "validate", path)).toBe(2);
      expect(await cli().run("review", "validate")).toBe(2);
      expect(await cli().run("review", "validate", "projects/missing/project.yaml")).toBe(2);
    });
  });

  describe("intake-artifact", () => {
    it("prints step outputs for a valid record", async () => {
      const path = await write("intake.json", serializeIntakeArtifact({ pr_number: 7, head_sha: HEAD_SHA }));
      const c = cli();
      expect(await c.run("review", "intake-artifact", path, "--expected-sha", HEAD_SHA)).toBe(0);
      expect(c.stdout).toBe(`pr_number=7\nhead_sha=${HEAD_SHA}`);
    });

    it.each([
      ["a SHA mismatch", serializeIntakeArtifact({ pr_number: 7, head_sha: HEAD_SHA }), NEW_HEAD_SHA, "names a different commit"],
      ["extra keys", `{"pr_number":7,"head_sha":"${HEAD_SHA}","x":1}`, HEAD_SHA, "exactly pr_number and head_sha"],
      ["an oversized record", " ".repeat(2048), HEAD_SHA, "larger than 1024 bytes"],
      ["an injected output line", `{"pr_number":7,"head_sha":"${HEAD_SHA}\\nx=1"}`, HEAD_SHA, "head_sha must be 40 lowercase hex"],
    ])("rejects %s", async (_label, text, expected, message) => {
      const path = await write("intake.json", text);
      const c = cli();
      expect(await c.run("review", "intake-artifact", path, "--expected-sha", expected)).toBe(1);
      expect(c.stdout).toBe("");
      expect(c.stderr).toContain(message);
    });

    it("rejects a missing record and missing options", async () => {
      expect(await cli().run("review", "intake-artifact", "absent.json", "--expected-sha", HEAD_SHA)).toBe(1);
      const path = await write("intake.json", "{}");
      expect(await cli().run("review", "intake-artifact", path)).toBe(2);
    });
  });

  describe("run", () => {
    it("prints every finding by default and withholds sensitive ones with --public", async () => {
      const path = await write("projects/widget/project.yaml", STRICT_PROJECT_YAML);
      const full = cli(world());
      expect(await full.run("review", "run", path, "--format", "json", "--author", "octocat")).toBe(0);
      const report = JSON.parse(full.stdout) as ReviewReport;
      expect(report).toMatchObject({ schemaVersion: 1, project: "widget", status: "ok", redacted: { count: 0 } });
      expect(report.findings.map((finding) => finding.ruleId)).toContain("hermeticity/pin-actions");

      const pub = cli(world());
      expect(await pub.run("review", "run", path, "--public")).toBe(0);
      expect(pub.stdout).toContain("<!-- ci-cd-optimizer-review:widget -->");
      expect(pub.stdout).toContain("withheld from this public report");
      expect(pub.stdout).not.toContain("hermeticity/pin-actions");
    });

    it("exits 1 when consent is missing", async () => {
      const path = await write("projects/widget/project.yaml", PROJECT_YAML);
      const c = cli(world({ consent: undefined }));
      expect(await c.run("review", "run", path, "--format", "json")).toBe(1);
      expect(JSON.parse(c.stdout)).toMatchObject({ status: "consent-failed", findings: [] });
    });

    it("validates its options", async () => {
      const path = await write("projects/widget/project.yaml", PROJECT_YAML);
      expect(await cli(world()).run("review", "run", path, "--format", "sarif")).toBe(2);
      expect(await cli(world()).run("review", "run", path, "--registry", "not a repo")).toBe(2);
      expect(await cli(world()).run("review", "run")).toBe(2);
    });
  });

  describe("intake", () => {
    it("reviews the submission and upserts one marker comment", async () => {
      const client = world({ registryFiles: submitted() });
      const c = cli(client);
      expect(await c.run("review", "intake", "--pr", "7", "--repo", REGISTRY_NAME, "--head-sha", HEAD_SHA, "--comment")).toBe(0);
      expect(c.stdout).toContain("<!-- ci-cd-optimizer-review:widget -->");
      expect(c.stderr).toContain("review comment created on #7");
      const writes = client.calls.filter((call) => !call.route.startsWith("GET "));
      expect(writes).toHaveLength(1);
      expect(writes[0]?.route).toBe("POST /repos/{owner}/{repo}/issues/{issue_number}/comments");
      expect(writes[0]?.parameters).toMatchObject({ owner: "MSFT-TKENDRICK", repo: "ci-cd-optimizer", issue_number: 7 });
    });

    it("writes the hand-off record only for a known head", async () => {
      const c = cli(world({ registryFiles: submitted() }));
      expect(await c.run("review", "intake", "--pr", "7", "--repo", REGISTRY_NAME, "--artifact", "out/intake.json", "--output", "out/summary.md")).toBe(0);
      expect((await readFile(join(root, "out/intake.json"), "utf8")).trim()).toBe(serializeIntakeArtifact({ pr_number: 7, head_sha: HEAD_SHA }));
      expect(await readFile(join(root, "out/summary.md"), "utf8")).toContain("CI/CD optimizer review: widget");
    });

    it("does not comment when the head moved", async () => {
      const client = world({ registryFiles: submitted() });
      expect(await cli(client).run("review", "intake", "--pr", "7", "--repo", REGISTRY_NAME, "--head-sha", NEW_HEAD_SHA, "--comment")).toBe(1);
      expect(client.calls.some((call) => !call.route.startsWith("GET "))).toBe(false);
    });

    it.each([
      [["--pr", "0"]],
      [["--pr", "7e1"]],
      [["--pr", "7", "--head-sha", "ABC"]],
      [["--pr", "7", "--head-sha", "A".repeat(40)]],
      [[]],
    ])("rejects bad options %j", async (args) => {
      expect(await cli(world()).run("review", "intake", "--repo", REGISTRY_NAME, ...args)).toBe(2);
    });
  });

  describe("scheduled", () => {
    it("summarizes every registered project and fails on invalid ones", async () => {
      await write("projects/widget/project.yaml", PROJECT_YAML);
      await write("projects/broken/project.yaml", "name: other\n");
      await write("projects/empty/.keep", "");
      await write("projects/schema.json", "{}");
      const client = world();
      const c = cli(client);
      expect(await c.run("review", "scheduled")).toBe(1);
      expect(c.stdout).toContain("2 registered projects reviewed.");
      expect(c.stdout).toContain("| widget | ok |");
      expect(c.stdout).toContain("| broken | invalid |");
      expect(client.calls.some((call) => !call.route.startsWith("GET "))).toBe(false);
    });

    it("succeeds when every project is healthy", async () => {
      await write("registry/widget/project.yaml", PROJECT_YAML);
      const c = cli(world());
      expect(await c.run("review", "scheduled", "--dir", "registry")).toBe(0);
      expect(c.stdout).toContain("1 registered project reviewed.");
    });
  });
});
