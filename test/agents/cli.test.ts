import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { acpCommand, ACP_USAGE, MCP_USAGE, mcpCommand, type AgentIO } from "../../src/agents/cli.js";
import { normalizeRepository, parseRemoteUrl, sanitizeMarkdown } from "../../src/agents/remote.js";
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

  it("keeps GitHub tools off without a token, and says how to enable them", async () => {
    const command = await mcpCommand(["--enable-remote", "--repo", "a/b"], io());
    expect(command).not.toHaveProperty("remote");
    expect(command).toMatchObject({ notices: [expect.stringContaining("set GITHUB_TOKEN or GH_TOKEN")] });
  });

  it("enables GitHub tools for a normalized, de-duplicated allowlist", async () => {
    const command = await mcpCommand(["--enable-remote", "--repo", "Octo/Repo", "--repo", "octo/repo.git", "--repo", "x/y"], io({ GH_TOKEN: "t" }));
    expect(command).toMatchObject({ kind: "serve", remote: { client: fakeClient, serverUrl: "https://github.com", allow: ["octo/repo", "x/y"] } });
    expect(command).toMatchObject({ notices: ["GitHub tools enabled (read-only, dry run) for: octo/repo, x/y."] });
    await expect(mcpCommand(["--enable-remote", "--repo", "not a repo"], io({ GH_TOKEN: "t" }))).rejects.toThrow("is not an owner/repo name");
  });

  it("uses the workspace origin when --root has one, and disables GitHub tools when it does not", async () => {
    const root = await dirs.make();
    const noOrigin = await mcpCommand(["--enable-remote", "--root", root], io({ GITHUB_TOKEN: "t" }));
    expect(noOrigin).not.toHaveProperty("remote");
    expect(noOrigin).toMatchObject({ notices: [expect.stringContaining("no GitHub origin remote")] });
    const deferred = await mcpCommand(["--enable-remote"], io({ GITHUB_TOKEN: "t", GITHUB_SERVER_URL: "https://ghe.example.com" }));
    expect(deferred).toMatchObject({ remote: { serverUrl: "https://ghe.example.com" }, notices: [expect.stringContaining("resolved on first use")] });
    expect(deferred).not.toHaveProperty("remote.allow");
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
  it("parses GitHub origin URLs in scp, ssh, and https forms", () => {
    expect(parseRemoteUrl("git@github.com:Octo/Repo.git")).toBe("octo/repo");
    expect(parseRemoteUrl("ssh://git@github.com/octo/repo.git")).toBe("octo/repo");
    expect(parseRemoteUrl("https://github.com/octo/repo")).toBe("octo/repo");
    expect(parseRemoteUrl("https://token@github.com/octo/repo.git/")).toBe("octo/repo");
    expect(parseRemoteUrl("https://ghe.example.com/octo/repo", "https://ghe.example.com")).toBe("octo/repo");
  });

  it("ignores other hosts, deeper paths, and garbage", () => {
    expect(parseRemoteUrl("https://gitlab.com/octo/repo")).toBeUndefined();
    expect(parseRemoteUrl("git@github.com.evil.com:octo/repo.git")).toBeUndefined();
    expect(parseRemoteUrl("https://github.com/octo/repo/tree/main")).toBeUndefined();
    expect(parseRemoteUrl("C:\\src\\repo")).toBeUndefined();
    expect(parseRemoteUrl("")).toBeUndefined();
    expect(parseRemoteUrl("not a url")).toBeUndefined();
  });

  it("normalizes repository names and rejects invalid ones", () => {
    expect(normalizeRepository(" Octo/Repo.git ")).toBe("octo/repo");
    expect(normalizeRepository("a-b/c.d_e")).toBe("a-b/c.d_e");
    for (const bad of ["octo", "octo/repo/x", "-octo/repo", "octo/..", "../repo", "octo/re po", ""]) {
      expect(() => normalizeRepository(bad)).toThrow(AgentError);
    }
  });

  it("strips control and bidi characters and truncates long text", () => {
    expect(sanitizeMarkdown("a\u0000b\u001bc\u202ed\u2066e\nf\tg")).toEqual({ text: "abcde\nf\tg", truncated: false });
    const long = sanitizeMarkdown("x".repeat(20), 10);
    expect(long).toEqual({ text: `${"x".repeat(10)}\n\n… (truncated)`, truncated: true });
  });
});
