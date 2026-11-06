import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import {
  AppBridge,
  PostMessageTransport,
  getToolUiResourceUri,
  isToolVisibilityAppOnly,
  isToolVisibilityModelOnly,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiHostCapabilities, McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";

type Tone = "ok" | "warn" | "error";
type Theme = "light" | "dark";
type Mode = "fake" | "real";

interface PreviewConfig {
  mode: Mode;
  repo: string;
  resumeApp: string | null;
  readOnly: boolean;
  viewUrl: string;
  prefersBorder: boolean;
}

interface PreviewEvent {
  at: number;
  kind: string;
  detail: string;
}

interface PreviewSnapshot {
  status: string;
  initialized: boolean;
  theme: Theme;
  mode: Mode;
  readOnly: boolean;
  frameHeight: number;
  frameWidth: number;
  reportedHeight: number | null;
  violations: number;
  modelTools: string[];
  appTools: string[];
  modelText: string;
  appName: string | null;
  appCapabilities: string[];
}

interface PreviewApi {
  events: PreviewEvent[];
  links: string[];
  snapshot(): PreviewSnapshot;
  reload(): Promise<void>;
}

declare global {
  interface Window {
    __preview?: PreviewApi;
  }
}

interface Panel {
  iframe: HTMLIFrameElement;
  bridge: AppBridge;
  initialized: boolean;
  token: string | null;
}

const HOST_INFO = { name: "cicd-optimizer-preview-host", version: "1.0.0" };
const HOST_CAPABILITIES: McpUiHostCapabilities = { openLinks: {}, serverTools: {}, logging: {} };
const TEARDOWN_TIMEOUT_MS = 1_000;
const VIOLATION_POLL_MS = 1_500;
const MAX_EVENTS = 500;
const MAX_VISIBLE_EVENTS = 200;

const startedAt = performance.now();
const events: PreviewEvent[] = [];
const links: string[] = [];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isTool = (value: unknown): value is Tool => isRecord(value) && typeof value.name === "string" && isRecord(value.inputSchema);
const isCallToolResult = (value: unknown): value is CallToolResult => isRecord(value) && Array.isArray(value.content);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
// Session tokens are credentials for the panel and the loopback page, so the visible log shows only a prefix.
const mask = (text: string) => text.replace(/\b[0-9a-f]{64}\b/gi, (value) => `${value.slice(0, 8)}…`);

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`The preview page is missing #${id}.`);
  return found;
}

const modeBadge = byId("mode", HTMLSpanElement);
const statusBadge = byId("status", HTMLSpanElement);
const cspBadge = byId("csp", HTMLSpanElement);
const callBox = byId("call", HTMLPreElement);
const modelBox = byId("model-text", HTMLPreElement);
const themeButton = byId("theme", HTMLButtonElement);
const widthSelect = byId("width", HTMLSelectElement);
const reloadButton = byId("reload", HTMLButtonElement);
const frameWrap = byId("frame-wrap", HTMLDivElement);
const toolList = byId("tools", HTMLUListElement);
const linkList = byId("links", HTMLUListElement);
const linkEmpty = byId("links-empty", HTMLParagraphElement);
const logList = byId("log", HTMLOListElement);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function log(kind: string, detail: string, tone?: Tone): void {
  const text = mask(detail).slice(0, 400);
  const at = Math.round(performance.now() - startedAt);
  events.push({ at, kind, detail: text });
  if (events.length > MAX_EVENTS) events.shift();
  const item = document.createElement("li");
  if (tone) item.dataset.tone = tone;
  item.append(element("span", "at", String(at)), element("span", "kind", kind), element("code", "detail", text));
  logList.append(item);
  while (logList.children.length > MAX_VISIBLE_EVENTS) logList.firstElementChild?.remove();
  logList.scrollTop = logList.scrollHeight;
}

async function rpc(method: string, params?: unknown): Promise<unknown> {
  const response = await fetch("/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (isRecord(body) && "result" in body) return body.result;
  throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `The preview server answered HTTP ${response.status}.`);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const result = await rpc("tools/call", { name, arguments: args });
  if (!isCallToolResult(result)) throw new Error("The preview server returned an unexpected tool result.");
  return result;
}

async function listTools(): Promise<Tool[]> {
  const result = await rpc("tools/list");
  if (!isRecord(result) || !Array.isArray(result.tools)) throw new Error("The preview server returned an unexpected tool list.");
  return result.tools.filter(isTool);
}

