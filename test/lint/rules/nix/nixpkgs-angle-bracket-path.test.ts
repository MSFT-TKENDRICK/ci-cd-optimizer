import rule from "../../../../src/lint/rules/nix/nixpkgs-angle-bracket-path.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

ruleTester(rule, {
  valid: [
    {
      name: "pinned flake input",
      files: {
        "flake.nix": nix(
          "{",
          '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";',
          "  outputs = { nixpkgs, ... }: { packages.x86_64-linux.default = nixpkgs.legacyPackages.x86_64-linux.hello; };",
          "}",
        ),
      },
    },
    {
      name: "lookup paths in comments and strings are not code",
      files: {
        "default.nix": nix(
          "# Old usage: import <nixpkgs> { }",
          "/* also <nixpkgs/nixos> */",
          "{ pkgs }:",
          'pkgs.writeText "readme" "run nix-build -I nixpkgs=<nixpkgs> to build"',
        ),
      },
    },
    {
      name: "comparison operators are not lookup paths",
      files: { "default.nix": nix("{ a, b }:", "if a<b && b>a then 1 else 0") },
    },
    {
      name: "Nix's built-in corepkgs (<nix/fetchurl.nix>) are not NIX_PATH entries",
      files: { "default.nix": nix('import <nix/fetchurl.nix> { url = "https://example.org/x"; sha256 = "0000000000000000000000000000000000000000000000000000"; }') },
    },
    {
      name: "ignored lookup names",
      files: { "shell.nix": nix("{ pkgs ? import <nixpkgs> { } }:", "pkgs.mkShell { }") },
      options: { ignore: ["nixpkgs"] },
    },
    {
      name: "vendored nixpkgs tree is skipped",
      files: {
        "third_party/nixpkgs/pkgs/top-level/all-packages.nix": nix("{ }"),
        "third_party/nixpkgs/nixos/default.nix": nix("import <nixpkgs/nixos/lib/eval-config.nix>"),
      },
    },
  ],
  invalid: [
    {
      name: "import <nixpkgs> at top level",
      files: { "default.nix": nix("let", "  pkgs = import <nixpkgs> { };", "in", "pkgs.hello") },
      errors: [{ line: 2, messageIncludes: "`<nixpkgs>` is resolved from NIX_PATH" }],
    },
    {
      name: "argument default in shell.nix",
      files: { "shell.nix": nix("{ pkgs ? import <nixpkgs> { } }:", "pkgs.mkShell { packages = [ pkgs.jq ]; }") },
      errors: [{ line: 1, path: "shell.nix", messageIncludes: "whenever the caller does not pass this argument" }],
    },
    {
      name: "sub-paths and other channels",
      files: {
        "nix/system.nix": nix(
          "let",
          "  eval = import <nixpkgs/nixos> { configuration = ./configuration.nix; };",
          "  unstable = import <unstable> { };",
          "in eval.system",
        ),
      },
      errors: [
        { line: 2, messageIncludes: "`<nixpkgs/nixos>`" },
        { line: 3, messageIncludes: "`unstable` revision" },
      ],
    },
    {
      name: "interpolated code inside a string is still code",
      files: { "default.nix": nix('"${<nixpkgs>}/lib"') },
      errors: [{ line: 1, messageIncludes: "`<nixpkgs>`" }],
    },
  ],
});
