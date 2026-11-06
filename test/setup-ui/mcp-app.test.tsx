import type { App } from "@modelcontextprotocol/ext-apps";
import type { UseAppOptions } from "@modelcontextprotocol/ext-apps/react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ToolResult } from "@/lib/transport";
import type { SetupState } from "@/lib/types";
import { McpSetup } from "@/mcp-app";
import { makeState } from "./fixtures";
import { pressInDialog, step } from "./mount";

interface Connection {
  app: App | null;
  isConnected: boolean;
  error: Error | null;
}

// Stands in for what `useApp` reports, so each test decides when the handshake lands.
const bridge = vi.hoisted(() => {
  const idle: Connection = { app: null, isConnected: false, error: null };
  let current = idle;
  const listeners = new Set<() => void>();
  return {
    options: undefined as UseAppOptions | undefined,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    read: () => current,
    set(next: Partial<Connection>) {
      current = { ...current, ...next };
      for (const listener of listeners) listener();
    },
    reset() {
      current = idle;
    },
  };
});

vi.mock("@modelcontextprotocol/ext-apps/react", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useApp: (options: UseAppOptions) => {
      bridge.options = options;
      return useSyncExternalStore(bridge.subscribe, bridge.read);
    },
  };
});

const VERIFY_REQUESTED = "Verification requested in GitHub Actions. This page checks automatically.";

interface FakeApp {
  callServerTool: Mock<App["callServerTool"]>;
  openLink: Mock<App["openLink"]>;
  getHostCapabilities: Mock<App["getHostCapabilities"]>;
  getHostContext: Mock<App["getHostContext"]>;
  ontoolresult?: App["ontoolresult"];
  onhostcontextchanged?: App["onhostcontextchanged"];
}

const reply = (state: SetupState): ToolResult => ({
  content: [{ type: "text", text: state.message }],
  structuredContent: { state },
});

// What the model-visible open tool returns: the loopback session plus the first snapshot.
const opening = (session: string, state: SetupState = makeState("register")): ToolResult => ({
  content: [{ type: "text", text: "Setup is ready." }],
  structuredContent: { session, state },
});

function fakeApp(options: { theme?: "light" | "dark"; openLinks?: boolean } = {}): FakeApp {
  return {
    callServerTool: vi.fn<App["callServerTool"]>(async () => reply(makeState("register"))),
    openLink: vi.fn<App["openLink"]>(async () => ({})),
    getHostCapabilities: vi.fn<App["getHostCapabilities"]>(() => (options.openLinks === false ? {} : { openLinks: {} })),
    getHostContext: vi.fn<App["getHostContext"]>(() => (options.theme ? { theme: options.theme } : {})),
  };
}

// The hook builds the App and lets the page attach handlers before it connects.
function create(app: FakeApp) {
  act(() => {
    bridge.options?.onAppCreated?.(app as unknown as App);
  });
}

// The hook reports the App only once the handshake has finished.
function handshake(app: FakeApp) {
  act(() => {
    bridge.set({ app: app as unknown as App, isConnected: true });
  });
}

function connect(app: FakeApp = fakeApp()) {
  create(app);
  handshake(app);
  return app;
}

function deliver(app: FakeApp, result: ToolResult) {
  act(() => {
    app.ontoolresult?.(result);
  });
}

function renderView() {
  const user = userEvent.setup();
  return { user, ...render(<McpSetup />) };
}

// A connected view that has already received its opening result.
function ceremony(options: { state?: SetupState; session?: string; app?: FakeApp } = {}) {
  const view = renderView();
  const app = connect(options.app);
  deliver(app, opening(options.session ?? "s1", options.state));
  return { app, ...view };
}

beforeEach(() => {
  bridge.reset();
  bridge.options = undefined;
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("color-scheme");
});

