import rule from "../../../../src/lint/rules/nix/builtins-fetchurl-unverified.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

ruleTester(rule, {
  valid: [
    {
      name: "nixpkgs fetchurl with a hash is a fixed-output derivation",
      files: {
        "pkgs/tool/default.nix": nix(
          "{ fetchurl, stdenv }:",
          "stdenv.mkDerivation {",
          '  name = "tool";',
          '  src = fetchurl { url = "https://example.org/tool-1.0.tar.gz"; hash = "sha256-AQ=="; };',
          "}",
        ),
      },
    },
    {
      name: "builtins.fetchurl with sha256",
      files: {
        "default.nix": nix(
          'import (builtins.fetchurl { url = "https://example.org/v1/default.nix"; sha256 = "1r0v2xg4a8dmc4kv1fzfhv0x5srpxl4a5s10fc0k3csk9y5mz4p6"; })',
        ),
      },
    },
    {
      name: "mentions in comments, strings and attribute names",
      files: {
        "default.nix": nix(
          '# builtins.fetchurl "https://example.org/x"',
          "{ pkgs }:",
          "{",
          '  doc = "builtins.fetchurl \\"https://example.org/y\\"";',
          "  fetchurl = pkgs.fetchurl;",
          "}",
        ),
      },
    },
    {
      name: "pkgs.fetchurl called with a plain string is not the builtin",
      files: { "default.nix": nix("{ pkgs }:", 'pkgs.fetchurl "https://example.org/a"') },
    },
  ],
  invalid: [
    {
      name: "plain string URL",
      files: { "default.nix": nix("let", '  data = builtins.fetchurl "https://example.org/data.json";', "in builtins.readFile data") },
      errors: [{ line: 2, messageIncludes: '`builtins.fetchurl "https://example.org/data.json"` downloads at evaluation time with no `sha256`' }],
    },
    {
      name: "imported remote Nix code",
      files: { "nix/overlay.nix": nix("{ pkgs }:", 'import (builtins.fetchurl { url = "https://example.org/overlay.nix"; }) { inherit pkgs; }') },
      errors: [{ line: 2, messageIncludes: "`import` of `builtins.fetchurl" }],
    },
    {
      name: "inherit (builtins) fetchurl",
      files: {
        "default.nix": nix("let", "  inherit (builtins) fetchurl;", '  a = fetchurl "https://example.org/a";', "in a"),
      },
      errors: [{ line: 3, messageIncludes: '`fetchurl "https://example.org/a"`' }],
    },
  ],
});
