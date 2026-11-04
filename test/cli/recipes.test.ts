import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/index.js";
import type { CliIO } from "../../src/cli/io.js";
import { serializeManifest } from "../../src/experiments/manifest.js";
import type { GitHubClient } from "../../src/github/client.js";
import { restClient } from "../../src/github/rest.js";
import { parseRecipe, serializeRecipe } from "../../src/recipes/recipe.js";
import { sampleManifest } from "../experiments/fixtures.js";
import { MISSING_TIMEOUT, sampleRecipe } from "../recipes/fixtures.js";
import { server } from "../recipes/server.js";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cicd-recipes-")));
  await write("recipes/job-timeouts.yml", serializeRecipe(sampleRecipe()));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
}

function cli(client?: GitHubClient & { calls?: Array<{ route: string }> }) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { cwd: root, env: {}, stdout: (text) => out.push(text), stderr: (text) => err.push(text), ...(client ? { github: () => client } : {}) };
  return {
    run: (...argv: string[]) => run(["recipes", ...argv], io),
    json: () => JSON.parse(out.join("\n")),
    get stdout() {
      return out.join("\n");
    },
    get stderr() {
      return err.join("\n");
    },
  };
}

const posts = (client: { calls: Array<{ route: string }> }) => client.calls.filter((call) => !call.route.startsWith("GET "));
const RECIPE = ["--recipe", "recipes/job-timeouts.yml"];
const files = { ".github/workflows/ci.yml": MISSING_TIMEOUT };

