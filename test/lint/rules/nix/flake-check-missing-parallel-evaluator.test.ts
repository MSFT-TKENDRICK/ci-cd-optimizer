import { describe, expect, it } from "vitest";
import { parseNix } from "../../../../src/lint/parsers/nix.js";
import rule, { countFlakeOutputs } from "../../../../src/lint/rules/nix/flake-check-missing-parallel-evaluator.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;
const head = (installer = "cachix/install-nix-action@v31") => ["on: push", "jobs:", "  check:", "    runs-on: ubuntu-latest", "    steps:", `      - uses: ${installer}`];
const workflow = (...steps: string[]) => yml(...head(), ...steps);

/** A flake whose `checks.x86_64-linux` attribute set has `count` entries. */
const checksFlake = (count: number): string =>
  nix(
    "{",
    '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";',
    "  outputs = { self, nixpkgs }: {",
    "    checks.x86_64-linux = {",
    ...Array.from({ length: count }, (_, index) => `      c${index} = nixpkgs.legacyPackages.x86_64-linux.hello;`),
    "    };",
    "  };",
    "}",
  );

const dottedFlake = nix(
  "{",
  "  outputs = { self, nixpkgs }: {",
  ...["a", "b", "c", "d", "e", "f"].map((name) => `    packages.x86_64-linux.${name} = nixpkgs.legacyPackages.x86_64-linux.${name};`),
  '    packages."aarch64-linux".a = nixpkgs.legacyPackages.aarch64-linux.a;',
  "    devShells.x86_64-linux = {",
  "      default = nixpkgs.legacyPackages.x86_64-linux.mkShell { };",
  "      docs = nixpkgs.legacyPackages.x86_64-linux.mkShell { };",
  "      ci = nixpkgs.legacyPackages.x86_64-linux.mkShell { };",
  "      lint = nixpkgs.legacyPackages.x86_64-linux.mkShell { };",
  "    };",
  "  };",
  "}",
);

const flakeUtilsFlake = nix(
  "{",
  "  outputs = { self, nixpkgs, flake-utils }:",
  "    flake-utils.lib.eachDefaultSystem (system:",
  "      let pkgs = nixpkgs.legacyPackages.${system}; in {",
  "        packages = { server = pkgs.hello; client = pkgs.hello; default = pkgs.hello; };",
  "        checks.fmt = pkgs.hello;",
  "        checks.lint = pkgs.hello;",
  "        devShells.default = pkgs.mkShell { };",
  "      });",
  "}",
);

const forAllSystemsFlake = nix(
  "{",
  "  outputs = { self, nixpkgs }:",
  "    let forAllSystems = nixpkgs.lib.genAttrs [ \"x86_64-linux\" \"aarch64-darwin\" ]; in {",
  "      packages = forAllSystems (system: { a = 1; b = 2; c = 3; });",
  "      checks = forAllSystems (system: let pkgs = nixpkgs.legacyPackages.${system}; in { d = 1; e = 2; });",
  "    };",
  "}",
);

