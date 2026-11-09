import rule from "../../../../src/lint/rules/nix/rust-two-phase-build.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

const HASH = "sha256-pQpattmS9VmO3ZIQUFn66az8GSmB4IvYhTTCFn6SUmo=";

ruleTester(rule, {
  valid: [
    {
      name: "crane with buildDepsOnly and cargoArtifacts",
      files: {
        "flake.nix": nix(
          "{",
          "  outputs = { self, nixpkgs, crane }:",
          "    let",
          "      pkgs = nixpkgs.legacyPackages.x86_64-linux;",
          "      craneLib = crane.mkLib pkgs;",
          "      commonArgs = { src = craneLib.cleanCargoSource ./.; strictDeps = true; };",
          "      cargoArtifacts = craneLib.buildDepsOnly commonArgs;",
          "    in {",
          "      packages.x86_64-linux.default = craneLib.buildPackage (commonArgs // { inherit cargoArtifacts; });",
          "    };",
          "}",
        ),
      },
    },
    {
      name: "naersk builds are left alone",
      files: {
        "default.nix": nix("{ pkgs, naersk }:", "let", "  naersk-lib = pkgs.callPackage naersk { };", "in", "naersk-lib.buildPackage { src = ./.; }"),
      },
    },
    {
      name: "comments, strings, fetched sources and an uncalled reference",
      files: {
        "default.nix": nix(
          "{ rustPlatform, fetchFromGitHub }:",
          "{",
          "  # rustPlatform.buildRustPackage { src = ./.; }",
          '  description = "rustPlatform.buildRustPackage { src = ./.; }";',
          "  builder = rustPlatform.buildRustPackage;",
          "  ripgrep = rustPlatform.buildRustPackage {",
          '    pname = "ripgrep";',
          `    src = fetchFromGitHub { owner = "BurntSushi"; repo = "ripgrep"; rev = "14.1.0"; hash = "${HASH}"; };`,
          `    cargoHash = "${HASH}";`,
          "  };",
          "}",
        ),
      },
    },
    {
      name: "allow option skips a file",
      options: { allow: ["default.nix"] },
      files: {
        "default.nix": nix("{ rustPlatform }:", 'rustPlatform.buildRustPackage { pname = "app"; src = ./.; cargoLock.lockFile = ./Cargo.lock; }'),
      },
    },
  ],
  invalid: [
    {
      name: "buildRustPackage over the repository root",
      files: {
        "default.nix": nix(
          "{ rustPlatform }:",
          "rustPlatform.buildRustPackage {",
          '  pname = "app";',
          '  version = "0.1.0";',
          "  src = ./.;",
          "  cargoLock.lockFile = ./Cargo.lock;",
          "}",
        ),
      },
      errors: [{ line: 2, messageIncludes: "`rustPlatform.buildRustPackage` (`app`) compiles all dependency crates and the workspace in one derivation from local source `./.`" }],
    },
    {
      name: "finalAttrs form with a filtered local source",
      files: {
        "pkgs/cli/package.nix": nix(
          "{ lib, rustPlatform }:",
          "rustPlatform.buildRustPackage (finalAttrs: {",
          '  pname = "cli";',
          '  version = "1.2.0";',
          "  src = lib.cleanSource ./.;",
          `  cargoHash = "${HASH}";`,
          "})",
        ),
      },
      errors: [{ line: 2, messageIncludes: "from local source `lib.cleanSource ./.`" }],
    },
    {
      name: "`inherit src;` resolved to `self` in a flake",
      files: {
        "flake.nix": nix(
          "{",
          "  outputs = { self, nixpkgs }:",
          "    let",
          "      pkgs = nixpkgs.legacyPackages.x86_64-linux;",
          "      src = self;",
          "    in {",
          "      packages.x86_64-linux.default = pkgs.rustPlatform.buildRustPackage {",
          '        pname = "tool";',
          '        version = "0.1.0";',
          "        inherit src;",
          "        cargoLock.lockFile = ./Cargo.lock;",
          "      };",
          "    };",
          "}",
        ),
      },
      errors: [{ line: 7, messageIncludes: "`pkgs.rustPlatform.buildRustPackage` (`tool`) compiles all dependency crates and the workspace in one derivation from local source `self`" }],
    },
  ],
});
