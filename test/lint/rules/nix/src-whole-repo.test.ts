import rule from "../../../../src/lint/rules/nix/src-whole-repo.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

ruleTester(rule, {
  valid: [
    {
      name: "filtered sources: fileset, cleanSourceWith and a fetcher",
      files: {
        "default.nix": nix(
          "{ lib, stdenv, rustPlatform, fetchFromGitHub }:",
          "{",
          "  app = rustPlatform.buildRustPackage {",
          '    pname = "app";',
          "    src = lib.fileset.toSource { root = ./.; fileset = lib.fileset.unions [ ./Cargo.toml ./Cargo.lock ./src ]; };",
          "  };",
          "  lib' = stdenv.mkDerivation {",
          '    pname = "lib";',
          "    src = lib.cleanSourceWith { src = ./.; filter = path: type: type != \"symlink\"; };",
          "  };",
          "  upstream = stdenv.mkDerivation {",
          '    pname = "upstream";',
          '    src = fetchFromGitHub { owner = "o"; repo = "r"; rev = "v1"; hash = "sha256-pQpattmS9VmO3ZIQUFn66az8GSmB4IvYhTTCFn6SUmo="; };',
          "  };",
          "}",
        ),
      },
    },
    {
      name: "subdirectory package without its own flake points `./.` at its own directory only",
      files: {
        "flake.nix": nix("{ outputs = { self }: { }; }"),
        "pkgs/foo/default.nix": nix("{ stdenv }:", "stdenv.mkDerivation {", '  pname = "foo";', "  src = ./.;", "}"),
      },
    },
    {
      name: "comments, strings, non-builder attrsets and `inherit src` from a function argument",
      files: {
        "default.nix": nix(
          "{ pkgs, stdenv, src }:",
          "{",
          "  # stdenv.mkDerivation { src = ./.; }",
          '  description = "stdenv.mkDerivation { src = ./.; }";',
          "  shell = pkgs.mkShell { src = ./.; };",
          "  pkg = stdenv.mkDerivation { pname = \"pkg\"; inherit src; };",
          "}",
        ),
      },
    },
    {
      name: "`inherit src` outside the `let` that binds `src = ./.`",
      files: {
        "default.nix": nix(
          "{ lib, stdenv, src }:",
          "{",
          "  a = let src = ./.; in stdenv.mkDerivation { pname = \"a\"; src = lib.cleanSource src; };",
          "  b = stdenv.mkDerivation { pname = \"b\"; inherit src; };",
          "}",
        ),
      },
    },
    {
      name: "a narrower inner let binding shadows an outer repository literal",
      files: { "default.nix": "{ pkgs }: let src = ./.; in { p = let src = ./src; in pkgs.stdenv.mkDerivation { inherit src; }; }" },
    },
    {
      name: "a quoted inner binding shadows an outer repository literal",
      files: { "default.nix": '{ pkgs }: let src = ./.; in { p = let "src" = ./src; in pkgs.stdenv.mkDerivation { inherit src; }; }' },
    },
    {
      name: "a lambda parameter makes inherited source resolution ambiguous",
      files: { "default.nix": "{ pkgs }: let src = ./.; in { p = src: pkgs.stdenv.mkDerivation { inherit src; }; }" },
    },
    {
      name: "an inherited inner let binding shadows an outer repository literal",
      files: { "default.nix": "{ pkgs, other }: let src = ./.; in { p = let inherit (other) src; in pkgs.stdenv.mkDerivation { inherit src; }; }" },
    },
    {
      name: "a narrower recursive attribute shadows an outer repository literal",
      files: { "default.nix": "{ pkgs }: let src = ./.; in rec { src = ./src; p = pkgs.stdenv.mkDerivation { inherit src; }; }" },
    },
    {
      name: "allow option skips a file",
      options: { allow: ["default.nix"] },
      files: {
        "default.nix": nix("{ stdenv }:", "stdenv.mkDerivation {", '  pname = "app";', "  src = ./.;", "}"),
      },
    },
  ],
  invalid: [
    {
      name: "source scopes expire between siblings and retain repeated identical active literals",
      files: {
        "default.nix": "{ pkgs }: {\n" + Array.from({ length: 60 }, (_, index) => nix(
          `p${index} = let src = ${index % 2 === 0 ? "./." : "./src"}; in {`,
          "  a = pkgs.stdenv.mkDerivation { inherit src; };",
          "  b = let src = ./.; in pkgs.stdenv.mkDerivation { inherit src; };",
          "  c = pkgs.stdenv.mkDerivation { inherit src; };",
          "};",
        )).join("") + "}",
      },
      errors: 90,
      output: null,
    },
    {
      name: "a single quoted let binding remains recognizable",
      files: { "default.nix": '{ pkgs }: let "src" = ./.; in pkgs.stdenv.mkDerivation { inherit src; }' },
      errors: 1,
      output: null,
    },
    {
      name: "a recursive source binding is shared by sibling builders",
      files: {
        "default.nix": nix(
          "{ pkgs }: rec {",
          "  src = ./.;",
          '  a = pkgs.stdenv.mkDerivation { name = "a"; inherit src; };',
          '  b = pkgs.stdenv.mkDerivation { name = "b"; inherit src; };',
          "}",
        ),
      },
      errors: 2,
      output: null,
    },
    {
      name: "root derivation with `src = ./.`",
      files: {
        "default.nix": nix("{ stdenv }:", "stdenv.mkDerivation (finalAttrs: {", '  pname = "app";', '  version = "1.0";', "  src = ./.;", "})"),
      },
      errors: [{ line: 5, messageIncludes: "`src = ./.` in `mkDerivation` selects the repository root as source. Changes to included but unused files (possibly docs, CI workflows or flake.lock) can change the source hash and reduce cache reuse. Actual filtering and required inputs need review." }],
    },
    {
      name: "nested package reaching the repository root and a sub-flake root",
      files: {
        "pkgs/app/default.nix": nix("{ buildGoModule }:", "buildGoModule {", '  pname = "app";', "  src = ../..;", "  vendorHash = null;", "}"),
        "tools/cli/flake.nix": nix("{ outputs = { self, nixpkgs }: { }; }"),
        "tools/cli/default.nix": nix("{ rustPlatform }:", "rustPlatform.buildRustPackage {", '  pname = "cli";', "  src = ./.;", "}"),
      },
      errors: [
        { path: "pkgs/app/default.nix", line: 4, messageIncludes: "`src = ../..` in `buildGoModule` selects the repository root as source. Changes to included but unused files (possibly docs, CI workflows or flake.lock) can change the source hash and reduce cache reuse. Actual filtering and required inputs need review." },
        { path: "tools/cli/default.nix", line: 4, messageIncludes: "`tools/cli/`, the flake root" },
      ],
    },
    {
      name: "flake `src = self` and `inherit src` bound to `./.`",
      files: {
        "flake.nix": nix(
          "{",
          "  outputs = { self, nixpkgs }:",
          "    let",
          "      pkgs = nixpkgs.legacyPackages.x86_64-linux;",
          "      src = ./.;",
          "    in {",
          "      packages.x86_64-linux.default = pkgs.buildNpmPackage {",
          '        pname = "web";',
          "        src = self;",
          "      };",
          "      packages.x86_64-linux.docs = pkgs.stdenv.mkDerivation {",
          '        pname = "docs";',
          "        inherit src;",
          "      };",
          "    };",
          "}",
        ),
      },
      errors: [
        { line: 9, messageIncludes: "`src = self` in `buildNpmPackage`" },
        { line: 13, messageIncludes: "`inherit src (src = ./.)` in `mkDerivation`" },
      ],
    },
  ],
});
