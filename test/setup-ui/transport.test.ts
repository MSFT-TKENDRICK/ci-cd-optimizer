import { describe, expect, it, vi } from "vitest";
import {
  SESSION_STORAGE_KEY,
  SetupApiError,
  createHttpTransport,
  createMcpTransport,
  textOf,
  type HttpEnvironment,
  type McpHost,
  type ToolResult,
} from "@/lib/transport";
import { MCP_TOOLS } from "@/lib/types";
import { makeState } from "./fixtures";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function httpEnvironment(options: { href?: string; stored?: string; respond?: (path: string, init: RequestInit) => Response | Promise<Response>; storageFails?: boolean } = {}) {
  const store = new Map<string, string>();
  if (options.stored) store.set(SESSION_STORAGE_KEY, options.stored);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (options.respond ?? (() => json(makeState())))(String(input), init ?? {}));
  const replaceState = vi.fn();
  const env: HttpEnvironment = {
    fetch: fetchMock as unknown as typeof fetch,
    location: { href: options.href ?? "http://127.0.0.1:4000/" },
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        if (options.storageFails) throw new Error("Storage is blocked.");
        store.set(key, value);
      },
    },
    history: { replaceState },
  };
  return { env, store, replaceState, fetchMock };
}

const lastRequest = (mock: ReturnType<typeof httpEnvironment>["fetchMock"]) => {
  const [path, init] = mock.mock.calls.at(-1) ?? [];
  return { path: String(path), init: init ?? {}, headers: new Headers(init?.headers) };
};