function parseConfig(value: unknown): PreviewConfig {
  if (!isRecord(value)) throw new Error("The preview server returned no configuration.");
  const { mode, repo, resumeApp, readOnly, viewUrl, prefersBorder } = value;
  if ((mode !== "fake" && mode !== "real") || typeof repo !== "string" || typeof viewUrl !== "string") {
    throw new Error("The preview configuration is incomplete.");
  }
  return {
    mode,
    repo,
    resumeApp: typeof resumeApp === "string" ? resumeApp : null,
    readOnly: readOnly !== false,
    viewUrl,
    prefersBorder: prefersBorder === true,
  };
}

const textOf = (result: CallToolResult) =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

function tokenOf(result: CallToolResult): string | null {
  const content = result.structuredContent;
  const token = isRecord(content) ? content.session : undefined;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function uiResource(tool: Tool): string | undefined {
  try {
    return getToolUiResourceUri(tool);
  } catch {
    return undefined;
  }
}

function findOpenTool(tools: Tool[]): Tool {
  const candidates = tools.filter((tool) => !isToolVisibilityAppOnly(tool) && uiResource(tool) !== undefined);
  const [only, ...rest] = candidates;
  if (!only || rest.length > 0) {
    throw new Error(`Expected exactly one model-visible tool that renders a ui:// resource, found ${candidates.length}.`);
  }
  return only;
}

function renderTools(tools: Tool[]): void {
  toolList.replaceChildren(
    ...tools.map((tool) => {
      const item = document.createElement("li");
      const appOnly = isToolVisibilityAppOnly(tool);
      const audience = appOnly ? "app only" : isToolVisibilityModelOnly(tool) ? "model only" : "model + app";
      const tag = element("span", "tag", audience);
      if (appOnly) tag.dataset.who = "app";
      item.append(element("code", "", tool.name), tag);
      const resource = uiResource(tool);
      if (resource && !appOnly) item.append(element("span", "tag", `renders ${resource}`));
      return item;
    }),
  );
}

function recordLink(url: URL, opened: boolean): void {
  links.push(url.href);
  linkEmpty.hidden = true;
  const item = document.createElement("li");
  const label = mask(`${url.origin}${url.pathname}${url.search}`);
  if (opened) {
    const anchor = element("a", "", label);
    anchor.href = url.href;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    item.append(anchor);
  } else {
    item.append(element("code", "", label), element("span", "tag", "recorded, not opened"));
  }
  linkList.append(item);
}

async function run(config: PreviewConfig): Promise<void> {
  let theme: Theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  let catalog: Tool[] = [];
  let openTool: Tool | null = null;
  let panel: Panel | null = null;
  let status = "Starting…";
  let reportedHeight: number | null = null;
  let violationCount = 0;
  let modelSees = "";

  function setStatus(text: string, tone?: Tone): void {
    status = text;
    statusBadge.textContent = text;
    if (tone) statusBadge.dataset.tone = tone;
    else delete statusBadge.dataset.tone;
  }

  function hostContext(): McpUiHostContext {
    const width = Number(widthSelect.value);
    return {
      theme,
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      containerDimensions: width > 0
        ? { maxHeight: 900, width }
        : { maxHeight: 900, maxWidth: Math.round(frameWrap.getBoundingClientRect().width) },
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: "web",
      userAgent: `${HOST_INFO.name}/${HOST_INFO.version}`,
      deviceCapabilities: { touch: false, hover: true },
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      ...(openTool ? { toolInfo: { tool: openTool } } : {}),
    };
  }

  function pushContext(): void {
    if (!panel?.initialized) return;
    panel.bridge.setHostContext(hostContext());
    log("host-context", `theme ${theme}, width ${widthSelect.value === "0" ? "fill" : `${widthSelect.value}px`}`);
  }

  async function openRegistration(target: URL, current: Panel): Promise<{ isError?: boolean }> {
    if (config.mode === "real") {
      log("open-link", "blocked the registration page: the preview never opens the live registration form", "warn");
      return { isError: true };
    }
    if (!current.token) {
      log("open-link", "cannot simulate registration without the panel session", "error");
      return { isError: true };
    }
    recordLink(target, false);
    const response = await fetch("/simulate-register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: current.token }),
    });
    if (!response.ok) {
      log("open-link", `simulated registration failed: HTTP ${response.status}`, "error");
      return { isError: true };
    }
    log("open-link", "simulated the GitHub manifest round trip; the App is now registered on the fake GitHub");
    // A person returning from GitHub brings focus back to the panel, which is what makes it refresh.
    current.iframe.contentWindow?.focus();
    return {};
  }

  function openLink(url: string, current: Panel): Promise<{ isError?: boolean }> | { isError?: boolean } {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      log("open-link", "refused a malformed URL", "error");
      return { isError: true };
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      log("open-link", `refused a ${target.protocol} link`, "error");
      return { isError: true };
    }
    const loopback = target.protocol === "http:" && target.hostname === "127.0.0.1";
    if (loopback && target.pathname === "/register") return openRegistration(target, current);
    if (loopback) {
      // The secure setup page talks to GitHub directly, so a read-only host must not hand it out.
      if (config.readOnly) {
        log("open-link", "blocked the secure setup page: it can change real state and this host is read-only", "warn");
        return { isError: true };
      }
      recordLink(target, true);
      log("open-link", `opened ${target.origin}${target.pathname} in a new tab`);
      window.open(target.href, "_blank", "noopener");
      return {};
    }
    recordLink(target, false);
    log("open-link", `intercepted ${target.origin}${target.pathname}`, "warn");
    return {};
  }

  async function deliver(current: Panel, args: Record<string, unknown>, result: CallToolResult): Promise<void> {
    try {
      await current.bridge.sendToolInput({ arguments: args });
      log("tool-input", JSON.stringify(args));
      await current.bridge.sendToolResult(result);
      log("tool-result", result.isError ? "delivered an error result" : "delivered; structuredContent goes to the view only", result.isError ? "warn" : undefined);
    } catch (error) {
      log("error", `could not deliver the tool result: ${messageOf(error)}`, "error");
    }
  }

  function wire(current: Panel, args: Record<string, unknown>, result: CallToolResult): void {
    const { bridge, iframe } = current;
    bridge.oninitialized = () => {
      current.initialized = true;
      const view = bridge.getAppVersion();
      setStatus("Panel connected", "ok");
      log("initialized", `view ${view ? `${view.name} ${view.version}` : "(unnamed)"}, capabilities ${JSON.stringify(bridge.getAppCapabilities() ?? {})}`);
      void deliver(current, args, result);
    };
    bridge.onsizechange = ({ height }) => {
      if (typeof height !== "number") return;
      reportedHeight = Math.ceil(height);
      iframe.style.height = `${reportedHeight}px`;
      log("size", `height ${reportedHeight}px`);
    };
    bridge.onloggingmessage = ({ level, data }) => log("view log", `${level}: ${JSON.stringify(data)}`);
    bridge.onrequestteardown = () => log("teardown", "the view asked to be closed");
    bridge.onrequestdisplaymode = async () => ({ mode: "inline" });
    bridge.onopenlink = async ({ url }) => openLink(url, current);
    bridge.oncalltool = async (params) => {
      const tool = catalog.find((candidate) => candidate.name === params.name);
      if (!tool) throw new Error(`Unknown tool ${params.name}.`);
      if (isToolVisibilityModelOnly(tool)) throw new Error(`Tool ${params.name} is not available to apps.`);
      const outcome = await callTool(params.name, params.arguments ?? {});
      log("tools/call", `${params.name} -> ${outcome.isError ? "error" : "ok"}: ${textOf(outcome)}`, outcome.isError ? "warn" : undefined);
      return outcome;
    };
  }

  async function mount(tool: Tool, args: Record<string, unknown>, result: CallToolResult): Promise<void> {
    const iframe = document.createElement("iframe");
    iframe.className = "view";
    iframe.title = "CI/CD Optimizer setup";
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frameWrap.replaceChildren(iframe);
    const target = iframe.contentWindow;
    if (!target) throw new Error("The panel frame has no window.");
    openTool = tool;
    const bridge = new AppBridge(null, HOST_INFO, HOST_CAPABILITIES, { hostContext: hostContext() });
    const current: Panel = { iframe, bridge, initialized: false, token: tokenOf(result) };
    panel = current;
    reportedHeight = null;
    wire(current, args, result);
    // The bridge must be listening before the view loads, or its first request is lost.
    await bridge.connect(new PostMessageTransport(target, target));
    iframe.src = config.viewUrl;
    setStatus("Panel loading…");
  }

  async function unmount(): Promise<void> {
    const current = panel;
    if (!current) return;
    panel = null;
    if (current.initialized) {
      await Promise.race([current.bridge.teardownResource({}).catch(() => undefined), sleep(TEARDOWN_TIMEOUT_MS)]);
    }
    await current.bridge.close().catch(() => undefined);
    current.iframe.remove();
  }

  async function start(): Promise<void> {
    reloadButton.disabled = true;
    try {
      setStatus("Listing tools…");
      catalog = await listTools();
      renderTools(catalog);
      const tool = findOpenTool(catalog);
      const args = { repo: config.repo, ...(config.resumeApp ? { resumeApp: config.resumeApp } : {}) };
      callBox.textContent = `${tool.name}(${JSON.stringify(args)})\nrenders ${uiResource(tool)}`;
      setStatus("Calling the tool…");
      const result = await callTool(tool.name, args);
      modelSees = textOf(result);
      modelBox.textContent = `${modelSees}\n\n(structuredContent, including the panel session, is sent to the view only.)`;
      log("tools/call", `${tool.name} -> ${result.isError ? "error" : "ok"}`, result.isError ? "warn" : undefined);
      await mount(tool, args, result);
    } catch (error) {
      setStatus(`Failed: ${messageOf(error)}`, "error");
      log("error", messageOf(error), "error");
    } finally {
      reloadButton.disabled = false;
    }
  }

  async function reload(): Promise<void> {
    reloadButton.disabled = true;
    await unmount();
    await start();
  }

  async function pollViolations(): Promise<void> {
    try {
      const response = await fetch("/violations", { cache: "no-store" });
      const body: unknown = await response.json();
      if (!Array.isArray(body)) return;
      for (const item of body.slice(violationCount)) log("csp", JSON.stringify(item), "error");
      violationCount = body.length;
      cspBadge.textContent = `CSP violations: ${violationCount}`;
      cspBadge.dataset.tone = violationCount > 0 ? "error" : "ok";
    } catch {
      // The next poll retries; a stopped server shows up as a failed tool call.
    }
  }

  modeBadge.textContent = config.mode === "fake"
    ? "Fake GitHub"
    : config.readOnly ? "Real GitHub, read-only" : "Real GitHub, actions enabled";
  if (config.mode === "real") modeBadge.dataset.tone = config.readOnly ? "warn" : "error";
  frameWrap.dataset.border = String(config.prefersBorder);
  themeButton.setAttribute("aria-pressed", String(theme === "dark"));

  themeButton.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    themeButton.setAttribute("aria-pressed", String(theme === "dark"));
    pushContext();
  });
  widthSelect.addEventListener("change", () => {
    const width = Number(widthSelect.value);
    frameWrap.dataset.width = width > 0 ? "fixed" : "fill";
    frameWrap.style.width = width > 0 ? `${width}px` : "";
    pushContext();
  });
  reloadButton.addEventListener("click", () => void reload());

  window.__preview = {
    events,
    links,
    reload,
    snapshot: () => {
      const box = panel?.iframe.getBoundingClientRect();
      return {
        status,
        initialized: panel?.initialized ?? false,
        theme,
        mode: config.mode,
        readOnly: config.readOnly,
        frameHeight: Math.round(box?.height ?? 0),
        frameWidth: Math.round(box?.width ?? 0),
        reportedHeight,
        violations: violationCount,
        modelTools: catalog.filter((tool) => !isToolVisibilityAppOnly(tool)).map((tool) => tool.name),
        appTools: catalog.filter((tool) => isToolVisibilityAppOnly(tool)).map((tool) => tool.name),
        modelText: modelSees,
        appName: panel?.bridge.getAppVersion()?.name ?? null,
        appCapabilities: Object.keys(panel?.bridge.getAppCapabilities() ?? {}),
      };
    },
  };

  setInterval(() => void pollViolations(), VIOLATION_POLL_MS);
  await start();
}

async function main(): Promise<void> {
  const response = await fetch("/config", { cache: "no-store" });
  await run(parseConfig(await response.json()));
}

main().catch((error: unknown) => {
  statusBadge.textContent = `Failed: ${messageOf(error)}`;
  statusBadge.dataset.tone = "error";
});
