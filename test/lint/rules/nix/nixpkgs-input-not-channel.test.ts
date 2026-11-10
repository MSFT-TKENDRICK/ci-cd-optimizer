import rule from "../../../../src/lint/rules/nix/nixpkgs-input-not-channel.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

const flake = (...inputs: string[]): string => nix("{", ...inputs.map((line) => `  ${line}`), "  outputs = { self, ... }: { };", "}");

const lock = (original: Record<string, string>): string =>
  `${JSON.stringify(
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
          original: { owner: "NixOS", repo: "nixpkgs", type: "github", ...original },
        },
        root: { inputs: { nixpkgs: "nixpkgs" } },
      },
      root: "root",
      version: 7,
    },
    null,
    2,
  )}\n`;

ruleTester(rule, {
  valid: [
    { name: "nixos-unstable channel", files: { "flake.nix": flake('inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";') } },
    {
      name: "stable, darwin and -small channels",
      files: {
        "flake.nix": flake(
          'inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-24.11";',
          'inputs.nixpkgs-darwin.url = "github:NixOS/nixpkgs/nixpkgs-24.11-darwin";',
          'inputs.nixpkgs-small.url = "github:NixOS/nixpkgs?ref=nixos-unstable-small";',
          'inputs.nixpkgs-rolling.url = "github:NixOS/nixpkgs/nixpkgs-unstable";',
        ),
      },
    },
    {
      name: "trap: an explicitly pinned master revision is a deliberate choice",
      files: {
        "flake.nix": flake(
          'inputs.nixpkgs.url = "github:NixOS/nixpkgs/4aa36568d413aca0ea84a1684d2d46f55dbabad7";',
          'inputs.pinned.url = "github:NixOS/nixpkgs?ref=master&rev=4aa36568d413aca0ea84a1684d2d46f55dbabad7";',
        ),
      },
    },
    {
      name: "trap: forks, follows and other repositories named nixpkgs are not checked",
      files: {
        "flake.nix": flake(
          'inputs.nixpkgs.url = "github:my-org/nixpkgs";',
          'inputs.pkgs.follows = "nixpkgs";',
          'inputs.nixpkgs-lib.url = "github:nix-community/nixpkgs.lib";',
        ),
      },
    },
    {
      name: "trap: unknown feature branches are not guessed at",
      files: { "flake.nix": flake('inputs.nixpkgs.url = "github:NixOS/nixpkgs/haskell-updates";') },
    },
    {
      name: "trap: interpolated URL whose lock entry tracks a channel",
      files: {
        "flake.nix": nix('let channel = "nixos-24.11"; in', "{", '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/${channel}";', "  outputs = { self, ... }: { };", "}"),
        "flake.lock": lock({ ref: "nixos-24.11" }),
      },
    },
  ],
  invalid: [
    {
      name: "default branch",
      files: { "flake.nix": flake('inputs.nixpkgs.url = "github:NixOS/nixpkgs";') },
      errors: [{ line: 2, messageIncludes: "tracks nixpkgs the default branch (`master`)" }],
    },
    {
      name: "explicit master, release and staging branches",
      files: {
        "flake.nix": nix(
          "{",
          "  inputs = {",
          '    nixpkgs.url = "github:NixOS/nixpkgs/master";',
          '    stable.url = "github:NixOS/nixpkgs/release-24.11";',
          '    staging.url = "git+https://github.com/NixOS/nixpkgs?ref=refs/heads/staging-next";',
          "  };",
          "  outputs = { self, ... }: { };",
          "}",
        ),
      },
      errors: [
        { line: 3, messageIncludes: "Input `nixpkgs` (`github:NixOS/nixpkgs/master`) tracks nixpkgs `master`" },
        { line: 4, messageIncludes: "tracks nixpkgs `release-24.11`" },
        { line: 5, messageIncludes: "tracks nixpkgs `staging-next`" },
      ],
    },
    {
      name: "attribute-style and tarball references",
      files: {
        "flake.nix": flake(
          'inputs.nixpkgs = { type = "github"; owner = "NixOS"; repo = "nixpkgs"; ref = "master"; };',
          'inputs.legacy.url = "https://github.com/NixOS/nixpkgs/archive/master.tar.gz";',
        ),
      },
      errors: [
        { line: 2, messageIncludes: "Input `nixpkgs` tracks nixpkgs `master`" },
        { line: 3, messageIncludes: "Input `legacy`" },
      ],
    },
    {
      name: "unreadable flake.nix (let ... in) falls back to the lock entry",
      files: {
        "flake.nix": nix('let owner = "NixOS"; in', "{", '  inputs.nixpkgs.url = "github:${owner}/nixpkgs";', "  outputs = { self, ... }: { };", "}"),
        "flake.lock": lock({}),
      },
      errors: [{ path: "flake.lock", line: 3, messageIncludes: "the default branch (`master`)" }],
    },
    {
      name: "interpolated URL falls back to the lock entry",
      files: {
        "flake.nix": flake('inputs.nixpkgs.url = "github:NixOS/nixpkgs/${branch}";'),
        "flake.lock": lock({ ref: "release-24.11" }),
      },
      errors: [{ path: "flake.lock", line: 3, messageIncludes: "Input `nixpkgs` tracks nixpkgs `release-24.11`" }],
    },
  ],
});
