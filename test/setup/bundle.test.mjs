// Runs under vitest rather than node:test because it imports the UI's TypeScript contract and drives the built bundle in jsdom.
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transform } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_SCRIPT, scriptHash } from "../../scripts/setup-pages.mjs";
import { startSetup } from "../../scripts/setup-session.mjs";
import { OUTPUT_FILES, findStale, writeSetupUi } from "../../scripts/setup-ui-bundle.mjs";
import { SETUP_STATE_KEYS } from "../../ui/setup/src/lib/types.ts";
import { saved, verificationCommand } from "./helpers.mjs";

const lf = (text) => text.replace(/\r\n/g, "\n");
const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8").then(lf);
const parse = (html) => new JSDOM(html).window.document;
const PAGES = ["ui/setup/index.html", "dist-setup/index.html", "dist-setup/mcp.html"];

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

describe("the setup pages", () => {
  it.each(PAGES)("%s runs one classic script: the theme script the server pins by hash", async (path) => {
    const classic = [...parse(await read(path)).scripts].filter((script) => !script.type && !script.src);
    expect(classic.map((script) => script.textContent)).toEqual([THEME_SCRIPT]);
  });

  it("dist-setup/index.html loads only its own bundle and styles", async () => {
    const document = parse(await read("dist-setup/index.html"));
    expect([...document.scripts].map((script) => script.getAttribute("src"))).toEqual([null, "/assets/app.js"]);
    // The data: icon only stops the browser asking the setup server for a favicon.
    expect([...document.querySelectorAll("link")].map((link) => [link.rel, link.getAttribute("href")])).toEqual([
      ["icon", "data:,"],
      ["stylesheet", "/assets/app.css"],
    ]);
    expect(document.getElementById("root")).not.toBeNull();
  });

  it("dist-setup/mcp.html is one self-contained document", async () => {
    const html = await read("dist-setup/mcp.html");
    const document = parse(html);
    // The chat host serves this single file from its own sandbox, so nothing may come from the setup server.
    expect(document.querySelectorAll("img, iframe, object, embed, base, script[src]")).toHaveLength(0);
    expect([...document.querySelectorAll("link")].filter((link) => !link.getAttribute("href")?.startsWith("data:"))).toHaveLength(0);
    expect(html).not.toContain("/assets/");
    expect([...document.scripts].map((script) => script.type)).toEqual(["", "module"]);
    expect(document.querySelectorAll("style")).toHaveLength(1);
    expect(document.getElementById("root")).not.toBeNull();
    const bundle = document.querySelector('script[type="module"]')?.textContent ?? "";
    expect(bundle.length).toBeGreaterThan(100_000);
    await expect(transform(bundle, { loader: "js", format: "esm" })).resolves.toBeDefined();
  });

  it("ships exactly the files the setup server and the MCP view load", async () => {
    expect((await readdir(new URL("../../dist-setup/", import.meta.url))).sort()).toEqual([...OUTPUT_FILES].sort());
  });
});

