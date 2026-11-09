import rule from "../../../../src/lint/rules/nix/fetchtarball-no-hash.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

ruleTester(rule, {
  valid: [
    {
      name: "pinned commit with sha256",
      files: {
        "nix/sources.nix": nix(
          "builtins.fetchTarball {",
          '  url = "https://github.com/NixOS/nixpkgs/archive/0123456789abcdef0123456789abcdef01234567.tar.gz";',
          '  sha256 = "1r0v2xg4a8dmc4kv1fzfhv0x5srpxl4a5s10fc0k3csk9y5mz4p6";',
          "}",
        ),
      },
    },
    {
      name: "mentions in comments and strings",
      files: {
        "default.nix": nix(
          '# fetchTarball "https://example.org/x.tar.gz" is not reproducible',
          "{ pkgs }:",
          'pkgs.writeText "doc" "use builtins.fetchTarball with sha256"',
        ),
      },
    },
    {
      name: "attribute named fetchTarball and a shadowing parameter",
      files: {
        "default.nix": nix(
          "{ fetchTarball }:",
          "{",
          '  src = fetchTarball "https://example.org/a.tar.gz";',
          "  helpers.fetchTarball = null;",
          "}",
        ),
      },
    },
    {
      name: "pkgs.fetchzip and a computed argument are not builtins.fetchTarball",
      files: {
        "default.nix": nix(
          "{ pkgs, sources }:",
          "{",
          '  a = pkgs.fetchzip { url = "https://example.org/a.zip"; hash = "sha256-AQ=="; };',
          "  b = builtins.fetchTarball sources.nixpkgs;",
          "}",
        ),
      },
    },
  ],
  invalid: [
    {
      name: "moving channel URL as a plain string",
      files: { "default.nix": nix("let", '  nixpkgs = fetchTarball "https://nixos.org/channels/nixos-24.11/nixexprs.tar.xz";', "in import nixpkgs { }") },
      errors: [{ line: 2, messageIncludes: "fetches a moving URL (`https://nixos.org/channels/nixos-24.11/nixexprs.tar.xz`)" }],
    },
    {
      name: "commit URL in an attrset without sha256",
      files: {
        "shell.nix": nix(
          "let",
          "  pkgs = import (builtins.fetchTarball {",
          '    url = "https://github.com/NixOS/nixpkgs/archive/0123456789abcdef0123456789abcdef01234567.tar.gz";',
          "  }) { };",
          "in pkgs.mkShell { }",
        ),
      },
      errors: [{ line: 2, messageIncludes: "pins commit 0123456789ab but has no `sha256`" }],
    },
    {
      name: "branch archive with interpolation and a parenthesised concatenation",
      files: {
        "nix/pins.nix": nix(
          "{ branch }:",
          "{",
          '  a = builtins.fetchTarball "https://github.com/nix-community/home-manager/archive/${branch}.tar.gz";',
          '  b = builtins.fetchTarball ("https://github.com/owner/repo/archive/" + branch + ".tar.gz");',
          "}",
        ),
      },
      errors: [
        { line: 3, messageIncludes: "has no `sha256`" },
        { line: 4, messageIncludes: "has no `sha256`" },
      ],
    },
  ],
});
