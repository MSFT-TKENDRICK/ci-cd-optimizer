import type { GitHubClient, RepoRef } from "./client.js";

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly response?: unknown,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

/**
 * Dependency-free REST client for the CLI and Actions (`GITHUB_TOKEN`). Accepts the same `"METHOD /path/{param}"`
 * routes as Octokit: path parameters are substituted, the rest become the query (GET/DELETE) or JSON body.
 */
export function restClient(options: { token?: string; baseUrl?: string; userAgent?: string; fetch?: typeof fetch } = {}): GitHubClient {
  const baseUrl = (options.baseUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  return {
    async request(route, parameters = {}) {
      const [method = "GET", template = "/"] = route.split(" ");
      const remaining: Record<string, unknown> = { ...parameters };
      const path = template.replace(/\{([^}]+)\}/g, (_, name: string) => {
        const value = remaining[name];
        delete remaining[name];
        if (value === undefined) throw new Error(`Missing route parameter "${name}" for ${route}`);
        // `ref` in git ref routes contains slashes that must stay literal.
        return name === "ref" || name === "path" || name === "basehead" ? String(value).split("/").map(encodeURIComponent).join("/") : encodeURIComponent(String(value));
      });
      const url = new URL(path.startsWith("/graphql") && baseUrl.endsWith("/api/v3") ? `${baseUrl.replace(/\/v3$/, "")}/graphql` : `${baseUrl}${path}`);
      const hasBody = !["GET", "HEAD", "DELETE"].includes(method);
      if (!hasBody) {
        for (const [key, value] of Object.entries(remaining)) {
          if (value !== undefined) url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
        }
      }
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": options.userAgent ?? "ci-cd-optimizer",
      };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      if (hasBody) headers["content-type"] = "application/json";
      const response = await doFetch(url, { method, headers, ...(hasBody ? { body: JSON.stringify(remaining) } : {}) });
      const text = await response.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        // Non-JSON payloads (for example log downloads) are returned as text.
      }
      if (!response.ok) {
        const message = (data as { message?: string } | undefined)?.message ?? response.statusText;
        throw new RequestError(`${method} ${path} → ${response.status}: ${message}`, response.status, data);
      }
      return { status: response.status, data };
    },
  };
}

export function parseRepo(value: string | undefined): RepoRef {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value ?? "");
  if (!match) throw new Error(`Expected a repository as owner/name (got "${value ?? ""}"). Pass --repo or set GITHUB_REPOSITORY.`);
  return { owner: match[1] as string, repo: match[2] as string };
}
