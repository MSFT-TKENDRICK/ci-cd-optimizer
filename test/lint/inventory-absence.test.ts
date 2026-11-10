import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, lint, type LintConfig } from "../../src/lint/api.js";
import { selectInventory } from "../../src/lint/inventory.js";
import type { AnalysisInput } from "../../src/lint/types.js";

const WORKFLOW = ".github/workflows/ci.yml";
const workflow = (...steps: string[]): string =>
  ["on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", ...steps, ""].join("\n");
const FLAKE = '{ inputs.nixpkgs.url = "github:NixOS/nixpkgs"; outputs = { self, nixpkgs }: {}; }';
const LOCK = JSON.stringify({
  version: 7, root: "root",
  nodes: {
    root: { inputs: { nixpkgs: "nixpkgs" } },
    nixpkgs: { locked: { type: "github", owner: "NixOS", repo: "nixpkgs", rev: "a".repeat(40) } },
  },
});
const cases: { ruleId: string; excluded: string; files: Record<string, string> }[] = [
  {
    ruleId: "nix/missing-flake-lock", excluded: "flake.lock",
    files: { "flake.nix": FLAKE, "flake.lock": LOCK },
  },
  {
    ruleId: "toolchains/bazel-missing-version-pin", excluded: ".bazelversion",
    files: { [WORKFLOW]: workflow("      - run: bazelisk test //..."), "MODULE.bazel": 'module(name = "demo")', ".bazelversion": "8.4.2" },
  },
  {
    ruleId: "toolchains/rust-toolchain-unpinned", excluded: "rust-toolchain.toml",
    files: {
      [WORKFLOW]: workflow("      - uses: dtolnay/rust-toolchain@stable", "      - run: cargo test --locked"),
      "Cargo.toml": '[package]\nname = "demo"\n',
      "rust-toolchain.toml": '[toolchain]\nchannel = "1.89.0"\n',
    },
  },
  {
    ruleId: "toolchains/gradle-build-cache-disabled", excluded: "gradle.properties",
    files: {
      [WORKFLOW]: workflow("      - run: ./gradlew build"), "settings.gradle.kts": 'rootProject.name = "demo"\n',
      "gradle.properties": "org.gradle.caching=true\n",
    },
  },
  {
    ruleId: "nix/no-lock-update-automation", excluded: ".github/workflows/update.yml",
    files: {
      "flake.nix": FLAKE, "flake.lock": LOCK,
      ".github/workflows/update.yml": "on: workflow_dispatch\njobs:\n  update:\n    runs-on: ubuntu-latest\n    steps:\n      - run: nix flake update\n",
    },
  },
  {
    ruleId: "nix/no-lock-update-automation", excluded: ".renovaterc.json5",
    files: { "flake.nix": FLAKE, "flake.lock": LOCK, ".renovaterc.json5": '{"nix": {"enabled": true}}' },
  },
];
const input = (files: Record<string, string>): AnalysisInput => ({
  files: Object.entries(files).map(([path, content]) => ({ path, content })),
  mode: "repository", inventoryComplete: true,
});
const config = (ruleId: string, ignorePaths: string[] = []): LintConfig => ({
  ...structuredClone(DEFAULT_CONFIG), extends: [], ignorePaths, rules: { [ruleId]: "warn" },
});

describe("exclusions are not negative cross-file evidence", () => {
  it.each(cases)("$ruleId does not mistake ignored $excluded for missing configuration", ({ ruleId, excluded, files }) => {
    const raw = input(files);
    const settings = config(ruleId, [excluded]);
    const selection = selectInventory(raw.files, settings);
    expect(selection.paths).not.toContain(excluded);
    expect(selection).toMatchObject({ complete: false, selectionComplete: true });

    expect(lint({ input: raw, config: config(ruleId) }).diagnostics).toEqual([]);
    const missing = input(Object.fromEntries(Object.entries(files).filter(([path]) => path !== excluded)));
    expect(lint({ input: missing, config: config(ruleId) }).diagnostics).toHaveLength(1);

    const selected = { ...raw, files: raw.files.filter((file) => selection.paths.includes(file.path)), inventoryComplete: selection.complete };
    for (const supplied of [raw, selected]) {
      const before = structuredClone(supplied);
      const result = lint({ input: supplied, config: settings });
      expect(result.diagnostics).toEqual([]);
      expect(result.parseProblems).toEqual([]);
      expect(result.skipped.map((entry) => entry.ruleId)).toContain(ruleId);
      expect(supplied).toEqual(before);
    }
  });

  it.each([
    ["", "flake.lock"], ["infra/", "infra/flake.lock"], ["infra/", "**/flake.lock"], ["infra/", "**/*.lock"],
  ])("honors the expected %sflake.lock exclusion %s even for prefiltered API input", (dir, ignore) => {
    const ruleId = "nix/missing-flake-lock";
    const files = { [`${dir}flake.nix`]: FLAKE };
    const result = lint({ input: input(files), config: config(ruleId, [ignore]) });
    expect(result.diagnostics).toEqual([]);
    expect(result.parseProblems).toEqual([]);
    expect(result.rulesRun).toBe(1);
    expect(lint({ input: input(files), config: config(ruleId) }).diagnostics).toHaveLength(1);
  });

  it("does not suppress a genuinely missing lock because of an unmatched unrelated ignore", () => {
    const ruleId = "nix/missing-flake-lock";
    const raw = input({ "flake.nix": FLAKE });
    const settings = config(ruleId, ["other/flake.lock"]);
    expect(selectInventory(raw.files, settings)).toMatchObject({ complete: true, selectionComplete: true });
    expect(lint({ input: raw, config: settings }).diagnostics).toHaveLength(1);
    expect(lint({ input: { ...raw, inventoryComplete: false }, config: settings }).diagnostics).toEqual([]);
  });
});
