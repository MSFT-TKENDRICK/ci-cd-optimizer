import rule from "../../../../src/lint/rules/nix/import-from-derivation.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

const HASH = "sha256-pQpattmS9VmO3ZIQUFn66az8GSmB4IvYhTTCFn6SUmo=";

ruleTester(rule, {
  valid: [
    {
      name: "imports and reads of committed paths, nixpkgs itself and flake inputs",
      files: {
        "default.nix": nix(
          "{ pkgs ? import <nixpkgs> { }, nixpkgs }:",
          "let",
          '  nixos = import "${pkgs.path}/nixos";',
          '  lib = import "${nixpkgs}/lib";',
          "  version = builtins.readFile ./VERSION;",
          "  data = pkgs.lib.importJSON ./data.json;",
          '  pinned = import (builtins.fetchTarball { url = "https://example.com/n.tar.gz"; sha256 = "0000000000000000000000000000000000000000000000000000"; }) { };',
          "in",
          "pkgs.callPackage ./package.nix { inherit version; }",
        ),
      },
    },
    {
      name: "comments, strings, attribute names and an uncalled inherit",
      files: {
        "default.nix": nix(
          "{ haskellPackages, pkgs }:",
          "let",
          "  inherit (haskellPackages) callCabal2nix;",
          "in",
          "{",
          '  # app = import (pkgs.runCommand "x.nix" { } "");',
          '  description = "haskellPackages.callCabal2nix \\"app\\" ./. { } and autoPubspecLock = ./x;";',
          "  callCabal2nix = null;",
          "  meta.autoPubspecLock = false;",
          "}",
        ),
      },
    },
    {
      name: "yarn2nix with a fixed-output offline cache or a committed yarn.nix",
      files: {
        "default.nix": nix(
          "{ mkYarnPackage, fetchYarnDeps }:",
          "{",
          "  web = mkYarnPackage {",
          "    src = ./web;",
          `    offlineCache = fetchYarnDeps { yarnLock = ./web/yarn.lock; hash = "${HASH}"; };`,
          "  };",
          "  docs = mkYarnPackage { src = ./docs; yarnNix = ./docs/yarn.nix; };",
          "}",
        ),
      },
    },
    {
      name: "allow option by helper name and by file path",
      options: { allow: ["callCabal2nix", "nix/dev.nix"] },
      files: {
        "default.nix": nix("{ haskellPackages }:", 'haskellPackages.callCabal2nix "app" ./. { }'),
        "nix/dev.nix": nix("{ pkgs }:", 'import (pkgs.runCommand "x.nix" { } "echo {} > $out")'),
      },
    },
  ],
  invalid: [
    {
      name: "importing runCommand output directly and through a let binding",
      files: {
        "default.nix": nix(
          "{ pkgs }:",
          "let",
          '  generated = pkgs.runCommand "deps.nix" { } \'\'',
          "    echo '{ }' > $out",
          "  '';",
          "in",
          "{",
          "  deps = import generated;",
          '  direct = import (pkgs.runCommand "x.nix" { } "echo {} > $out");',
          '  version = builtins.readFile "${pkgs.writeText "v" "1.0"}";',
          "}",
        ),
      },
      errors: [
        { line: 8, messageIncludes: "`generated` (built by `pkgs.runCommand` on line 3)" },
        { line: 9, messageIncludes: "`pkgs.runCommand` is a derivation, so evaluation pauses until it is built" },
        { line: 10, messageIncludes: "`builtins.readFile" },
      ],
    },
    {
      name: "Haskell cabal2nix helpers and reading a fetched source",
      files: {
        "default.nix": nix(
          "{ pkgs, haskellPackages, fetchFromGitHub }:",
          "let",
          `  src = fetchFromGitHub { owner = "o"; repo = "r"; rev = "v1"; hash = "${HASH}"; };`,
          "in",
          "{",
          '  app = haskellPackages.callCabal2nix "app" ./. { };',
          '  version = builtins.readFile "${src}/VERSION";',
          '  aeson = pkgs.haskell.packages.ghc96.callHackage "aeson" "2.2.0.0" { };',
          "}",
        ),
      },
      errors: [
        { line: 6, messageIncludes: "`haskellPackages.callCabal2nix` is import from derivation" },
        { line: 7, messageIncludes: "`src` (built by `fetchFromGitHub` on line 3) is a derivation, so evaluation pauses until it is fetched" },
        { line: 8, messageIncludes: "`pkgs.haskell.packages.ghc96.callHackage` is import from derivation (IFD): it runs `cabal2nix` in a derivation over the Hackage package index" },
      ],
    },
    {
      name: "yarn2nix, Dart and crate2nix generators evaluated at eval time",
      files: {
        "default.nix": nix(
          "{ pkgs, tools }:",
          "{",
          '  web = pkgs.mkYarnPackage { pname = "web"; src = ./web; };',
          "  app = pkgs.buildDartApplication {",
          '    pname = "app";',
          "    src = ./app;",
          "    autoPubspecLock = ./app/pubspec.lock;",
          "  };",
          '  cli = (tools.appliedCargoNix { name = "cli"; src = ./cli; }).rootCrate.build;',
          '  gen = pkgs.callPackage (tools.generatedCargoNix { name = "gen"; src = ./gen; }) { };',
          "}",
        ),
      },
      errors: [
        { line: 3, messageIncludes: "`pkgs.mkYarnPackage` without `offlineCache` or `yarnNix`" },
        { line: 7, messageIncludes: "`autoPubspecLock` is import from derivation" },
        { line: 9, messageIncludes: "`tools.appliedCargoNix` is import from derivation" },
        { line: 10, messageIncludes: "`tools.generatedCargoNix` is a derivation" },
      ],
    },
  ],
});
