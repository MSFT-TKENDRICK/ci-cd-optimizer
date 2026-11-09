import rule from "../../../../src/lint/rules/nix/overlay-overrides-foundational-package.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

ruleTester(rule, {
  valid: [
    {
      name: "overlay scopes the override to one package and re-exports an identity binding",
      files: {
        "flake.nix": nix(
          "{",
          "  outputs = { self, nixpkgs }: {",
          "    overlays.default = final: prev: {",
          "      openssl = prev.openssl;",
          "      myApp = prev.myApp.override { openssl = final.openssl_3; stdenv = final.clangStdenv; };",
          "      ripgrep = prev.ripgrep.overrideAttrs (old: { doCheck = false; });",
          "    };",
          "  };",
          "}",
        ),
      },
    },
    {
      name: "Haskell overrides and Python packageOverrides change a sub-package set, not the top-level attribute",
      files: {
        "overlays/default.nix": nix(
          "final: prev: {",
          "  haskellPackages = prev.haskellPackages.override {",
          "    overrides = self: super: { zlib = super.zlib_0_7; };",
          "  };",
          "  python3 = prev.python3.override {",
          "    packageOverrides = pyFinal: pyPrev: { requests = pyPrev.requests; };",
          "  };",
          "}",
        ),
      },
    },
    {
      name: "overlay-shaped text in comments and strings, and a top-level lambda in a non-overlay file",
      files: {
        "default.nix": nix(
          "# overlays = [ (final: prev: { openssl = prev.libressl; }) ];",
          "{ pkgs }:",
          "{",
          '  description = "final: prev: { stdenv = prev.clangStdenv; }";',
          "  openssl = pkgs.libressl;",
          "}",
        ),
        "nix/fixpoint.nix": nix("self: super: {", "  zlib = super.zlib-ng;", "}"),
      },
    },
    {
      name: "allow option accepts a deliberate global override",
      options: { allow: ["openssl"] },
      files: {
        "overlay.nix": nix("final: prev: {", "  openssl = prev.openssl.override { static = true; };", "}"),
      },
    },
  ],
  invalid: [
    {
      name: "flake overlay output rebinds openssl",
      files: {
        "flake.nix": nix(
          "{",
          "  outputs = { self, nixpkgs }: {",
          "    overlays.default = final: prev: {",
          "      openssl = prev.openssl.overrideAttrs (old: {",
          '        configureFlags = old.configureFlags ++ [ "no-weak-ssl-ciphers" ];',
          "      });",
          "    };",
          "  };",
          "}",
        ),
      },
      errors: [{ line: 4, messageIncludes: "Overlay rebinds `openssl = prev.openssl.overrideAttrs" }],
    },
    {
      name: "self: super: overlay file rebinds bootstrap packages, including through let and inherit",
      files: {
        "nix/overlay.nix": nix(
          "self: super:",
          "let",
          "  patched = super.zlib.overrideAttrs (old: { patches = [ ./zlib.patch ]; });",
          "in {",
          "  zlib = patched;",
          "  inherit (super.llvmPackages_17) stdenv;",
          "}",
        ),
      },
      errors: [
        { line: 5, messageIncludes: "stdenv bootstrap stages" },
        { line: 6, messageIncludes: "`inherit (super.llvmPackages_17) stdenv`" },
      ],
    },
    {
      name: "NixOS nixpkgs.overlays, pkgs.extend and composeManyExtensions",
      files: {
        "configuration.nix": nix(
          "{ pkgs, lib, ... }:",
          "{",
          "  nixpkgs.overlays = [",
          "    (final: prev: { stdenv = prev.clangStdenv; })",
          "  ];",
          "  environment.systemPackages = [ (pkgs.extend (self: super: { curl = super.curlMinimal; })).hello ];",
          "  composed = lib.composeManyExtensions [ (final: prev: { python3 = prev.python312; }) ];",
          "}",
        ),
      },
      errors: [
        { line: 4, messageIncludes: "`stdenv` builds almost every package" },
        { line: 6, messageIncludes: "`curl = super.curlMinimal`" },
        { line: 7, messageIncludes: "`python3 = prev.python312`" },
      ],
    },
  ],
});
