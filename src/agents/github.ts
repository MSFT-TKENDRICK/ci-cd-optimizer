import type { GitHubClient } from "../github/client.js";
import { RequestError } from "../github/rest.js";
import { AgentError, LIMITS } from "./safety.js";

export interface GitHubReaderOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** Explicit API origin, never taken from repository content. Hosted mode uses GitHub.com only. */
  baseUrl?: string;
  timeoutMs?: number;
  responseBytes?: number;
}

/** A new reader per operation: GET only, no redirects, bounded bytes/request count/deadlines, and no ambient credentials. */
export function githubReader(token: string, options: GitHubReaderOptions = {}): GitHubClient {
  const base = new URL(options.baseUrl ?? "https://api.github.com");
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new AgentError("GitHub API URL must be an HTTPS URL without credentials, query, or fragment.");
  const request = options.fetch ?? fetch;
  let requests = 0;
  let totalBytes = 0;
  return {
    async request(route, parameters = {}) {
      options.signal?.throwIfAborted();
      if (!/^GET \/(?:user|repos\/\{owner\}\/\{repo\}(?:\/[a-zA-Z0-9_{}/-]+)?)$/.test(route)) {
        throw new AgentError("Agent GitHub access permits only repository GET requests and user authentication.");
      }
      if (++requests > LIMITS.githubRequests) throw new AgentError("GitHub request budget exceeded; narrow the operation.");
      const remaining = { ...parameters };
      const path = route.slice(4).replace(/\{(\w+)\}/g, (_match, key: string) => {
        const value = remaining[key];
        delete remaining[key];
        if (typeof value !== "string" && typeof value !== "number") throw new AgentError("Invalid GitHub route parameter.");
        if (value === "." || value === "..") throw new AgentError("GitHub route parameters must not be dot segments.");
        // Encode slashes too: a ref/path is data, never another API route.
        return encodeURIComponent(String(value));
      });
      const url = new URL(`${base.href.replace(/\/$/, "")}${path}`);
      for (const [key, value] of Object.entries(remaining)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      const deadline = AbortSignal.timeout(options.timeoutMs ?? LIMITS.httpMs);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      const response = await request(url, {
        method: "GET", redirect: "error", signal,
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "ci-cd-optimizer-agents" },
      });
      const limit = options.responseBytes ?? LIMITS.githubResponseBytes;
      const reader = response.body?.getReader();
      const abortRead = () => { void reader?.cancel(signal.reason).catch(() => undefined); };
      signal.addEventListener("abort", abortRead, { once: true });
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        if (Number(response.headers.get("content-length")) > limit) throw new AgentError("GitHub response exceeds the byte limit.");
        if (reader) for (;;) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          totalBytes += part.value.byteLength;
          if (size > limit || totalBytes > LIMITS.githubTotalBytes) throw new AgentError("GitHub response budget exceeded; narrow the operation.");
          chunks.push(part.value);
        }
      } finally {
        signal.removeEventListener("abort", abortRead);
        await reader?.cancel().catch(() => undefined);
        reader?.releaseLock();
      }
      signal.throwIfAborted();
      if (!response.ok) throw new RequestError(`GitHub read failed (${response.status}).`, response.status);
      try {
        return { status: response.status, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
      } catch {
        throw new AgentError("GitHub returned invalid JSON.");
      }
    },
  };
}
