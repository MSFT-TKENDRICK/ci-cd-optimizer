import type { App } from "@modelcontextprotocol/ext-apps";
import { isSetupState, MCP_TOOLS, type ActionPayload, type SetupAction, type SetupState } from "./types";

export const SESSION_STORAGE_KEY = "cicd-optimizer-setup-session";

export class SetupApiError extends Error {
  readonly status: number;
  readonly state: SetupState | undefined;

  // Status 0 means the request never reached the setup server.
  constructor(message: string, status: number, state?: SetupState) {
    super(message);
    this.name = "SetupApiError";
    this.status = status;
    this.state = state;
  }
}

export interface SetupTransport {
  readonly kind: "http" | "mcp";
  // Only the loopback page may collect the Copilot token; chat never sees it.
  readonly canEnterSecrets: boolean;
  getState(): Promise<SetupState>;
  act(action: SetupAction, payload?: ActionPayload): Promise<SetupState>;
  // Only chat hosts implement this; a browser opens links natively. Resolves false when the host refuses the link.
  openExternal?(url: string): Promise<boolean>;
}

export interface HttpEnvironment {
  fetch: typeof fetch;
  location: Pick<Location, "href">;
  storage: Pick<Storage, "getItem" | "setItem">;
  history: Pick<History, "replaceState">;
}

function safeStorage(): HttpEnvironment["storage"] {
  try {
    return window.sessionStorage;
  } catch {
    const memory = new Map<string, string>();
    return { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => void memory.set(key, value) };
  }
}

const browserEnvironment = (): HttpEnvironment => ({
  fetch: (input, init) => window.fetch(input, init),
  location: window.location,
  storage: safeStorage(),
  history: window.history,
});

// The launch link carries the session once; keep it for this tab only and take it out of the address bar.
function takeSession(env: HttpEnvironment): string | null {
  const url = new URL(env.location.href);
  const fromUrl = url.searchParams.get("session");
  if (fromUrl) {
    try {
      env.storage.setItem(SESSION_STORAGE_KEY, fromUrl);
    } catch {
      // The session still works for this page load.
    }
    url.searchParams.delete("session");
    env.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    return fromUrl;
  }
  try {
    return env.storage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function createHttpTransport(overrides: Partial<HttpEnvironment> = {}): SetupTransport {
  const env = { ...browserEnvironment(), ...overrides };
  const session = takeSession(env);

  async function call(path: string, init: RequestInit = {}): Promise<SetupState> {
    if (!session) throw new SetupApiError("Open the link printed by npm run setup to start a session.", 401);
    const headers = new Headers(init.headers);
    headers.set("X-Setup-Session", session);
    headers.set("Accept", "application/json");
    let response: Response;
    try {
      response = await env.fetch(path, { ...init, headers, cache: "no-store", credentials: "same-origin" });
    } catch {
      throw new SetupApiError("Could not reach the setup server.", 0);
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A non-JSON body is reported by status below.
    }
    if (!response.ok) {
      const failure = typeof body === "object" && body !== null ? (body as { error?: unknown; state?: unknown }) : {};
      const message = typeof failure.error === "string" && failure.error ? failure.error : `The setup server returned ${response.status}.`;
      throw new SetupApiError(message, response.status, isSetupState(failure.state) ? failure.state : undefined);
    }
    if (!isSetupState(body)) throw new SetupApiError("The setup server returned an unexpected response.", 502);
    return body;
  }

  return {
    kind: "http",
    canEnterSecrets: true,
    getState: () => call("/api/state"),
    act: (action, payload = {}) =>
      call(`/api/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, confirm: true }),
      }),
  };
}

export type ToolResult = Awaited<ReturnType<App["callServerTool"]>>;
export type McpHost = Pick<App, "callServerTool" | "openLink" | "getHostCapabilities">;

export const textOf = (result: ToolResult) =>
  result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .trim();

export function parseToolResult(result: ToolResult): SetupState {
  const data: { state?: unknown; status?: unknown } = result.structuredContent ?? {};
  const state = isSetupState(data.state) ? data.state : undefined;
  if (result.isError) {
    throw new SetupApiError(textOf(result) || "Setup failed. Retry the current step.", typeof data.status === "number" ? data.status : 500, state);
  }
  if (!state) throw new SetupApiError("Copilot returned an unexpected setup response.", 502);
  return state;
}

export function createMcpTransport(host: McpHost, session: string): SetupTransport {
  async function call(name: string, args: Record<string, unknown> = {}): Promise<SetupState> {
    let result: ToolResult;
    try {
      result = await host.callServerTool({ name, arguments: { session, ...args } });
    } catch (error) {
      throw new SetupApiError(error instanceof Error && error.message ? error.message : "Copilot could not reach the setup server.", 0);
    }
    return parseToolResult(result);
  }

  return {
    kind: "mcp",
    canEnterSecrets: false,
    getState: () => call(MCP_TOOLS.state),
    act: (action, _payload) => {
      if (action === "authorize-copilot") {
        return Promise.reject(new SetupApiError("Enter the token on the secure setup page, never in chat.", 400));
      }
      return call(MCP_TOOLS[action], { confirm: true });
    },
    openExternal: async (url) => {
      if (!host.getHostCapabilities()?.openLinks) return false;
      try {
        const result = await host.openLink({ url });
        return !result.isError;
      } catch {
        return false;
      }
    },
  };
}
