import rule from "../../../../src/lint/rules/nix/fake-hash-committed.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

const ZEROS_SRI = `sha256-${"A".repeat(43)}=`;

ruleTester(rule, {
  valid: [
    {
      name: "real hashes and vendorHash = null",
      files: {
        "pkgs/server/default.nix": nix(
          "{ buildGoModule, fetchFromGitHub }:",
          "buildGoModule {",
          '  pname = "server";',
          '  version = "1.0";',
          '  src = fetchFromGitHub { owner = "o"; repo = "r"; rev = "v1.0"; hash = "sha256-pQpattmS9VmO3ZIQUFn66az8GSmB4IvYhTTCFn6SUmo="; };',
          "  vendorHash = null;",
          "}",
        ),
      },
    },
    {
      name: "mentions in comments and strings",
      files: {
        "default.nix": nix(
          "# set hash = lib.fakeHash; first, then copy the real one",
          "{ pkgs }:",
          'pkgs.writeText "howto" "use lib.fakeHash or hash = \\"\\" to discover the hash"',
        ),
      },
    },
    {
      name: "comparisons, lambda defaults and the definitions of the fakes",
      files: {
        "nix/lib.nix": nix(
          "{ lib }:",
          "{",
          "  isFake = h: h == lib.fakeHash || lib.fakeSha256 != h;",
          "  mk = { hash ? lib.fakeHash }: hash;",
          `  fakeHash = "${ZEROS_SRI}";`,
          "}",
        ),
      },
    },
    {
      name: "flake templates are meant to be filled in",
      files: { "templates/rust/flake.nix": nix('{ cargoHash = ""; }') },
    },
    {
      name: "ignorePaths option and non-hash empty strings",
      files: {
        "scratch/default.nix": nix("{ lib }:", "{ hash = lib.fakeHash; }"),
        "default.nix": nix('{ description = ""; name = ""; hashes = ""; }'),
      },
      options: { ignorePaths: ["scratch/"] },
    },
  ],
  invalid: [
    {
      name: "lib.fakeHash in fetchFromGitHub",
      files: {
        "pkgs/app/default.nix": nix(
          "{ lib, fetchFromGitHub }:",
          "fetchFromGitHub {",
          '  owner = "o";',
          '  repo = "r";',
          '  rev = "v1";',
          "  hash = lib.fakeHash;",
          "}",
        ),
      },
      errors: [{ line: 6, messageIncludes: "`hash = lib.fakeHash` matches a well-known placeholder hash. If used as a fixed-output derivation's expected digest, it normally causes a hash mismatch when that derivation is built. Confirm it is not intentional test data and review the fetched content before replacing it." }],
    },
    {
      name: "empty cargoHash and vendorHash",
      files: {
        "default.nix": nix(
          "{ rustPlatform, buildGoModule }:",
          "{",
          '  a = rustPlatform.buildRustPackage { pname = "a"; version = "1"; src = ./a; cargoHash = ""; };',
          '  b = buildGoModule { pname = "b"; version = "1"; src = ./b; vendorHash = ""; };',
          "}",
        ),
      },
      errors: [
        { line: 3, messageIncludes: '`cargoHash = ""`' },
        { line: 4, messageIncludes: '`vendorHash = ""`' },
      ],
    },
    {
      name: "all-zero SRI placeholder, zero sha256 and outputHashes",
      files: {
        "nix/deps.nix": nix(
          "{ rustPlatform, fetchurl }:",
          "{",
          `  src = fetchurl { url = "https://example.org/a"; hash = "${ZEROS_SRI}"; };`,
          `  old = fetchurl { url = "https://example.org/b"; sha256 = "${"0".repeat(52)}"; };`,
          "  lock = rustPlatform.importCargoLock {",
          "    lockFile = ./Cargo.lock;",
          '    outputHashes."dep-0.1.0" = "";',
          "  };",
          "}",
        ),
      },
      errors: [
        { line: 3, messageIncludes: "`hash = \"sha256-AAAA" },
        { line: 4, messageIncludes: "`sha256 = \"0000" },
        { line: 7, messageIncludes: '`outputHashes."dep-0.1.0" = ""`' },
      ],
    },
    {
      name: "outputHashes attrset with an empty entry",
      files: {
        "pkgs/tool/default.nix": nix(
          "{ rustPlatform }:",
          "rustPlatform.importCargoLock {",
          "  lockFile = ./Cargo.lock;",
          "  outputHashes = {",
          '    "git-dep-0.2.0" = "sha256-pQpattmS9VmO3ZIQUFn66az8GSmB4IvYhTTCFn6SUmo=";',
          '    "other-0.3.0" = "";',
          "  };",
          "}",
        ),
      },
      errors: [{ line: 6, messageIncludes: '`outputHashes."other-0.3.0" = ""`' }],
    },
  ],
});