describe("the freshness check", () => {
  async function scratch() {
    const directory = await mkdtemp(join(tmpdir(), "setup-ui-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    return directory;
  }
  const files = () => new Map([["a.js", "one\ntwo\n"], ["b.css", "body{}\n"]]);

  it("accepts an identical build, even checked out with Windows line endings", async () => {
    const out = await scratch();
    await writeSetupUi(files(), out);
    expect(await findStale(files(), out)).toEqual([]);
    await writeFile(join(out, "a.js"), "one\r\ntwo\r\n");
    expect(await findStale(files(), out)).toEqual([]);
  });

  it("names changed, missing and unexpected files", async () => {
    const out = await scratch();
    await writeSetupUi(files(), out);
    await writeFile(join(out, "a.js"), "changed\n");
    await rm(join(out, "b.css"));
    await writeFile(join(out, "extra.txt"), "left behind");
    expect(await findStale(files(), out)).toEqual(["a.js", "b.css", "extra.txt"]);
  });

  it("treats a directory that does not exist as entirely stale", async () => {
    const out = join(await scratch(), "missing");
    expect(await findStale(files(), out)).toEqual(["a.js", "b.css"]);
  });

  it("rewrites the output directory from scratch", async () => {
    const out = await scratch();
    await writeFile(join(out, "old.txt"), "from an earlier build");
    await writeSetupUi(files(), out);
    expect((await readdir(out)).sort()).toEqual(["a.js", "b.css"]);
  });
});

// Serves the real dist-setup directory; GitHub is never contacted unless a test supplies a fake command.
async function serve({ saved: resume, command } = {}) {
  const setup = await startSetup(
    { repo: "acme/widgets", organization: true, saved: resume },
    {
      request: async (path) => {
        throw new Error(`Unexpected GitHub request: ${path}`);
      },
      command: command ?? (async (args) => {
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      }),
      refreshInterval: 0,
      lifetime: 300_000,
    },
  );
  cleanups.push(() => setup.close());
  return setup;
}

describe("the setup server serving the real build", () => {
  it("serves the shell, bundle and styles, and allows only the pinned inline script", async () => {
    const setup = await serve();
    const page = await fetch(setup.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(await read("dist-setup/index.html"));
    const policy = page.headers.get("content-security-policy") ?? "";
    expect(policy.split("; ").find((directive) => directive.startsWith("script-src"))).toBe(`script-src 'self' ${scriptHash(THEME_SCRIPT)}`);

    const script = await fetch(`${setup.origin}/assets/app.js`);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(lf(await script.text())).toBe(await read("dist-setup/app.js"));
    const styles = await fetch(`${setup.origin}/assets/app.css`);
    expect(styles.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(lf(await styles.text())).toBe(await read("dist-setup/app.css"));
  });

  it.each([
    ["a new registration", undefined],
    ["a resumed App", saved],
  ])("returns the snapshot keys the UI contract declares for %s", async (_name, resume) => {
    const setup = await serve({ saved: resume });
    expect(Object.keys(await setup.getState()).sort()).toEqual([...SETUP_STATE_KEYS]);
  });
});

const WAIT = { timeout: 5_000, interval: 25 };
const currentStep = (document) => document.querySelector("li[aria-current='step']")?.getAttribute("data-step");
const button = (root, text) => [...root.querySelectorAll("button")].find((element) => element.textContent?.trim() === text);

// jsdom runs scripts only on request and ships no fetch, so this stands in for the parts of a browser the bundle needs.
async function openPage(setup, url = setup.url) {
  const [html, bundle] = await Promise.all([fetch(url).then((response) => response.text()), read("dist-setup/app.js")]);
  const problems = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => problems.push(error.message));
  virtualConsole.on("error", (...args) => problems.push(args.join(" ")));
  const { window } = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  cleanups.push(() => window.close());
  window.Headers = Headers;
  // jsdom lays nothing out, so it has no scrollIntoView, which the confirmation panel calls when it opens.
  window.Element.prototype.scrollIntoView = () => {};
  window.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers);
    // A browser adds Origin to every cross-method request; the server rejects a form post without it.
    if (!["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase())) headers.set("Origin", window.location.origin);
    return fetch(new URL(String(input), window.location.href), { ...init, headers });
  };
  window.eval(bundle);
  return { window, document: window.document, problems };
}

describe("the built MCP view in a browser-like page", () => {
  // A chat host serves the view without 'unsafe-eval', so a browser refuses `new Function` and reports a CSP violation.
  it("starts without compiling code from a string", { timeout: 30_000 }, async () => {
    const html = await read("dist-setup/mcp.html");
    const bundle = parse(html).querySelector('script[type="module"]')?.textContent ?? "";
    const { window } = new JSDOM(html, { url: "http://127.0.0.1:1/view", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
    cleanups.push(() => window.close());
    const attempts = [];
    const refuse = (args) => {
      attempts.push(args.map(String));
      throw new window.EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script.");
    };
    window.Function = new Proxy(window.Function, { construct: (_target, args) => refuse(args), apply: (_target, _this, args) => refuse(args) });
    window.eval(bundle);

    // The view must be up first, otherwise an empty list would prove nothing.
    await vi.waitFor(() => expect(window.document.getElementById("root")?.textContent).toContain("Connecting to Copilot"), { timeout: 20_000, interval: 50 });
    expect(attempts).toEqual([]);
  });
});

describe("the built bundle in a browser-like page", () => {
  it("shows the ceremony from the real server and keeps the session out of the address bar", async () => {
    const setup = await serve();
    const { window, document, problems } = await openPage(setup);
    await vi.waitFor(() => expect(document.querySelector("li[data-step]")).not.toBeNull(), WAIT);

    expect(document.querySelector("h1")?.textContent).toBe("CI/CD Optimizer setup");
    expect([...document.querySelectorAll("li[data-step]")].map((step) => step.getAttribute("data-step"))).toEqual([
      "register", "credentials", "install", "authorize", "scan",
    ]);
    expect(currentStep(document)).toBe("register");
    expect(window.location.search).toBe("");
    expect(window.sessionStorage.getItem("cicd-optimizer-setup-session")).toBe(setup.session);

    const form = document.querySelector("form[method='post']");
    expect(form?.getAttribute("action")).toMatch(/^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=[0-9a-f]{64}$/);
    const manifest = JSON.parse(form?.querySelector("input[name='manifest']")?.getAttribute("value") ?? "null");
    expect(manifest.redirect_url).toBe(`${setup.origin}/registered`);
    expect(problems).toEqual([]);
  });

  it("says so when the tab was not given the session", async () => {
    const setup = await serve();
    const { document, problems } = await openPage(setup, `${setup.origin}/?session=not-the-session`);
    await vi.waitFor(() => expect(document.body.textContent).toContain("This tab is not authorized"), WAIT);
    expect(document.querySelector("li[data-step]")).toBeNull();
    expect(problems).toEqual([]);
  });

  it("carries a resumed App from a click, through the real server, to the next step", { timeout: 20_000 }, async () => {
    const onRunRead = vi.fn();
    const verification = { run: { status: "in_progress", conclusion: null }, onRunRead };
    const setup = await serve({ saved, command: verificationCommand(verification) });
    const { window, document, problems } = await openPage(setup);
    const timers = vi.spyOn(window, "setTimeout");
    cleanups.push(() => timers.mockRestore());
    const firePoll = (delay) => {
      expect(timers).toHaveBeenLastCalledWith(expect.any(Function), delay);
      const [callback] = timers.mock.calls.at(-1);
      // Run the bundle's scheduled poll, not a manual refresh, without spending its idle interval.
      window.clearTimeout(timers.mock.results.at(-1).value);
      callback();
    };
    await vi.waitFor(() => expect(currentStep(document)).toBe("install"), WAIT);
    expect(document.body.textContent).toContain("Resumed");

    button(document, "Verify installation")?.click();
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull(), WAIT);
    button(document.querySelector('[role="alertdialog"]'), "Verify")?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Verification requested in GitHub Actions."), WAIT);

    expect(onRunRead).not.toHaveBeenCalled();
    firePoll(10_000);
    await vi.waitFor(() => expect(timers).toHaveBeenLastCalledWith(expect.any(Function), 3_000), WAIT);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Verification is still queued or running."), WAIT);
    expect(onRunRead).toHaveBeenCalledTimes(1);
    expect(currentStep(document)).toBe("install");

    verification.run = { status: "completed", conclusion: "success" };
    firePoll(3_000);
    await vi.waitFor(() => expect(currentStep(document)).toBe("scan"), { timeout: 12_000, interval: 100 });
    expect(onRunRead).toHaveBeenCalledTimes(2);
    expect(timers).toHaveBeenLastCalledWith(expect.any(Function), 10_000);
    expect(button(document, "Run scan and assign pending findings")).toBeDefined();
    expect(problems).toEqual([]);
  });
});
