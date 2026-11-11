import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { acpCommand, ACP_USAGE, MCP_USAGE, mcpCommand, type AgentIO } from "../../src/agents/cli.js";
import { normalizeRepository, sanitizeMarkdown } from "../../src/agents/remote.js";
import { AgentError } from "../../src/agents/workspace.js";
import type { GitHubClient } from "../../src/github/client.js";
import { tempDirs } from "./helpers.js";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const fakeClient = {} as GitHubClient;
const io = (env: Record<string, string | undefined> = {}, cwd = process.cwd()): AgentIO => ({ cwd, env, github: () => fakeClient });

describe("cicd-mcp arguments", () => {
  it("prints help and version", async () => {
    expect(await mcpCommand(["--help"], io())).toEqual({ kind: "help", text: MCP_USAGE });
    expect(await mcpCommand(["-v"], io())).toEqual({ kind: "version" });
    expect(MCP_USAGE).toContain('"root" argument');
  });

  it("serves the current directory by default, without remote tools", async () => {
    const cwd = await dirs.make();
    expect(await mcpCommand([], io({}, cwd))).toEqual({ kind: "serve", fallbackRoot: cwd, notices: [] });
  });

  it("resolves --root and reads the plugin directory from the environment", async () => {
    const root = await dirs.make();
    const command = await mcpCommand(["--root", root], io({ PLUGIN_ROOT: "/plugins/x" }));
    expect(command).toMatchObject({ kind: "serve", root, pluginRoot: "/plugins/x" });
    expect(await mcpCommand([], io({ CICD_OPTIMIZER_PLUGIN_ROOT: "/a", PLUGIN_ROOT: "/b" }))).toMatchObject({ pluginRoot: "/a" });
    await expect(mcpCommand(["--root", join(root, "missing")], io())).rejects.toBeInstanceOf(AgentError);
  });

  it("rejects unknown options, positionals, and --repo without --enable-remote", async () => {
    await expect(mcpCommand(["--bogus"], io())).rejects.toMatchObject({ code: expect.stringMatching(/^ERR_PARSE_ARGS/) });
    await expect(mcpCommand(["somewhere"], io())).rejects.toMatchObject({ code: expect.stringMatching(/^ERR_PARSE_ARGS/) });
    await expect(mcpCommand(["--repo", "a/b"], io({ GITHUB_TOKEN: "t" }))).rejects.toThrow("--repo only applies with --enable-remote.");
  });

  it("fails closed if opt-in lacks a token and never exposes ambient tokens alone", async () => {
    await expect(mcpCommand(["--enable-remote", "--repo", "a/b"], io())).rejects.toThrow("requires GITHUB_TOKEN or GH_TOKEN");
    const command = await mcpCommand([], io({ GITHUB_TOKEN: "ambient-token" }));
    expect(command).not.toHaveProperty("remote");
  });

  it("enables GitHub tools for a normalized, de-duplicated allowlist", async () => {
    const command = await mcpCommand(["--enable-remote", "--repo", "Octo/Repo", "--repo", "octo/repo.git", "--repo", "x/y"], io({ GH_TOKEN: "t" }));
    expect(command).toMatchObject({ kind: "serve", remote: { createClient: expect.any(Function), repositoryIds: new Map(), allow: ["octo/repo", "x/y"] } });
    if (command.kind === "serve") expect(command.remote?.createClient(new AbortController().signal)).toBe(fakeClient);
    expect(command).toMatchObject({ notices: ["GitHub tools enabled (read-only, dry run) for: octo/repo, x/y."] });
    await expect(mcpCommand(["--enable-remote", "--repo", "not a repo"], io({ GH_TOKEN: "t" }))).rejects.toThrow("is not an owner/repo name");
  });

  it("requires an explicit allowlist even when a workspace or ambient server URL is given", async () => {
    const root = await dirs.make();
    await expect(mcpCommand(["--enable-remote", "--root", root], io({ GITHUB_TOKEN: "t" }))).rejects.toThrow("explicit --repo");
    await expect(mcpCommand(["--enable-remote"], io({ GITHUB_TOKEN: "t", GITHUB_SERVER_URL: "https://ghe.example.com" }))).rejects.toThrow("explicit --repo");
  });

  it("only watches with an explicit bounded replay scope and remote authorization", async () => {
    const since = new Date(Date.now() - 60000).toISOString();
    const args = ["--enable-remote", "--repo", "a/b", "--watch", "--since", since];
    expect(await mcpCommand(args, io({ GH_TOKEN: "t" }))).toMatchObject({ feedback: { since } });
    await expect(mcpCommand(["--watch", "--since", since], io({ GH_TOKEN: "t" }))).rejects.toThrow(/--watch requires/);
    await expect(mcpCommand(args.slice(0, -1).concat("2000-01-01T00:00:00Z"), io({ GH_TOKEN: "t" }))).rejects.toThrow(/seven days/);
  });

  it("uses gh credentials only by explicit opt-in and never falls back after failure", async () => {
    let reads = 0;
    const input = { ...io({ GH_TOKEN: "ambient" }), githubCliToken: async () => { reads++; return "explicit"; } };
    await mcpCommand(["--enable-remote", "--repo", "a/b"], input);
    expect(reads).toBe(0);
    await mcpCommand(["--enable-remote", "--repo", "a/b", "--github-cli-auth"], input);
    expect(reads).toBe(1);
    input.githubCliToken = async () => { throw new Error("No login"); };
    await expect(mcpCommand(["--enable-remote", "--repo", "a/b", "--github-cli-auth"], input)).rejects.toThrow(/no alternate/);
  });
});

describe("cicd-acp arguments", () => {
  it("prints help and version, serves by default, and rejects unknown options", () => {
    expect(acpCommand(["-h"])).toEqual({ kind: "help", text: ACP_USAGE });
    expect(acpCommand(["--version"])).toEqual({ kind: "version" });
    expect(acpCommand([])).toEqual({ kind: "serve-acp" });
    expect(() => acpCommand(["--root", "x"])).toThrow(expect.objectContaining({ code: expect.stringMatching(/^ERR_PARSE_ARGS/) }));
    expect(ACP_USAGE).toContain("/fix-preview");
  });
});

describe("remote helpers", () => {
  it("normalizes repository names and rejects invalid ones", () => {
    expect(normalizeRepository(" Octo/Repo.git ")).toBe("octo/repo");
    expect(normalizeRepository("a-b/c.d_e")).toBe("a-b/c.d_e");
    for (const bad of ["octo", "octo/repo/x", "-octo/repo", "octo/..", "../repo", "octo/re po", ""]) {
      expect(() => normalizeRepository(bad)).toThrow(AgentError);
    }
  });

  it("strips control and bidi characters and truncates long text", () => {
    expect(sanitizeMarkdown("a\u0000b\u001bc\u202ed\u2066e\nf\tg")).toEqual({ text: "abcde\nf\tg", truncated: false, omittedCharacters: 0 });
    const long = sanitizeMarkdown("x".repeat(20), 10);
    expect(long).toEqual({ text: `${"x".repeat(10)}\n\n… (10 characters omitted)`, truncated: true, omittedCharacters: 10 });
  });
});