describe("McpSetup while connecting", () => {
  it("says it is connecting, inside the page shell", () => {
    renderView();
    const status = within(screen.getByRole("main")).getByRole("status");
    expect(status).toHaveTextContent("Connecting to Copilot");
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  it("introduces itself to the host and asks it for nothing", () => {
    renderView();
    expect(bridge.options?.appInfo).toEqual({ name: "CI/CD Optimizer setup", version: "1.0.0" });
    expect(bridge.options?.capabilities).toEqual({});
  });

  it("is listening for the opening result before the handshake finishes", () => {
    renderView();
    const app = fakeApp();
    create(app);
    expect(app.ontoolresult).toBeTypeOf("function");
    expect(app.onhostcontextchanged).toBeTypeOf("function");
  });

  it("reports a failed handshake instead of waiting for ever", () => {
    renderView();
    act(() => {
      bridge.set({ error: new Error("The host closed the connection.") });
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not connect to Copilot");
    expect(alert).toHaveTextContent("The host closed the connection.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("McpSetup once connected", () => {
  it("waits for the opening result", () => {
    renderView();
    connect();
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for the setup details");
  });

  it("shows the ceremony from the opening result", () => {
    ceremony({ state: makeState("install") });
    expect(screen.getByRole("heading", { level: 1, name: "CI/CD Optimizer setup" })).toBeInTheDocument();
    expect(step("install")).toHaveAttribute("aria-current", "step");
    expect(screen.queryByText("Waiting for the setup details")).not.toBeInTheDocument();
  });

  it("keeps an opening result that lands before the handshake finishes", () => {
    renderView();
    const app = fakeApp();
    create(app);
    deliver(app, opening("s1"));
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to Copilot");

    handshake(app);
    expect(screen.getByRole("list", { name: "Setup steps" })).toBeInTheDocument();
    expect(screen.queryByText("Waiting for the setup details")).not.toBeInTheDocument();
  });

  it("explains an opening call that failed", () => {
    renderView();
    const app = connect();
    deliver(app, { isError: true, content: [{ type: "text", text: "Could not find the repository acme/widgets." }] });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Setup could not start");
    expect(alert).toHaveTextContent("Could not find the repository acme/widgets.");
    expect(screen.queryByRole("list", { name: "Setup steps" })).not.toBeInTheDocument();
  });

  it("refuses an opening result it does not understand", () => {
    renderView();
    const app = connect();
    deliver(app, { content: [], structuredContent: { session: "s1" } });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Setup could not start");
    expect(alert).toHaveTextContent("Copilot returned an unexpected setup response.");
  });

  it("starts over from the snapshot of a newly opened session", async () => {
    const { app, user } = ceremony({ state: makeState("register"), session: "s1" });
    expect(step("register")).toHaveAttribute("aria-current", "step");

    deliver(app, opening("s2", makeState("install")));
    expect(step("install")).toHaveAttribute("aria-current", "step");
    expect(step("register")).not.toHaveAttribute("aria-current");

    app.callServerTool.mockResolvedValueOnce(reply(makeState("install", { message: VERIFY_REQUESTED })));
    await user.click(screen.getByRole("button", { name: "Verify installation" }));
    await pressInDialog(user, "Verify");
    expect(app.callServerTool).toHaveBeenCalledExactlyOnceWith({ name: "setup_verify", arguments: { session: "s2", confirm: true } });
  });
});

describe("McpSetup as the chat transport", () => {
  it("registers through the registration page, never a form post", () => {
    ceremony({ state: makeState("register") });
    const link = screen.getByRole("link", { name: "Open the registration page (opens in a new tab)" });
    expect(link).toHaveAttribute("href", "http://127.0.0.1:4000/register?session=session-1");
    expect(screen.queryByRole("button", { name: "Review registration on GitHub" })).not.toBeInTheDocument();
  });

  it("keeps the assignment token out of chat", () => {
    ceremony({ state: makeState("authorize") });
    expect(screen.queryByLabelText("Assignment token")).not.toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    const link = screen.getByRole("link", { name: "Open the secure setup page (opens in a new tab)" });
    expect(link).toHaveAttribute("href", "http://127.0.0.1:4000/?session=session-1");
  });

  it("sends a confirmed action to the server under the session it was opened with", async () => {
    const { app, user } = ceremony({ state: makeState("install"), session: "s1" });
    app.callServerTool.mockResolvedValueOnce(reply(makeState("install", { message: VERIFY_REQUESTED })));

    await user.click(screen.getByRole("button", { name: "Verify installation" }));
    expect(app.callServerTool).not.toHaveBeenCalled();
    await pressInDialog(user, "Verify");

    expect(app.callServerTool).toHaveBeenCalledExactlyOnceWith({ name: "setup_verify", arguments: { session: "s1", confirm: true } });
    expect(await screen.findByText(VERIFY_REQUESTED)).toBeInTheDocument();
  });

  it("opens links through the host", async () => {
    const { app, user } = ceremony({ state: makeState("install") });
    await user.click(screen.getByRole("link", { name: "Install on GitHub (opens in a new tab)" }));
    await vi.waitFor(() => {
      expect(app.openLink).toHaveBeenCalledExactlyOnceWith({ url: "https://github.com/apps/ci-cd-optimizer-acme/installations/new" });
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers the address to copy when the host cannot open links", async () => {
    const { app, user } = ceremony({ state: makeState("install"), app: fakeApp({ openLinks: false }) });
    await user.click(screen.getByRole("link", { name: "Install on GitHub (opens in a new tab)" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This host did not open the link.");
    expect(app.openLink).not.toHaveBeenCalled();
  });
});

describe("McpSetup theme", () => {
  it("starts in the host's light or dark choice", () => {
    renderView();
    connect(fakeApp({ theme: "dark" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("follows the host when the choice changes", () => {
    renderView();
    const app = connect(fakeApp({ theme: "dark" }));
    act(() => {
      app.onhostcontextchanged?.({ theme: "light" });
    });
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("leaves the theme alone when the host does not send one", () => {
    renderView();
    const app = connect();
    act(() => {
      app.onhostcontextchanged?.({ locale: "en-GB" });
    });
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });
});
