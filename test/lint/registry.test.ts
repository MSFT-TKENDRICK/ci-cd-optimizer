import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_API_VERSION, lint } from "../../src/lint/api.js";
import { DEFAULT_CONFIG, resolveRules } from "../../src/lint/config.js";
import { allRules, RULESETS } from "../../src/lint/rules/index.js";
import type { AnyRule, Preset } from "../../src/lint/types.js";

describe("complete built-in rule registration", () => {
  it("registers every shipped rule module exactly once", async () => {
    const root = join(process.cwd(), "src", "lint", "rules");
    const directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    const exported: string[] = [];
    for (const directory of directories) {
      const files = await readdir(join(root, directory.name));
      for (const file of files.filter((name) => name.endsWith(".ts") && name !== "index.ts")) {
        const module = await import(pathToFileURL(join(root, directory.name, file)).href) as { default?: AnyRule };
        if (module.default?.meta) exported.push(module.default.meta.id);
      }
    }
    const registered = allRules.map((rule) => rule.meta.id);
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered.toSorted()).toEqual(exported.toSorted());
    expect([...new Set(allRules.map((rule) => rule.meta.ruleset))].sort()).toEqual([...RULESETS].sort());
    expect(ENGINE_API_VERSION).toBe(1);
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    expect(readme).toContain(`${allRules.length} rules in ${RULESETS.length} rulesets`);
  });

  it.each(["recommended", "strict", "agentic", "github", "insights", "all"] satisfies Preset[])(
    "enables exactly the declared %s preset", (preset) => {
      const expected = allRules.filter((rule) => preset === "all" || rule.meta.presets.includes(preset)).map((rule) => rule.meta.id);
      expect(resolveRules({ ...DEFAULT_CONFIG, extends: [preset] }, allRules).map(({ rule }) => rule.meta.id)).toEqual(expected);
    },
  );

  it("permits explicit Nix and toolchain group selection without any preset", () => {
    const selected = resolveRules({ ...DEFAULT_CONFIG, extends: [], rulesets: { nix: "warn", toolchains: "warn" } }, allRules);
    expect(selected).toHaveLength(47);
    expect(selected.every(({ rule }) => !rule.meta.fixable)).toBe(true);
  });

  it("fires representative additions through the unchanged public API", () => {
    const result = lint({
      input: {
        mode: "repository",
        inventoryComplete: true,
        files: [
          { path: "flake.nix", content: '{ inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable"; outputs = { self, nixpkgs }: {}; }\n' },
          { path: "Cargo.toml", content: '[package]\nname = "demo"\nversion = "1.0.0"\n' },
          { path: "Cargo.lock", content: "version = 4\n" },
          { path: "Dockerfile", content: "FROM alpine:3.22\nRUN curl -fsSL https://example.com/install.sh | sh\n" },
          { path: ".github/workflows/ci.yml", content: [
            "on: [push, pull_request]", "jobs:", "  build:", "    runs-on: ${{ matrix.os }}",
            "    strategy:", "      matrix:", "        os: [ubuntu-24.04, macos-latest]", "    steps:",
            "      - uses: actions/cache@v6", "        with:", "          path: node_modules",
            "          key: modules-${{ hashFiles('package-lock.json') }}", "      - run: cargo test", "",
          ].join("\n") },
        ],
      },
      presets: ["all"],
    });
    expect(result.parseProblems).toEqual([]);
    expect(result.skipped.filter((entry) => entry.reason.startsWith("rule crashed"))).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual(expect.arrayContaining([
      "nix/missing-flake-lock", "toolchains/rust-missing-locked-flag", "containers/curl-pipe-shell",
      "workflow/duplicate-push-pull-request-trigger", "caching/matrix-cache-key-missing-os",
    ]));
  });
});
