import rule from "../../../../src/lint/rules/nix/flake-lock-missing-input.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

type LockNode = {
  inputs?: Record<string, string | string[]>;
  locked?: Record<string, unknown>;
  original?: Record<string, unknown>;
  flake?: boolean;
};

const github = (owner: string, repo: string, rev: string, original: Record<string, string> = {}): LockNode => ({
  locked: {
    lastModified: 1730785428,
    narHash: `sha256-${rev.slice(0, 8)}TVJTEum+L+0zVAWvXAGbWAuXHax3KzuejaDyo=`,
    owner,
    repo,
    rev,
    type: "github",
  },
  original: { owner, repo, type: "github", ...original },
});

const lock = (nodes: Record<string, LockNode>, root: Record<string, string | string[]>): string => {
  const all: Record<string, LockNode> = { ...nodes, root: { inputs: root } };
  const sorted = Object.fromEntries(Object.keys(all).sort().map((name) => [name, all[name]]));
  return `${JSON.stringify({ nodes: sorted, root: "root", version: 7 }, null, 2)}\n`;
};

/** 1-based line of a node's key in a lock produced by {@link lock}. */
const nodeLine = (content: string, name: string): number =>
  content.slice(0, content.indexOf(`"${name}": {`, content.indexOf('"nodes"'))).split("\n").length;

const NIXPKGS = github("NixOS", "nixpkgs", "4aa36568d413aca0ea84a1684d2d46f55dbabad7", { ref: "nixos-24.11" });
const FLAKE_UTILS = { ...github("numtide", "flake-utils", "11707dc2f618dd54ca8739b309ec4fc024de578b"), inputs: { systems: "systems" } };
const SYSTEMS = github("nix-systems", "default", "da67096a3b9bf56a91d16901293e51ba5b49a27e");

const LOCK = lock({ nixpkgs: NIXPKGS, "flake-utils": FLAKE_UTILS, systems: SYSTEMS }, { nixpkgs: "nixpkgs", "flake-utils": "flake-utils" });

const FLAKE = nix(
  "{",
  "  inputs = {",
  '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";',
  '    flake-utils.url = "github:numtide/flake-utils";',
  "  };",
  "  outputs = { self, nixpkgs, flake-utils }: { };",
  "}",
);

const DANGLING = lock(
  { nixpkgs: NIXPKGS, "flake-utils": { ...FLAKE_UTILS, inputs: { systems: "systems_2" } }, systems: SYSTEMS },
  { nixpkgs: "nixpkgs", "flake-utils": "flake-utils" },
);

ruleTester(rule, {
  valid: [
    { name: "flake.nix and flake.lock agree", files: { "flake.nix": FLAKE, "flake.lock": LOCK } },
    {
      name: "trap: follows entries are arrays in the lock and are not node references",
      files: {
        "flake.nix": nix(
          "{",
          '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";',
          '  inputs.flake-utils.url = "github:numtide/flake-utils";',
          '  inputs.flake-utils.inputs.systems.follows = "systems";',
          '  inputs.systems.url = "github:nix-systems/default";',
          '  inputs.pkgs.follows = "nixpkgs";',
          "  outputs = { self, ... }: { };",
          "}",
        ),
        "flake.lock": lock(
          { nixpkgs: NIXPKGS, "flake-utils": { ...FLAKE_UTILS, inputs: { systems: ["systems"] } }, systems: SYSTEMS },
          { nixpkgs: "nixpkgs", "flake-utils": "flake-utils", systems: "systems", pkgs: ["nixpkgs"] },
        ),
      },
    },
    {
      name: "trap: ?ref= and path-segment refs lock to the same original; interpolated URLs are not compared",
      files: {
        "flake.nix": nix(
          "let branch = \"nixos-24.11\"; in",
          "{",
          '  inputs.nixpkgs.url = "github:NixOS/nixpkgs?ref=nixos-24.11";',
          '  inputs.flake-utils.url = "github:numtide/flake-utils/${branch}";',
          "  outputs = { self, nixpkgs, flake-utils }: { };",
          "}",
        ),
        "flake.lock": LOCK,
      },
    },
    {
      name: "trap: self is never locked, and dir/host fields are compared conservatively",
      files: {
        "flake.nix": nix(
          "{",
          "  inputs.self.submodules = true;",
          '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";',
          '  inputs.flake-utils.url = "gitlab:numtide/flake-utils?host=gitlab.example.com";',
          "  outputs = { self, nixpkgs, flake-utils }: { };",
          "}",
        ),
        "flake.lock": LOCK,
      },
    },
    {
      name: "trap: a lock without flake.nix and an unsupported lock version are left alone",
      files: {
        "flake.lock": LOCK,
        "old/flake.nix": FLAKE,
        "old/flake.lock": LOCK.replace('"version": 7', '"version": 4').replace('"nixpkgs": "nixpkgs"\n', '"nixpkgs": "gone"\n'),
      },
    },
  ],
  invalid: [
    {
      name: "input added to flake.nix without re-locking",
      files: {
        "flake.nix": nix(
          "{",
          "  inputs = {",
          '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";',
          '    flake-utils.url = "github:numtide/flake-utils";',
          "    rust-overlay = {",
          '      url = "github:oxalica/rust-overlay";',
          '      inputs.nixpkgs.follows = "nixpkgs";',
          "    };",
          "  };",
          "  outputs = { self, nixpkgs, flake-utils, rust-overlay }: { };",
          "}",
        ),
        "flake.lock": LOCK,
      },
      errors: [{ path: "flake.nix", line: 6, messageIncludes: "Input `rust-overlay` is declared" }],
    },
    {
      name: "input URL changed without re-locking",
      files: {
        "flake.nix": FLAKE.replace("nixos-24.11", "nixos-24.05"),
        "flake.lock": LOCK,
      },
      errors: [
        {
          path: "flake.nix",
          line: 3,
          messageIncludes: "is `github:NixOS/nixpkgs/nixos-24.05` in `flake.nix` but `flake.lock` still locks `github:NixOS/nixpkgs/nixos-24.11`",
        },
      ],
    },
    {
      name: "dangling node reference",
      files: { "flake.nix": FLAKE, "flake.lock": DANGLING },
      errors: [{ path: "flake.lock", line: nodeLine(DANGLING, "flake-utils"), messageIncludes: "to node `systems_2`, which does not exist" }],
    },
    {
      name: "subdirectory flake with a shorthand input missing from its lock",
      files: {
        "infra/flake.nix": nix(
          "{",
          '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";',
          '  inputs.flake-utils.url = "github:numtide/flake-utils";',
          '  inputs.deploy-rs = "github:serokell/deploy-rs";',
          "  outputs = { self, ... }: { };",
          "}",
        ),
        "infra/flake.lock": LOCK,
      },
      errors: [{ path: "infra/flake.nix", line: 4, messageIncludes: "`infra/flake.lock` has no entry" }],
    },
  ],
});
