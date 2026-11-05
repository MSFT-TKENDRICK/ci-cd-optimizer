import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/index.js";
import { MAX_EXECUTION_BYTES, parseExecutionReport } from "../../src/knowledge/execution.js";
import { readExecutionJson } from "../../src/telemetry/execution-capture.js";

describe("explicit runner execution capture", () => {
  let directory: string | undefined;
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

  it("captures a real child exit, checkout and Node version without persisting command or environment", async () => {
    directory = await mkdtemp(join(tmpdir(), "execution-capture-"));
    const output = join(directory, "report.json");
    const observations = join(directory, "observations.json");
    await writeFile(observations, JSON.stringify({
      tools: [{ name: "nx", version: "20.1.0", basis: "workflow-report" }],
      caches: [{ tool: "nx", result: "miss" }], secret: "do-not-store",
    }));
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = { cwd: process.cwd(), env: {
      GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY_ID: "42", GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: sha, GITHUB_JOB: "build", PRIVATE_VALUE: "do-not-store",
    }, stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) };
    const command = ["execution", "capture", "--project", ".", "--task", "build", "--output", output, "--observations", observations,
      "--", process.execPath, "-e", "const sensitiveArgument = 'do-not-store'; process.exit(7);"];
    expect(await run(command, io)).toBe(7);
    expect(stderr).toEqual([]);
    const text = await readFile(output, "utf8");
    const report = parseExecutionReport(JSON.parse(text));
    expect(report).toMatchObject({ checkoutSha: sha, exitCode: 7, signal: null, coverage: "single-command", projectPath: "." });
    expect(report.tools).toContainEqual({ name: "node", version: process.version, basis: "recorder-runtime" });
    expect(report.caches).toEqual([{ tool: "nx", result: "miss", basis: "workflow-report" }]);
    expect(text).not.toContain("do-not-store");
    expect(await run(command, io)).toBe(1);
    expect(stderr.join("\n")).toContain("already exists");
    expect(await readFile(output, "utf8")).toBe(text);
  });

  it("bounds file reads and rejects malformed reports without creating database connections", async () => {
    directory = await mkdtemp(join(tmpdir(), "execution-capture-"));
    const path = join(directory, "oversized.json");
    await writeFile(path, " ".repeat(MAX_EXECUTION_BYTES + 1));
    await expect(readExecutionJson(path)).rejects.toThrow("exceeds");
    await writeFile(path, "{broken");
    await expect(readExecutionJson(path)).rejects.toThrow();
  });
});