describe("recipes cli", () => {
  it("prints help and rejects bad usage", async () => {
    const help = cli();
    expect(await help.run()).toBe(0);
    expect(help.stdout).toContain("Usage: ci-cd-optimizer recipes <command>");
    expect(await cli().run("apply", "--help")).toBe(0);
    expect(await cli().run("unknown")).toBe(2);
    expect(await cli().run("apply", "--target", "acme/web")).toBe(2);
    expect(await cli().run("apply", ...RECIPE)).toBe(2);
    expect(await cli().run("apply", ...RECIPE, "--target", "not-a-repo")).toBe(2);
    expect(await cli().run("apply", "--recipe", "missing.yml", "--target", "acme/web")).toBe(2);
    expect(await cli().run("status", ...RECIPE)).toBe(2);
    expect(await cli().run("status", ...RECIPE, "--repos", "acme/web", "--targets", "t.yml")).toBe(2);
    const canary = cli();
    expect(await canary.run("rollout", ...RECIPE, "--repos", "acme/web", "--canary", "acme/api")).toBe(2);
    expect(canary.stderr).toContain("acme/api not in the targets");
    expect(await cli().run("rollout", ...RECIPE, "--repos", "acme/web", "--max-scan", "0")).toBe(2);
    expect(await cli().run("status", ...RECIPE, "--repos", "acme/web", "-f", "yaml")).toBe(2);
    await write("recipes/bad.yml", "id: nope\n");
    const bad = cli();
    expect(await bad.run("apply", "--recipe", "recipes/bad.yml", "--target", "acme/web")).toBe(2);
    expect(bad.stderr).toContain("Invalid recipe");
  });

  it("plans an apply without writing in dry-run mode", async () => {
    const client = server({ files });
    const c = cli(client);
    expect(await c.run("apply", ...RECIPE, "--target", "acme/web", "--dry-run", "-f", "json")).toBe(0);
    expect(c.json()).toMatchObject({ repo: "acme/web", status: "autofix", attempted: false, rules: ["workflow/job-timeout"] });
    expect(posts(client)).toEqual([]);
  });

  it("opens the recipe pull request", async () => {
    const client = server({ files });
    const c = cli(client);
    expect(await c.run("apply", ...RECIPE, "--target", "acme/web")).toBe(0);
    expect(c.stdout).toContain("acme/web: autofix → PR #42");
    expect(posts(client).map((call) => call.route)).toContain("POST /repos/{owner}/{repo}/pulls");
  });

  it("reports status and stores compatibility with --write", async () => {
    const client = server({ files });
    const c = cli(client);
    expect(await c.run("status", ...RECIPE, "--repos", "acme/web", "-f", "json", "--write")).toBe(0);
    const output = c.json();
    expect(output.statuses).toEqual([{ repo: "acme/web", state: "untouched" }]);
    expect(output.plan.action).toBe("advance");
    const text = cli(server({ files }));
    await text.run("status", ...RECIPE, "--repos", "acme/web");
    expect(text.stdout).toContain("| acme/web | untouched |");
  });

  it("rolls out the next wave in dry-run mode without side effects", async () => {
    const client = server({ files });
    const c = cli(client);
    expect(await c.run("rollout", ...RECIPE, "--repos", "acme/web,acme/api", "--dry-run", "--summary", "summary.md", "-f", "json")).toBe(0);
    const output = c.json();
    expect(output.plan.action).toBe("advance");
    expect(output.applied).toHaveLength(1);
    expect(output.applied[0]).toMatchObject({ status: "autofix", attempted: false });
    expect(posts(client)).toEqual([]);
    expect(await readFile(join(root, "summary.md"), "utf8")).toContain("Recipe rollout");
  });

  it("reads targets from a file", async () => {
    await write("targets.yml", "repositories: [acme/web]\n");
    const c = cli(server({ files }));
    expect(await c.run("status", ...RECIPE, "--targets", "targets.yml", "-f", "json")).toBe(0);
    expect(c.json().statuses).toHaveLength(1);
  });

  describe("publish", () => {
    const manifest = sampleManifest({ name: "job-timeouts", kind: "pipeline", status: "promoted", winner: "packagemanager", applicability: { rules: ["workflow/job-timeout"] } });
    const pulls = [
      {
        number: 12,
        node_id: "PR_12",
        state: "closed",
        merged_at: "2026-11-03T00:00:00Z",
        closed_at: "2026-11-03T00:00:00Z",
        title: "packagemanager",
        body: null,
        labels: [],
        head: { ref: "experiments/job-timeouts/packagemanager", sha: "sha-12" },
        base: { ref: "experiments/job-timeouts/trunk" },
      },
    ];
    const pullFiles = [{ filename: ".github/workflows/ci.yml", status: "modified", patch: "@@ -3,2 +3,3 @@\n   test:\n+    timeout-minutes: 30\n     runs-on: ubuntu-24.04" }];

    it("writes the recipe once and reports unchanged afterwards", async () => {
      await rm(join(root, "recipes"), { recursive: true });
      const fake = () => server({ manifest: serializeManifest(manifest), pulls, pullFiles });
      const first = cli(fake());
      expect(await first.run("publish", "--repo", "acme/platform", "--experiment", "job-timeouts", "-f", "json"), first.stderr).toBe(0);
      expect(first.json()).toMatchObject({ id: "job-timeouts", revision: 1, changed: true, written: true, path: "recipes/job-timeouts.yml" });
      const recipe = parseRecipe(await readFile(join(root, "recipes/job-timeouts.yml"), "utf8")).recipe;
      expect(recipe?.source).toMatchObject({ repository: "acme/platform", arm: "packagemanager", pullRequest: 12 });

      const second = cli(fake());
      expect(await second.run("publish", "--repo", "acme/platform", "--experiment", "job-timeouts")).toBe(0);
      expect(second.stdout).toContain("recipes/job-timeouts.yml: unchanged");
    });

    it("skips experiments that were not promoted", async () => {
      await write("experiment.yml", serializeManifest({ ...manifest, status: "running" }));
      const c = cli(server({ pulls }));
      expect(await c.run("publish", "--repo", "acme/platform", "--manifest", "experiment.yml", "-f", "json")).toBe(0);
      expect(c.json()).toMatchObject({ experiment: "job-timeouts", skipped: true });
      expect(await cli().run("publish", "--repo", "acme/platform")).toBe(2);
      expect(await cli().run("publish", "--experiment", "job-timeouts")).toBe(2);
    });
  });
});

describe("restClient", () => {
  it("authenticates, substitutes path parameters, and raises request errors", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchStub = (async (url: URL | string, init: RequestInit = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("missing")) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, statusText: "Not Found" });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const client = restClient({ token: "secret-token", baseUrl: "https://ghe.example.com/api/v3/", fetch: fetchStub });

    expect(await client.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner: "acme", repo: "web", ref: "heads/feature/x", per_page: 10 })).toEqual({ status: 200, data: { ok: true } });
    expect(requests[0]?.url).toBe("https://ghe.example.com/api/v3/repos/acme/web/git/ref/heads/feature/x?per_page=10");
    const headers = requests[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toContain("secret-token");
    expect(requests[0]?.init.body).toBeUndefined();

    await client.request("POST /repos/{owner}/{repo}/issues", { owner: "acme", repo: "web", title: "t" });
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({ title: "t" });

    await client.request("POST /graphql", { query: "{ viewer { login } }" });
    expect(requests[2]?.url).toBe("https://ghe.example.com/api/graphql");

    await expect(client.request("GET /repos/{owner}/{repo}", { owner: "acme", repo: "missing" })).rejects.toMatchObject({ name: "RequestError", status: 404 });
    await expect(client.request("GET /repos/{owner}/{repo}", { owner: "acme" })).rejects.toThrow('Missing route parameter "repo"');
  });
});
