import rule from "../../../../src/lint/rules/nix/missing-flake-lock.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

const LOCK = `${JSON.stringify(
  {
    nodes: {
      nixpkgs: {
        locked: {
          lastModified: 1730785428,
          narHash: "sha256-Zwl8YgTVJTEum+L+0zVAWvXAGbWAuXHax3KzuejaDyo=",
          owner: "NixOS",
          repo: "nixpkgs",
          rev: "4aa36568d413aca0ea84a1684d2d46f55dbabad7",
          type: "github",
        },
        original: { owner: "NixOS", ref: "nixos-24.11", repo: "nixpkgs", type: "github" },
      },
      root: { inputs: { nixpkgs: "nixpkgs" } },
    },
    root: "root",
    version: 7,
  },
  null,
  2,
)}\n`;

const FLAKE = nix(
  "{",
  '  description = "service";',
  '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";',
  "  outputs = { self, nixpkgs }: {",
  "    packages.x86_64-linux.default = nixpkgs.legacyPackages.x86_64-linux.hello;",
  "  };",
  "}",
);

ruleTester(rule, {
  valid: [
    { name: "flake.nix with a committed flake.lock", files: { "flake.nix": FLAKE, "flake.lock": LOCK } },
    {
      name: "a flake.lock that fails to parse still counts as committed",
      files: { "flake.nix": FLAKE, "flake.lock": "{ not json" },
    },
    {
      name: "flake without inputs has nothing to lock",
      files: { "flake.nix": nix("{", "  outputs = { self }: { lib.answer = 42; };", "}") },
    },
    {
      name: "trap: templates and example flakes are shipped unlocked on purpose",
      files: {
        "flake.nix": FLAKE,
        "flake.lock": LOCK,
        "templates/rust/flake.nix": FLAKE,
        "examples/minimal/flake.nix": FLAKE,
      },
    },
    {
      name: "trap: subflake consumed through a relative path input is locked by its parent",
      files: {
        "flake.nix": nix(
          "{",
          '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";',
          '  inputs.dev.url = "path:./nix/dev";',
          "  outputs = { self, nixpkgs, dev }: { };",
          "}",
        ),
        "flake.lock": LOCK,
        "nix/dev/flake.nix": FLAKE,
      },
    },
    {
      name: "trap: PR-only analysis cannot see the whole inventory",
      files: { "flake.nix": FLAKE },
      mode: "pull_request",
      inventoryComplete: false,
    },
  ],
  invalid: [
    {
      name: "root flake without flake.lock",
      files: { "flake.nix": FLAKE },
      errors: [{ path: "flake.nix", line: 1, messageIncludes: "`flake.lock` is not committed" }],
    },
    {
      name: "subdirectory flake is checked against its own directory",
      files: { "flake.nix": FLAKE, "flake.lock": LOCK, "infra/flake.nix": FLAKE },
      errors: [{ path: "infra/flake.nix", line: 1, messageIncludes: "`infra/flake.lock`" }],
    },
    {
      name: "inputs that only appear as outputs arguments are still resolved through the registry",
      files: { "flake.nix": nix("{", "  outputs = { self, nixpkgs, flake-utils }: { };", "}") },
      errors: [{ line: 1, messageIncludes: "`nixpkgs`, `flake-utils`" }],
    },
    {
      name: "a lock in a different directory does not count",
      files: { "flake.nix": FLAKE, "nix/flake.lock": LOCK },
      errors: [{ path: "flake.nix", messageIncludes: "input `nixpkgs`" }],
    },
  ],
});
