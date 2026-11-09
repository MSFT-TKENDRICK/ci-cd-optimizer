import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { VERSION } from "../../src/version.js";

const repo = join(import.meta.dirname, "..", "..");
const plugin = join(repo, "plugins", "ci-cd-optimizer");
const bundle = join(plugin, "server", "cicd-agents.mjs");
const json = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

async function frontmatter(path: string): Promise<Record<string, unknown>> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(await readFile(path, "utf8"));
  expect(match, `${path} has YAML frontmatter`).not.toBeNull();
  return parse(match?.[1] ?? "") as Record<string, unknown>;
}

describe("agent plugin", () => {
  it("keeps the plugin, marketplace, and package versions in step", async () => {
    const manifest = await json(join(plugin, "plugin.json"));
    const marketplace = await json(join(repo, ".github", "plugin", "marketplace.json"));
    const entries = marketplace.plugins as { name: string; source: string; version: string }[];
    expect(manifest).toMatchObject({ name: "ci-cd-optimizer", version: VERSION });
    expect(entries).toEqual([expect.objectContaining({ name: "ci-cd-optimizer", source: "./plugins/ci-cd-optimizer", version: VERSION })]);
    expect((await json(join(repo, "package.json"))).version).toBe(VERSION);
  });

  it("starts the bundled server through PLUGIN_ROOT", async () => {
    const config = (await json(join(plugin, "mcp.json"))).mcpServers as Record<string, { command: string; args: string[] }>;
    expect(config["ci-cd-optimizer"]).toEqual({ type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server/cicd-agents.mjs", "mcp"] });
    expect((await stat(bundle)).isFile()).toBe(true);
  });

  it("ships skills whose names match their directories", async () => {
    const skills = (await readdir(join(plugin, "skills"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    expect(skills.sort()).toEqual(["analyze-ci-run", "optimize-ci-pipeline", "triage-cicd-findings"]);
    for (const skill of skills) {
      const meta = await frontmatter(join(plugin, "skills", skill, "SKILL.md"));
      expect(meta.name).toBe(skill);
      expect(meta.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(typeof meta.description === "string" && meta.description.length > 50 && meta.description.length <= 1024).toBe(true);
    }
  });

  it("ships a custom agent that can call the plugin's MCP tools", async () => {
    const meta = await frontmatter(join(plugin, "com.github.copilot", "agents", "ci-cd-optimizer.agent.md"));
    expect(meta).toMatchObject({ name: "ci-cd-optimizer", tools: expect.arrayContaining(["ci-cd-optimizer/*"]) });
  });

  it("runs the committed bundle without an install", async () => {
    const run = (args: string[]) => promisify(execFile)(process.execPath, [bundle, ...args], { cwd: repo, timeout: 30_000 });
    expect((await run(["--version"])).stdout.trim()).toBe(VERSION);
    expect((await run(["mcp", "--help"])).stdout).toContain("Usage: cicd-mcp");
    expect((await run(["acp", "--version"])).stdout.trim()).toBe(VERSION);
    await expect(run(["bogus"])).rejects.toMatchObject({ code: 2 });
  }, 60_000);
});
