import { describe, expect, it } from "vitest";
import { AgentError, boundedResult, codeBlock, escapeMarkdown, inlineCode, LIMITS, operation, ownWork, WorkLimiter } from "../../src/agents/safety.js";
import { githubReader } from "../../src/agents/github.js";
import { repositoryReader, resolveRepository } from "../../src/agents/remote.js";
import type { GitHubClient } from "../../src/github/client.js";
import { mapLimit } from "../../src/utils.js";

describe("agent output and operation budgets", () => {
  it("omits whole oversized results with exact byte counts, never partial executable fixes", () => {
    const result = { written: false, newText: "🦊".repeat(LIMITS.outputBytes) };
    const bounded = boundedResult(result);
    expect(bounded).toMatchObject({ truncation: { truncated: true, omittedResponseBytes: Buffer.byteLength(JSON.stringify(result)), maxBytes: LIMITS.outputBytes } });
    expect(bounded).not.toHaveProperty("newText");
    expect(boundedResult({ ok: true })).toEqual({ ok: true });
  });

  it("escapes Markdown, HTML, table cells, and dynamically fences untrusted text", () => {
    const untrusted = '<img src=x onerror=alert(1)> [click](https://bad.example) | ```\n# header\u202e';
    const escaped = escapeMarkdown(untrusted);
    expect(escaped).toContain("&lt;img");
    expect(escaped).toContain("\\|");
    expect(escaped).not.toContain("[click](");
    expect(escaped).not.toMatch(/[\n\u202e]/);
    expect(inlineCode("a`b")).toBe("`` a`b ``");
    expect(codeBlock("```\n# untrusted")).toBe("````text\n```\n# untrusted\n````");
  });

  it("bounds global/per-user work, with idempotent release and no waiting queue", () => {
    const limiter = new WorkLimiter(2, 1);
    const a = limiter.acquire("a");
    expect(() => limiter.acquire("a")).toThrow("Concurrency");
    const b = limiter.acquire("b");
    expect(() => limiter.acquire("c")).toThrow("Concurrency");
    a(); a();
    const c = limiter.acquire("c");
    b(); c();
    limiter.acquire("a")();
  });

  it("does not release a timed-out operation's permit until underlying work settles", async () => {
    const limiter = new WorkLimiter(1, 1);
    const release = limiter.acquire();
    let finish!: () => void;
    const pending = operation(async (signal) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      expect(signal.aborted).toBe(true);
    }, undefined, 10, { onSettled: release });
    const failure = expect(pending).rejects.toThrow("deadline");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(() => limiter.acquire()).toThrow("Concurrency");
    finish();
    await failure;
    limiter.acquire()();
  });

  it("drains cancelled siblings even when the command catches its first read failure", async () => {
    const limiter = new WorkLimiter(1, 1);
    const release = limiter.acquire();
    const first = new AgentError("Original scan failure");
    let active = 0;
    let aborted = 0;
    const result = await operation(async (signal) => {
      const stalled = ownWork(signal, async (readSignal) => {
        active += 1;
        try {
          await new Promise<void>((_resolve, reject) => readSignal.addEventListener("abort", () => {
            aborted += 1;
            expect(readSignal.reason).toBe(first);
            expect(() => limiter.acquire()).toThrow("Concurrency");
            setTimeout(() => reject(readSignal.reason), 20);
          }, { once: true }));
        } finally { active -= 1; }
      });
      const failed = ownWork(signal, async () => { throw first; });
      try { await Promise.all([stalled, failed]); }
      catch (error) { expect(error).toBe(first); }
      await expect(ownWork(signal, async () => { throw new Error("Must not start"); })).rejects.toBe(first);
      return "handled";
    }, undefined, 500, { onSettled: release });
    expect(result).toBe("handled");
    expect({ active, aborted }).toEqual({ active: 0, aborted: 1 });
    limiter.acquire()();
  });

  it("stops queued mapper work as soon as a worker fails, even before its siblings finish", async () => {
    const first = new AgentError("Original mapping failure");
    const started: number[] = [];
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const pending = mapLimit([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 0) throw first;
      await gate;
      return item;
    });
    try { await expect(pending).rejects.toBe(first); }
    finally { finish(); }
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
  });

  it("bounds cleanup waits, preserves the first error, and reserves capacity until stubborn work settles", async () => {
    const limiter = new WorkLimiter(1, 1);
    const release = limiter.acquire();
    const first = new AgentError("Original scan failure");
    let finish!: () => void;
    let readSignal!: AbortSignal;
    const result = operation(async (signal) => {
      const stubborn = ownWork(signal, async (child) => {
        readSignal = child;
        await new Promise<void>((resolve) => { finish = resolve; });
      });
      void stubborn.catch(() => undefined);
      await Promise.resolve();
      throw first;
    }, undefined, 500, { onSettled: release, cleanupMs: 10 });
    try {
      await expect(result).rejects.toBe(first);
      expect(readSignal.aborted).toBe(true);
      expect(readSignal.reason).toBe(first);
      expect(() => limiter.acquire()).toThrow("Concurrency");
    } finally { finish(); }
    await expect.poll(() => {
      try { limiter.acquire()(); return true; }
      catch { return false; }
    }).toBe(true);
  });
});

