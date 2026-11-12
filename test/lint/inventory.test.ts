import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadRepositorySnapshot } from "../../src/github/repository.js";
import { DEFAULT_CONFIG } from "../../src/lint/config.js";
import { lint } from "../../src/lint/engine.js";
import { changedSince, isInventoryPath, loadDirectory, loadGitRevision, selectInventory } from "../../src/lint/inventory.js";
import { allRules } from "../../src/lint/rules/index.js";
import { fakeClient, repo } from "../experiments/fixtures.js";

const exec = promisify(execFile);
const roots: string[] = [];
const paths = [
  ".github/workflows/ci.yml", "flake.nix", "flake.lock", "sub/UPPER.NIX", "nested name/default.nix",
  ".envrc", "devenv.yaml", "devenv.lock", "Cargo.toml", "Cargo.lock", ".cargo/config.toml",
  "rust-toolchain.toml", ".bazelversion", ".bazeliskrc", ".python-version", ".go-version", ".java-version",
  ".sdkmanrc", "gradle.properties", "gradle/wrapper/gradle-wrapper.properties", "go.work", "uv.lock",
  "requirements/ci.txt", "requirements-extra.txt", "docker/app.containerfile", "docker/app.dockerignore",
  ".github/renovate.json5", ".renovaterc.json", ".renovaterc.json5", "pnpm-workspace.yaml",
  ".github/workflows/actions.lock",
];
const contents: Record<string, string> = Object.fromEntries(paths.map((path) => [path, "\n"]));
Object.assign(contents, {
  ".github/workflows/ci.yml": "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v6\n      - run: cargo test\n",
  "Cargo.toml": '[package]\nname = "demo"\nversion = "1.0.0"\n',
  "Cargo.lock": "version = 4\n",
  "flake.nix": "{ outputs = { self }: {}; }\n",
  "flake.lock": '{"version":7,"root":"root","nodes":{"root":{}}}\n',
  "sub/UPPER.NIX": "builtins.currentSystem\n",
});

const git = async (root: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd: root })).stdout.trim();

