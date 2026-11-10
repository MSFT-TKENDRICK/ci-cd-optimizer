import rule from "../../../../src/lint/rules/nix/current-system-builtin.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

ruleTester(rule, {
  valid: [
    {
      name: "systems enumerated explicitly",
      files: {
        "flake.nix": nix(
          "{",
          "  outputs = { nixpkgs, ... }: {",
          '    packages = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: {',
          "      default = nixpkgs.legacyPackages.${system}.hello;",
          "    });",
          "  };",
          "}",
        ),
      },
    },
    {
      name: "mentions in comments and strings",
      files: {
        "default.nix": nix(
          "# do not use builtins.currentSystem here",
          "{ pkgs }:",
          'pkgs.writeText "note" "builtins.currentSystem is impure"',
        ),
      },
    },
    {
      name: "attribute named currentSystem is not the builtin",
      files: { "default.nix": nix("{ system }:", "{ currentSystem = system; info.currentSystem = system; }") },
    },
    {
      name: "hostPlatform from stdenv",
      files: { "pkgs/app/default.nix": nix("{ stdenv }:", "stdenv.mkDerivation { name = \"app-${stdenv.hostPlatform.system}\"; }") },
    },
    {
      name: "inherit from something other than builtins",
      files: { "default.nix": nix("{ args }:", "{ inherit (args) currentSystem; }") },
    },
  ],
  invalid: [
    {
      name: "import nixpkgs for the evaluating machine",
      files: { "default.nix": nix("let", "  pkgs = import ./nixpkgs.nix { system = builtins.currentSystem; };", "in pkgs.hello") },
      errors: [{ line: 2, messageIncludes: "`builtins.currentSystem` makes this expression depend on the platform" }],
    },
    {
      name: "argument default",
      files: { "shell.nix": nix("{ system ? builtins.currentSystem }:", "import ./default.nix { inherit system; }") },
      errors: [{ line: 1, messageIncludes: "used as an argument default" }],
    },
    {
      name: "inherit (builtins) currentSystem and __currentSystem",
      files: {
        "nix/lib.nix": nix("let", "  inherit (builtins) currentSystem;", "  other = __currentSystem;", "in { inherit currentSystem other; }"),
      },
      errors: [
        { line: 2, messageIncludes: "`inherit (builtins) currentSystem`" },
        { line: 3, messageIncludes: "`__currentSystem`" },
      ],
    },
  ],
});
