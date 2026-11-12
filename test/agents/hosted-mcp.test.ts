import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHostedMcp, hostedMcpFromEnv } from "../../src/agents/hosted-mcp.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function serve() {
  const calls: string[] = [];
  const hosted = createHostedMcp({
    auth: "github-user", repositories: new Map([["acme/widgets", 42]]),
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === "/user" && new Headers(init?.headers).get("authorization") === "Bearer user") return Response.json({ id: 1, type: "User" });
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    },
  });
  const server = createServer((request, response) => void hosted.handle(request, response).then((handled) => { if (!handled) response.writeHead(404).end(); }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  cleanup.push(async () => { await hosted.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls };
}

describe("hosted MCP", () => {
  it("fails closed unless explicitly configured with pinned repositories", async () => {
    expect(hostedMcpFromEnv({ GITHUB_TOKEN: "ambient" })).toBeUndefined();
    expect(() => hostedMcpFromEnv({ CICD_OPTIMIZER_MCP: "yes" })).toThrow();
    expect(() => hostedMcpFromEnv({ CICD_OPTIMIZER_MCP: "true" })).toThrow("github-user");
    expect(() => hostedMcpFromEnv({ CICD_OPTIMIZER_MCP: "true", CICD_OPTIMIZER_MCP_AUTH: "github-user" })).toThrow("pinned");
    for (const entry of ["acme/widgets", "acme/widgets:0", "acme/widgets:9007199254740992", "acme/widgets:42,ACME/widgets:42"]) {
      expect(() => hostedMcpFromEnv({ CICD_OPTIMIZER_MCP: "true", CICD_OPTIMIZER_MCP_AUTH: "github-user", CICD_OPTIMIZER_MCP_REPOSITORIES: entry })).toThrow();
    }
  });

  it("authenticates every request and never exposes local filesystem tools", async () => {
    const { url, calls } = await serve();
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    const headers = { authorization: "Bearer user", "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await fetch(url, { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
    for (const body of ["[{}]", "{", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "write_file" }), JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(129), method: "tools/list" })]) {
      expect((await fetch(url, { method: "POST", headers, body })).status).toBe(400);
    }
    expect((await fetch(url, { method: "GET", headers })).status).toBe(405);
    const send = async (id: number, method: string, params: unknown) => {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      expect(response.status).toBe(200);
      return await response.json() as { result: Record<string, unknown> };
    };
    const init = await send(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result).toHaveProperty("serverInfo");
    const list = await send(2, "tools/list", {});
    const tools = list.result.tools as Array<{ name: string; _meta?: unknown }>;
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("workflow_run_report");
    expect(tools.find((tool) => tool.name === "dashboard_metrics")?._meta).toMatchObject({
      ui: { resourceUri: "ui://ci-cd-optimizer/dashboard.html" },
    });
    expect(names).not.toContain("lint");
    const local = await send(3, "tools/call", { name: "lint", arguments: { root: "/" } });
    expect(local).toHaveProperty("error");
    const app = await send(4, "resources/read", { uri: "ui://ci-cd-optimizer/dashboard.html" });
    expect((app.result.contents as unknown[])[0]).toMatchObject({
      mimeType: "text/html;profile=mcp-app", text: expect.stringContaining("<html"),
    });
    const denied = await send(5, "tools/call", { name: "dashboard_metrics", arguments: { repo: "other/repo", runId: 1 } });
    expect(denied.result).toMatchObject({ isError: true });
    expect(calls.every((path) => path === "/user")).toBe(true);
  });
});
