import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/nix/impure-flag-in-ci.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const head = ["on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: cachix/install-nix-action@v31"];
const job = (...steps: string[]): string => yml(...head, ...steps);
const devenvFlake = yml(
  "{",
  "  inputs.nixpkgs.url = \"github:cachix/devenv-nixpkgs/rolling\";",
  "  inputs.devenv.url = \"github:cachix/devenv\";",
  "  outputs = { self, nixpkgs, devenv, ... }@inputs: { };",
  "}",
);

ruleTester(rule, {
  valid: [
    { name: "pure flake build", files: job("      - run: nix build .#app") },
    { name: "--impure after -- belongs to the program", files: job("      - run: nix run .#tool -- --impure") },
    { name: "an option named like --impure-something is not --impure", files: job("      - run: nix build .#app --impure-env FOO=bar") },
    { name: "probing builtins.currentSystem", files: job("      - run: echo \"system=$(nix eval --impure --raw --expr builtins.currentSystem)\" >> \"$GITHUB_OUTPUT\"") },
    { name: "nixGL must detect the host driver", files: job("      - run: nix run --impure github:nix-community/nixGL -- glxinfo") },
    {
      name: "devenv flake shells require --no-pure-eval",
      files: { ".github/workflows/ci.yml": job("      - run: nix develop --no-pure-eval --command devenv test"), "flake.nix": devenvFlake },
    },
    { name: "classic nix-build is not a flake evaluation", files: job("      - run: nix-build -A app") },
    { name: "pure-eval explicitly true", files: job("      - run: nix build --option pure-eval true .#app") },
  ],
  invalid: [
    {
      name: "NIXPKGS_ALLOW_UNFREE with --impure",
      files: job("      - run: NIXPKGS_ALLOW_UNFREE=1 nix build --impure .#app"),
      errors: [{ line: 7, messageIncludes: "`nix build --impure` disables pure evaluation" }],
    },
    {
      name: "--impure inside nix develop --command",
      files: job("      - run: nix develop -c nix flake check --impure"),
      errors: [{ line: 7, messageIncludes: "`nix flake check --impure`" }],
    },
    {
      name: "--option pure-eval false on a multi-line run block",
      files: job("      - run: |", "          nix build .#a", "          nix build --option pure-eval false .#b"),
      errors: [{ line: 9, messageIncludes: "`nix build --option pure-eval false`" }],
    },
    {
      name: "--no-pure-eval without devenv",
      files: job("      - run: nix develop --no-pure-eval --command make"),
      errors: [{ line: 7, messageIncludes: "`nix develop --no-pure-eval`" }],
    },
    {
      name: "devenv exemption covers only dev-shell commands",
      files: { ".github/workflows/ci.yml": job("      - run: nix build --impure .#app"), "flake.nix": devenvFlake },
      errors: [{ line: 7, messageIncludes: "`nix build --impure`" }],
    },
    {
      name: "composite action",
      files: {
        ".github/actions/build/action.yml": yml(
          "name: build",
          "runs:",
          "  using: composite",
          "  steps:",
          "    - shell: bash",
          "      run: nix run --impure .#deploy",
        ),
      },
      errors: [{ line: 6, path: ".github/actions/build/action.yml", messageIncludes: "`nix run --impure`" }],
    },
  ],
});

describe("suggestion", () => {
  const suggestion = (...steps: string[]): string | undefined => runRule(rule, { files: job(...steps) })[0]?.suggestion;

  it("moves NIXPKGS_ALLOW_UNFREE into the flake's nixpkgs config", () => {
    const text = suggestion("      - run: NIXPKGS_ALLOW_UNFREE=1 nix build --impure .#app");
    expect(text).toContain("config = {\n    allowUnfree = true;\n  };");
    expect(text).toContain("then run:\nnix build .#app");
  });

  it("detects the variable in step env", () => {
    expect(suggestion("      - run: nix build --impure .#app", "        env:", "          NIXPKGS_ALLOW_INSECURE: 1")).toContain("permittedInsecurePackages");
  });

  it("strips the impure option from the command otherwise", () => {
    expect(suggestion("      - run: nix build --option pure-eval false .#app --print-build-logs")).toContain("\nnix build .#app --print-build-logs\n");
  });
});