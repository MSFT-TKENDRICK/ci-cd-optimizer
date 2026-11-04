import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { GitHubClient } from "../../src/github/client.js";
import { uploadSarif } from "../../src/github/code-scanning.js";

function client(handler: (parameters: Record<string, unknown>) => unknown): GitHubClient & { parameters?: Record<string, unknown> } {
  const fake: GitHubClient & { parameters?: Record<string, unknown> } = {
    async request(_route, parameters = {}) {
      fake.parameters = parameters;
      return { status: 202, data: handler(parameters) };
    },
  };
  return fake;
}

describe("uploadSarif", () => {
  it("gzips and base64-encodes the SARIF log and qualifies the ref", async () => {
    const fake = client(() => ({ id: "abc" }));
    const result = await uploadSarif(fake, { owner: "o", repo: "r" }, { sarif: { version: "2.1.0", runs: [] }, commitSha: "sha", ref: "main" });
    expect(result).toEqual({ status: "uploaded", id: "abc" });
    expect(fake.parameters).toMatchObject({ commit_sha: "sha", ref: "refs/heads/main" });
    expect(JSON.parse(gunzipSync(Buffer.from(fake.parameters?.sarif as string, "base64")).toString("utf8"))).toEqual({ version: "2.1.0", runs: [] });
  });

  it("degrades gracefully when code scanning is unavailable", async () => {
    const fake = client(() => {
      throw Object.assign(new Error("Advanced Security must be enabled"), { status: 403 });
    });
    const result = await uploadSarif(fake, { owner: "o", repo: "r" }, { sarif: "{}", commitSha: "sha", ref: "refs/pull/1/head" });
    expect(result.status).toBe("unavailable");
  });

  it("rethrows unexpected failures", async () => {
    const fake = client(() => {
      throw Object.assign(new Error("boom"), { status: 500 });
    });
    await expect(uploadSarif(fake, { owner: "o", repo: "r" }, { sarif: "{}", commitSha: "sha", ref: "main" })).rejects.toThrow("boom");
  });
});