describe("HTTP transport", () => {
  it("only the loopback page may collect secrets, and it opens links natively", () => {
    const transport = createHttpTransport(httpEnvironment().env);
    expect(transport.kind).toBe("http");
    expect(transport.canEnterSecrets).toBe(true);
    expect(transport.openExternal).toBeUndefined();
  });

  it("takes the session from the launch link, remembers it for this tab, and clears it from the address bar", () => {
    const { env, store, replaceState } = httpEnvironment({ href: "http://127.0.0.1:4000/?session=abc123&scoutTheme=dark#top" });
    createHttpTransport(env);
    expect(store.get(SESSION_STORAGE_KEY)).toBe("abc123");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?scoutTheme=dark#top");
  });

  it("sends the session in a header, never in the URL, with caching disabled", async () => {
    const { env, fetchMock } = httpEnvironment({ href: "http://127.0.0.1:4000/?session=abc123" });
    await createHttpTransport(env).getState();
    const { path, init, headers } = lastRequest(fetchMock);
    expect(path).toBe("/api/state");
    expect(path).not.toContain("abc123");
    expect(headers.get("X-Setup-Session")).toBe("abc123");
    expect(headers.get("Accept")).toBe("application/json");
    expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin" });
  });

  it("keeps working after a reload by reading the stored session", async () => {
    const { env, fetchMock, replaceState } = httpEnvironment({ stored: "stored-session" });
    await createHttpTransport(env).getState();
    expect(lastRequest(fetchMock).headers.get("X-Setup-Session")).toBe("stored-session");
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("still works for this page load when the session cannot be stored", async () => {
    const { env, fetchMock } = httpEnvironment({ href: "http://127.0.0.1:4000/?session=abc123", storageFails: true });
    await createHttpTransport(env).getState();
    expect(lastRequest(fetchMock).headers.get("X-Setup-Session")).toBe("abc123");
  });

  it("explains how to start a session instead of calling the API without one", async () => {
    const { env, fetchMock } = httpEnvironment();
    await expect(createHttpTransport(env).getState()).rejects.toMatchObject({ name: "SetupApiError", status: 401, message: expect.stringContaining("npm run setup") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts actions as JSON with an explicit confirmation and the payload", async () => {
    const { env, fetchMock } = httpEnvironment({ href: "http://127.0.0.1:4000/?session=abc123" });
    await createHttpTransport(env).act("authorize-copilot", { token: "fake-token-value" });
    const { path, init, headers } = lastRequest(fetchMock);
    expect(path).toBe("/api/authorize-copilot");
    expect(init.method).toBe("POST");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ token: "fake-token-value", confirm: true });
  });

  it("confirms actions that carry no payload", async () => {
    const { env, fetchMock } = httpEnvironment({ href: "http://127.0.0.1:4000/?session=abc123" });
    await createHttpTransport(env).act("run-scan");
    expect(JSON.parse(String(lastRequest(fetchMock).init.body))).toEqual({ confirm: true });
  });

  it("reports an unreachable server as status 0", async () => {
    const { env } = httpEnvironment({ href: "http://127.0.0.1:4000/?session=abc123", respond: () => Promise.reject(new TypeError("fetch failed")) });
    await expect(createHttpTransport(env).getState()).rejects.toMatchObject({ status: 0, message: "Could not reach the setup server." });
  });

  it("keeps the server's message and state when it rejects a request", async () => {
    const state = makeState("install", { busy: true });
    const { env } = httpEnvironment({
      href: "http://127.0.0.1:4000/?session=abc123",
      respond: () => json({ error: "Another setup step is running. Wait for it to finish.", state }, 409),
    });
    const failure: unknown = await createHttpTransport(env).act("verify").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SetupApiError);
    expect(failure).toMatchObject({ status: 409, message: "Another setup step is running. Wait for it to finish.", state });
  });

  it("falls back to the status when the error body is not usable", async () => {
    const { env } = httpEnvironment({ href: "http://127.0.0.1:4000/?session=abc123", respond: () => new Response("<html>nope</html>", { status: 500 }) });
    await expect(createHttpTransport(env).getState()).rejects.toMatchObject({ status: 500, message: "The setup server returned 500.", state: undefined });
  });

  it("rejects a success response that is not a setup snapshot", async () => {
    const { env } = httpEnvironment({ href: "http://127.0.0.1:4000/?session=abc123", respond: () => json({ ok: true }) });
    await expect(createHttpTransport(env).getState()).rejects.toMatchObject({ status: 502, message: "The setup server returned an unexpected response." });
  });
});

const toolResult = (structuredContent: Record<string, unknown> | undefined, extra: Partial<ToolResult> = {}): ToolResult => ({
  content: [{ type: "text", text: "Done." }],
  ...(structuredContent ? { structuredContent } : {}),
  ...extra,
});

function mcpHost(options: { call?: (name: string) => Promise<ToolResult>; capabilities?: ReturnType<McpHost["getHostCapabilities"]>; openLink?: () => Promise<{ isError?: boolean }> } = {}) {
  const callServerTool = vi.fn<McpHost["callServerTool"]>(async ({ name }) => (options.call ?? (async () => toolResult({ state: makeState("install") })))(name));
  const openLink = vi.fn<McpHost["openLink"]>(async () => (options.openLink ?? (async () => ({})))());
  const getHostCapabilities = vi.fn<McpHost["getHostCapabilities"]>(() => options.capabilities);
  return { host: { callServerTool, openLink, getHostCapabilities } satisfies McpHost, callServerTool, openLink };
}

describe("MCP transport", () => {
  it("never collects secrets in chat", () => {
    const transport = createMcpTransport(mcpHost().host, "session-1");
    expect(transport.kind).toBe("mcp");
    expect(transport.canEnterSecrets).toBe(false);
  });

  it("reads state through the app-only state tool, proving the session each time", async () => {
    const { host, callServerTool } = mcpHost();
    const state = await createMcpTransport(host, "session-1").getState();
    expect(state.current).toBe("install");
    expect(callServerTool).toHaveBeenCalledWith({ name: MCP_TOOLS.state, arguments: { session: "session-1" } });
  });

  it.each([
    ["save-credentials", MCP_TOOLS["save-credentials"]],
    ["verify", MCP_TOOLS.verify],
    ["check-verification", MCP_TOOLS["check-verification"]],
    ["run-scan", MCP_TOOLS["run-scan"]],
  ] as const)("maps %s to %s with the session and an explicit confirmation", async (action, tool) => {
    const { host, callServerTool } = mcpHost();
    await createMcpTransport(host, "session-1").act(action);
    expect(callServerTool).toHaveBeenCalledWith({ name: tool, arguments: { session: "session-1", confirm: true } });
  });

  it("refuses to carry the Copilot token and never calls the host", async () => {
    const { host, callServerTool } = mcpHost();
    await expect(createMcpTransport(host, "session-1").act("authorize-copilot", { token: "fake-token-value" })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("never in chat") });
    expect(callServerTool).not.toHaveBeenCalled();
  });

  it("reports a host failure as unreachable, with a fallback message for non-errors", async () => {
    const reason = mcpHost({ call: () => Promise.reject(new Error("The connection closed.")) });
    await expect(createMcpTransport(reason.host, "session-1").getState()).rejects.toMatchObject({ status: 0, message: "The connection closed." });
    const bare = mcpHost({ call: () => Promise.reject("boom") });
    await expect(createMcpTransport(bare.host, "session-1").getState()).rejects.toMatchObject({ status: 0, message: "Copilot could not reach the setup server." });
  });

  it("keeps the tool's message, status and recorded state when a step fails", async () => {
    const state = makeState("install", { error: { step: "install", message: "The installation covers all repositories." } });
    const failing = mcpHost({
      call: async () => toolResult({ status: 502, state }, { isError: true, content: [{ type: "text", text: "The installation covers all repositories." }] }),
    });
    await expect(createMcpTransport(failing.host, "session-1").act("verify")).rejects.toMatchObject({ status: 502, message: "The installation covers all repositories.", state });
  });

  it("defaults an error without a status or message", async () => {
    const failing = mcpHost({ call: async () => toolResult(undefined, { isError: true, content: [] }) });
    await expect(createMcpTransport(failing.host, "session-1").act("verify")).rejects.toMatchObject({ status: 500, message: "Setup failed. Retry the current step." });
  });

  it("rejects a result that carries no snapshot", async () => {
    const empty = mcpHost({ call: async () => toolResult({}) });
    await expect(createMcpTransport(empty.host, "session-1").getState()).rejects.toMatchObject({ status: 502 });
  });

  describe("opening links", () => {
    it("is refused when the host cannot open links", async () => {
      const { host, openLink } = mcpHost({ capabilities: {} });
      expect(await createMcpTransport(host, "session-1").openExternal?.("https://github.com/apps/x")).toBe(false);
      expect(openLink).not.toHaveBeenCalled();
    });

    it("hands the link to the host when it can", async () => {
      const { host, openLink } = mcpHost({ capabilities: { openLinks: {} } });
      expect(await createMcpTransport(host, "session-1").openExternal?.("https://github.com/apps/x")).toBe(true);
      expect(openLink).toHaveBeenCalledWith({ url: "https://github.com/apps/x" });
    });

    it("reports a refusal or a failure as not opened", async () => {
      const denied = mcpHost({ capabilities: { openLinks: {} }, openLink: async () => ({ isError: true }) });
      expect(await createMcpTransport(denied.host, "session-1").openExternal?.("https://github.com/apps/x")).toBe(false);
      const broken = mcpHost({ capabilities: { openLinks: {} }, openLink: () => Promise.reject(new Error("closed")) });
      expect(await createMcpTransport(broken.host, "session-1").openExternal?.("https://github.com/apps/x")).toBe(false);
    });
  });
});

describe("textOf", () => {
  it("joins text blocks and skips everything else", () => {
    const result: ToolResult = {
      content: [
        { type: "text", text: "First." },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: " Second. " },
      ],
    };
    expect(textOf(result)).toBe("First.  Second.");
  });
});