async function fixture(files: Record<string, string> = contents): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".inventory-test-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  await git(root, "init", "--quiet");
  await git(root, "-c", "core.autocrlf=false", "add", "--all");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shared repository inventory", () => {
  it.each(paths)("includes %s", (path) => expect(isInventoryPath(path)).toBe(true));

  it.each(["node_modules/example/flake.nix", "target/build/Cargo.toml", ".direnv/flake.nix", "src/index.ts"])(
    "excludes generated or unsupported content %s", (path) => expect(isInventoryPath(path)).toBe(false),
  );

  it("has identical directory, git-tree and API inputs and diagnostics", async () => {
    const root = await fixture();
    const tree = await git(root, "write-tree");
    const remote = fakeClient((route, parameters) => {
      if (route.includes("/commits/")) return { sha: "commit", commit: { tree: { sha: tree } } };
      if (route.includes("/git/trees/")) return { tree: paths.map((path) => ({
        path, type: "blob", mode: "100644", sha: path, size: Buffer.byteLength(contents[path] ?? ""),
      })) };
      if (route.includes("/git/blobs/")) return {
        content: Buffer.from(contents[String(parameters.file_sha)] ?? "").toString("base64"), encoding: "base64",
      };
      throw new Error(`Unexpected route ${route}`);
    });
    const local = await loadDirectory(root, DEFAULT_CONFIG);
    const revision = await loadGitRevision(root, tree, DEFAULT_CONFIG);
    const api = (await loadRepositorySnapshot(remote, repo, { ref: "main", config: DEFAULT_CONFIG })).input;
    expect(local.inventoryComplete).toBe(true);
    expect(revision.inventoryComplete).toBe(true);
    expect(api.inventoryComplete).toBe(true);
    expect(local.files.map((file) => file.path).sort()).toEqual([...paths].sort());
    expect(revision.files).toEqual(local.files);
    expect(api.files).toEqual(local.files);
    const results = [local, revision, api].map((input) => lint(input, { config: DEFAULT_CONFIG, rules: allRules }));
    expect(results.map((result) => result.filesAnalyzed)).toEqual([paths.length, paths.length, paths.length]);
    expect(results[0]?.diagnostics).toEqual(results[1]?.diagnostics);
    expect(results[0]?.diagnostics).toEqual(results[2]?.diagnostics);
    expect(results[0]?.diagnostics.some((diagnostic) => diagnostic.ruleId === "toolchains/rust-missing-locked-flag")).toBe(true);
    expect(results[0]?.diagnostics.some((diagnostic) => diagnostic.path === "sub/UPPER.NIX")).toBe(true);
    expect(results.flatMap((result) => result.skipped).filter((entry) => entry.reason.startsWith("rule crashed"))).toEqual([]);
  }, 30_000);

  it("preserves ignored lock uncertainty identically in directory, git-tree and API inventories", async () => {
    const files = { "flake.nix": '{ outputs = { self, nixpkgs }: {}; }', "flake.lock": contents["flake.lock"]! };
    const root = await fixture(files);
    const tree = await git(root, "write-tree");
    const config = { ...DEFAULT_CONFIG, ignorePaths: ["flake.lock"] };
    const remote = fakeClient((route, parameters) => {
      if (route.includes("/commits/")) return { sha: "commit", commit: { tree: { sha: tree } } };
      if (route.includes("/git/trees/")) return { tree: Object.keys(files).map((path) => ({ path, type: "blob", mode: "100644", sha: path })) };
      if (route.includes("/git/blobs/") && parameters.file_sha === "flake.nix") return { content: files["flake.nix"], encoding: "utf-8" };
      throw new Error(`Unexpected read of excluded content: ${route}`);
    });
    const snapshot = await loadRepositorySnapshot(remote, repo, { ref: "main", config });
    expect(snapshot.selectionComplete).toBe(true);
    for (const input of [await loadDirectory(root, config), await loadGitRevision(root, tree, config), snapshot.input]) {
      expect(input.inventoryComplete).toBe(false);
      expect(input.files).toEqual([{ path: "flake.nix", content: files["flake.nix"] }]);
      expect(lint(input, { config, rules: allRules }).diagnostics.filter((entry) => entry.ruleId === "nix/missing-flake-lock")).toEqual([]);
    }
  }, 30_000);

  it("does not traverse directory links or mistake their absence for complete input", async () => {
    const root = await fixture({ "real/flake.nix": "{}" });
    await symlink(join(root, "real"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const input = await loadDirectory(root, DEFAULT_CONFIG);
    expect(input.files.map((file) => file.path)).toEqual(["real/flake.nix"]);
    expect(input.inventoryComplete).toBe(false);
    expect((await loadDirectory(root, { ...DEFAULT_CONFIG, ignorePaths: ["linked"] })).inventoryComplete).toBe(false);
  });

  it("preserves whitespace and non-ASCII names in staged and untracked changes", async () => {
    const root = await fixture({ "Cargo.toml": "" });
    const tree = await git(root, "write-tree");
    const base = await git(root, "-c", "user.name=Inventory test", "-c", "user.email=inventory@example.invalid",
      "commit-tree", tree, "-m", "Inventory fixture\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>");
    await git(root, "update-ref", "HEAD", base);
    await writeFile(join(root, " leading name.nix"), "{}", "utf8");
    await git(root, "add", "--", " leading name.nix");
    await writeFile(join(root, "unicodé.nix"), "{}", "utf8");
    expect((await changedSince(root, base)).changedPaths.sort()).toEqual([" leading name.nix", "unicodé.nix"]);
  }, 30_000);

  it("treats git symlinks and submodules as opaque without reading their content", async () => {
    const root = await fixture({ "flake.nix": "{}" });
    const object = await git(root, "hash-object", "-w", join(root, "flake.nix"));
    await git(root, "update-index", "--add", "--cacheinfo", `120000,${object},linked.nix`);
    // A gitlink only stores an object id; the tree loader must not try to resolve it as a source file.
    await git(root, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},nested-project`);
    const tree = await git(root, "write-tree", "--missing-ok");
    const input = await loadGitRevision(root, tree, DEFAULT_CONFIG);
    expect(input.files.map((file) => file.path)).toEqual(["flake.nix"]);
    expect(input.inventoryComplete).toBe(false);
  });

  it("distinguishes content-bearing Nix locks from presence-only oversized locks", async () => {
    const config = { ...DEFAULT_CONFIG, limits: { ...DEFAULT_CONFIG.limits, maxFileBytes: 16 } };
    const entries = ["Cargo.lock", "flake.lock", "devenv.lock"].map((path) => ({ path, size: 20_000 }));
    expect(selectInventory(entries, config)).toEqual({ paths: ["Cargo.lock"], truncated: ["Cargo.lock"], complete: false, selectionComplete: false });
    const root = await fixture({ "Cargo.lock": "x".repeat(20_000) });
    const input = await loadDirectory(root, config);
    expect(input.inventoryComplete).toBe(true);
    expect(input.truncated).toEqual(["Cargo.lock"]);
    expect(input.files[0]?.content).toHaveLength(8192);
  });

  it("counts file limits and explicit ignores identically for all path types", () => {
    const config = { ...DEFAULT_CONFIG, limits: { ...DEFAULT_CONFIG.limits, maxFiles: 1 } };
    const entries = [{ path: "flake.nix" }, { path: "sub/flake.nix" }];
    expect(selectInventory(entries, config).complete).toBe(false);
    expect(selectInventory(entries, { ...config, ignorePaths: ["sub"] })).toEqual({ paths: ["flake.nix"], truncated: [], complete: false, selectionComplete: true });
    expect(selectInventory([{ path: "node_modules/link", opaque: true }], config).complete).toBe(true);
  });
});