describe("explicit bounded GitHub reader", () => {
  it("permits only GET, encodes route data, refuses insecure origins, and disables redirects", async () => {
    let calls = 0;
    const api = githubReader("test-token", { fetch: async (url, init) => {
      calls += 1;
      expect(String(url)).toBe("https://api.github.com/repos/acme/widgets/contents/.github%2Fworkflows%2Fci.yml?ref=branch%2Fname");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
      return Response.json({ content: "file" });
    } });
    for (const route of ["POST /graphql", "POST /repos/{owner}/{repo}/issues", "PATCH /repos/{owner}/{repo}/pulls/{number}", "GET /orgs/{org}/repos", "GET https://evil.example/"]) {
      await expect(api.request(route)).rejects.toThrow("only repository GET");
    }
    for (const ref of [".", ".."]) {
      await expect(api.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner: "acme", repo: "widgets", ref })).rejects.toThrow("dot segments");
    }
    expect(calls).toBe(0);
    await api.request("GET /repos/{owner}/{repo}/contents/{path}", { owner: "acme", repo: "widgets", path: ".github/workflows/ci.yml", ref: "branch/name" });
    expect(calls).toBe(1);
    for (const baseUrl of ["http://api.github.com", "https://user:pass@api.github.com", "https://api.github.com?q=1", "https://api.github.com#fragment"]) {
      expect(() => githubReader("token", { baseUrl })).toThrow("HTTPS URL");
    }
  });

  it("caps both declared and streamed response bytes and suppresses GitHub error bodies", async () => {
    const declared = githubReader("token", { responseBytes: 16, fetch: async () => new Response("{}", { headers: { "content-length": "17" } }) });
    await expect(declared.request("GET /user")).rejects.toThrow("byte limit");
    let cancelled = false;
    const streamed = githubReader("token", { responseBytes: 16, fetch: async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(17))); },
      cancel() { cancelled = true; },
    })) });
    await expect(streamed.request("GET /user")).rejects.toThrow("response budget");
    expect(cancelled).toBe(true);
    const denied = githubReader("token", { fetch: async () => Response.json({ private: "must-not-escape" }, { status: 403 }) });
    await expect(denied.request("GET /user")).rejects.toThrow("GitHub read failed (403).");
    const invalid = githubReader("token", { fetch: async () => new Response("<html>upstream failure</html>") });
    await expect(invalid.request("GET /user")).rejects.toThrow("invalid JSON");
  });

  it("enforces aggregate bytes across individually valid responses", async () => {
    const text = JSON.stringify("x".repeat(LIMITS.githubResponseBytes - 2));
    const api = githubReader("token", { fetch: async () => new Response(text) });
    for (let index = 0; index < LIMITS.githubTotalBytes / LIMITS.githubResponseBytes; index += 1) await api.request("GET /user");
    await expect(api.request("GET /user")).rejects.toThrow("response budget");
  });

  it("reads job logs as text and follows one authorized storage redirect without credentials", async () => {
    const calls: string[] = [];
    const text = "2026-11-11T00:00:00Z ##[error]dist-action is stale\n";
    const api = githubReader("test-token", { fetch: async (url, init) => {
      calls.push(String(url));
      if (calls.length === 1) {
        expect(init?.redirect).toBe("manual");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
        return new Response(null, { status: 302, headers: { location: "https://results.blob.core.windows.net/logs/job?sig=test" } });
      }
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(text);
    } });
    expect(await api.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", { owner: "acme", repo: "widgets", job_id: 1 }))
      .toMatchObject({ data: text });
    expect(calls).toHaveLength(2);
    const direct = githubReader("token", { fetch: async () => new Response(text) });
    expect((await direct.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", { owner: "acme", repo: "widgets", job_id: 1 })).data).toBe(text);
  });

  it.each([
    "https://evil.example/log", "http://results.blob.core.windows.net/log", "https://results.blob.core.windows.net.evil.example/log",
    "https://user:pass@results.blob.core.windows.net/log", "https://results.blob.core.windows.net:444/log", "not a URL",
  ])("rejects unsafe log redirects: %s", async (location) => {
    let calls = 0;
    const api = githubReader("token", { fetch: async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location } });
    } });
    await expect(api.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", { owner: "acme", repo: "widgets", job_id: 1 }))
      .rejects.toThrow(/log download/);
    expect(calls).toBe(1);
  });

  it("applies the same byte and deadline budgets to downloaded log bodies", async () => {
    const api = githubReader("token", { responseBytes: 16, fetch: async (url) =>
      new URL(String(url)).hostname === "api.github.com"
        ? new Response(null, { status: 302, headers: { location: "https://results.blob.core.windows.net/log" } })
        : new Response("x".repeat(17)) });
    await expect(api.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", { owner: "acme", repo: "widgets", job_id: 1 }))
      .rejects.toThrow("response budget");
    let cancelled = false;
    const stalled = githubReader("token", { timeoutMs: 20, fetch: async (url) =>
      new URL(String(url)).hostname === "api.github.com"
        ? new Response(null, { status: 302, headers: { location: "https://results.blob.core.windows.net/log" } })
        : new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    await expect(stalled.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", { owner: "acme", repo: "widgets", job_id: 1 }))
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(cancelled).toBe(true);
  });

  it("aborts stalled response bodies, parent cancellation, and excessive request counts", async () => {
    let cancelled = false;
    const stalled = githubReader("token", { timeoutMs: 20, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    await expect(stalled.request("GET /user")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(cancelled).toBe(true);
    const stop = new AbortController();
    stop.abort();
    const aborted = githubReader("token", { signal: stop.signal, fetch: async () => { throw new Error("Must not fetch"); } });
    await expect(aborted.request("GET /user")).rejects.toMatchObject({ name: "AbortError" });
    const many = githubReader("token", { fetch: async () => Response.json({}) });
    for (let index = 0; index < LIMITS.githubRequests; index += 1) await many.request("GET /user");
    await expect(many.request("GET /user")).rejects.toThrow("request budget");
  });
});

describe("repository-bound read capabilities", () => {
  it("reauthorizes before every read and refuses identity changes and write routes", async () => {
    let id = 42;
    let pull = true;
    const routes: string[] = [];
    const client: GitHubClient = { async request(route) {
      routes.push(route);
      return { data: route === "GET /repos/{owner}/{repo}" ? { id, full_name: "acme/widgets", permissions: { pull } } : [] };
    } };
    const access = { client, allow: ["acme/widgets"], repositoryIds: new Map([["acme/widgets", 42]]), requirePull: true };
    const target = await resolveRepository(access, "acme/widgets");
    const reader = repositoryReader(access, target);
    await reader.request("GET /repos/{owner}/{repo}/actions/runs", target.repo);
    expect(routes).toEqual(["GET /repos/{owner}/{repo}", "GET /repos/{owner}/{repo}", "GET /repos/{owner}/{repo}/actions/runs"]);
    for (const route of ["POST /repos/{owner}/{repo}/issues", "DELETE /repos/{owner}/{repo}", "GET /user"]) {
      await expect(reader.request(route, target.repo)).rejects.toThrow("Only read-only requests");
    }
    await expect(reader.request("GET /repos/{owner}/{repo}/actions/runs", { owner: "other", repo: "widgets" })).rejects.toThrow("authorized repository");
    expect(routes).toHaveLength(3);
    id = 99;
    await expect(reader.request("GET /repos/{owner}/{repo}/actions/runs", target.repo)).rejects.toThrow("identity changed");
    id = 42; pull = false;
    await expect(reader.request("GET /repos/{owner}/{repo}/actions/runs", target.repo)).rejects.toThrow("access denied");
    expect(routes.slice(3).every((route) => route === "GET /repos/{owner}/{repo}")).toBe(true);
  });
});