ruleTester(rule, {
  valid: [
    {
      name: "dev-shell child configuration is not inferred from the outer installer",
      files: {
        ".github/workflows/ci.yml": yml(...head("DeterminateSystems/nix-installer-action@v16"), "      - run: nix develop -c nix flake check"),
        "flake.nix": checksFlake(10),
      },
    },
    { name: "fewer outputs than the threshold", files: { ".github/workflows/ci.yml": workflow("      - run: nix flake check"), "flake.nix": checksFlake(9) } },
    {
      name: "nix-fast-build already used in the workflow",
      files: {
        ".github/workflows/ci.yml": workflow("      - run: nix flake check --no-build", "      - run: nix run github:Mic92/nix-fast-build -- --skip-cached --no-nom"),
        "flake.nix": checksFlake(20),
      },
    },
    {
      name: "a nix-fast-build step elsewhere covers the flake check",
      files: { ".github/workflows/ci.yml": workflow("      - run: nix flake check", "      - run: nix-fast-build --no-nom"), "flake.nix": checksFlake(20) },
    },
    {
      name: "Determinate Nix evaluates in parallel",
      files: { ".github/workflows/ci.yml": yml(...head("DeterminateSystems/determinate-nix-action@v3"), "      - run: nix flake check"), "flake.nix": checksFlake(20) },
    },
    {
      name: "nix-installer-action v23+ installs Determinate Nix by default",
      files: { ".github/workflows/ci.yml": yml(...head("DeterminateSystems/nix-installer-action@v23"), "      - run: nix flake check"), "flake.nix": checksFlake(20) },
    },
    { name: "evaluation only", files: { ".github/workflows/ci.yml": workflow("      - run: nix flake check --no-build"), "flake.nix": checksFlake(20) } },
    { name: "a remote flake is not this repository's", files: { ".github/workflows/ci.yml": workflow("      - run: nix flake check github:owner/repo"), "flake.nix": checksFlake(20) } },
    {
      name: "a generated job matrix already splits the work",
      files: {
        ".github/workflows/ci.yml": yml(
          "on: push",
          "jobs:",
          "  check:",
          "    runs-on: ubuntu-latest",
          "    strategy:",
          "      matrix: ${{ fromJSON(needs.eval.outputs.matrix) }}",
          "    steps:",
          "      - uses: cachix/install-nix-action@v31",
          "      - run: nix flake check",
        ),
        "flake.nix": checksFlake(20),
      },
    },
    {
      name: "the flake exports a nix-github-actions matrix",
      files: {
        ".github/workflows/ci.yml": workflow("      - run: nix flake check"),
        "flake.nix": checksFlake(20).replace("  };\n}", "    githubActions = nix-github-actions.lib.mkGithubMatrix { checks = self.checks; };\n  };\n}"),
      },
    },
    { name: "no flake in the repository", files: workflow("      - run: nix flake check") },
    {
      name: "re-exported outputs are not counted",
      files: {
        ".github/workflows/ci.yml": workflow("      - run: nix flake check"),
        "flake.nix": nix(
          "{",
          "  outputs = { self, nixpkgs }: {",
          "    packages = nixpkgs.lib.genAttrs [ \"x86_64-linux\" ] (system: import ./packages.nix { inherit system; });",
          "    checks = self.packages;",
          "  };",
          "}",
        ),
      },
    },
    {
      name: "the checked flake is a different, small one",
      files: {
        ".github/workflows/ci.yml": workflow("      - run: nix flake check ./tools"),
        "flake.nix": checksFlake(20),
        "tools/flake.nix": checksFlake(2),
      },
    },
  ],
  invalid: [
    {
      name: "an attribute set of checks",
      files: { ".github/workflows/ci.yml": workflow("      - run: nix flake check -L"), "flake.nix": checksFlake(10) },
      errors: [{ line: 7, messageIncludes: "`nix flake check -L` in job `check` checks `flake.nix`, with 10 syntactically recognized output names (checks). This is not an evaluated-output count or timing measurement; profile evaluation before considering a parallel evaluator." }],
    },
    {
      name: "dotted output paths across systems are merged",
      files: { ".github/workflows/ci.yml": workflow("      - run: nix flake check"), "flake.nix": dottedFlake },
      errors: [{ line: 7, messageIncludes: "`nix flake check` in job `check` checks `flake.nix`, with 10 syntactically recognized output names (packages, devShells). This is not an evaluated-output count or timing measurement; profile evaluation before considering a parallel evaluator." }],
    },
    {
      name: "flake-utils style outputs with a lower threshold",
      options: { threshold: 6 },
      files: { ".github/workflows/ci.yml": workflow("      - run: nix flake check"), "flake.nix": flakeUtilsFlake },
      errors: [{ line: 7, messageIncludes: "`nix flake check` in job `check` checks `flake.nix`, with 6 syntactically recognized output names (checks, packages, devShells). This is not an evaluated-output count or timing measurement; profile evaluation before considering a parallel evaluator." }],
    },
    {
      name: "per-system helper functions",
      options: { threshold: 5 },
      files: { ".github/workflows/ci.yml": workflow("      - run: nix flake check"), "flake.nix": forAllSystemsFlake },
      errors: [{ line: 7, messageIncludes: "`nix flake check` in job `check` checks `flake.nix`, with 5 syntactically recognized output names (checks, packages). This is not an evaluated-output count or timing measurement; profile evaluation before considering a parallel evaluator." }],
    },
    {
      name: "a subdirectory flake checked through working-directory",
      files: {
        ".github/workflows/ci.yml": workflow("      - run: nix flake check", "        working-directory: nix"),
        "nix/flake.nix": checksFlake(12),
      },
      errors: [{ line: 7, messageIncludes: "`nix/flake.nix`" }],
    },
    {
      name: "a subdirectory flake checked by path from the root",
      files: { ".github/workflows/ci.yml": workflow("      - run: nix flake check ./nix"), "nix/flake.nix": checksFlake(12) },
      errors: [{ line: 7, messageIncludes: "`nix flake check ./nix`" }],
    },
  ],
});

describe("nix-fast-build suggestion", () => {
  const suggestion = (directory: string | undefined, command: string, flakePath: string): string | undefined =>
    runRule(rule, {
      files: {
        ".github/workflows/ci.yml": workflow(`      - run: ${command}`, ...(directory ? [`        working-directory: ${directory}`] : [])),
        [flakePath]: checksFlake(12),
      },
    })[0]?.suggestion;

  it("selects local checks without recommending execution of a floating evaluator", () => {
    for (const text of [suggestion(undefined, "nix flake check", "flake.nix"), suggestion("nix", "nix flake check", "nix/flake.nix")]) {
      expect(text).toContain("`--flake .#checks`");
      expect(text).toContain("reviewed, lock-pinned");
      expect(text).toContain("Retain `nix flake check --no-build`");
      expect(text).not.toContain("nix run github:");
    }
  });

  it("points --flake at a subdirectory flake", () => {
    expect(suggestion(undefined, "nix flake check ./nix", "nix/flake.nix")).toContain("`--flake ./nix#checks`");
    expect(suggestion("tools", "nix flake check ../nix", "nix/flake.nix")).toContain("`--flake ../nix#checks`");
  });
});

describe("countFlakeOutputs", () => {
  const count = (source: string) => countFlakeOutputs(parseNix("flake.nix", source));

  it("ignores attribute sets passed as function arguments", () => {
    expect(count("{ outputs = { self }: { packages = mk { inherit self; a = 1; }; }; }").count).toBe(0);
  });

  it("counts names in let bodies, rec sets and inherits", () => {
    expect(count("{ outputs = { self, p }: { checks = let x = 1; in { a = x; b = x; }; packages = rec { inherit (p) c d; e = c; }; }; }")).toEqual({
      count: 5,
      heads: ["checks", "packages"],
    });
  });

  it("does not count comments, strings or attribute selections", () => {
    expect(count('{ outputs = _: { apps.x86_64-linux.run = { type = "app"; program = "checks.a = 1"; }; # packages.b = 1;\n meta = self.packages.c; }; }')).toEqual({
      count: 1,
      heads: ["apps"],
    });
  });
});
