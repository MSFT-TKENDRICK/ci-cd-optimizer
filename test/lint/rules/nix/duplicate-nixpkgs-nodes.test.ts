import rule from "../../../../src/lint/rules/nix/duplicate-nixpkgs-nodes.js";
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

const nodeLine = (content: string, name: string): number =>
  content.slice(0, content.indexOf(`"${name}": {`, content.indexOf('"nodes"'))).split("\n").length;

const UNSTABLE = github("NixOS", "nixpkgs", "a3c0b3b21515f74fd2665903d4ce6bc4dc81c77c", { ref: "nixos-unstable" });
const UNSTABLE_OLD = github("NixOS", "nixpkgs", "5e4fbfb6b3de1aa2872b76d49fafc942626e2add", { ref: "nixos-unstable" });
const STABLE = github("NixOS", "nixpkgs", "4aa36568d413aca0ea84a1684d2d46f55dbabad7", { ref: "nixos-24.11" });
const STABLE_OLD = github("NixOS", "nixpkgs", "e2605d0744c2417b09f8bf850dfca42fcf537d34", { ref: "nixos-24.11" });
const withInputs = (node: LockNode, inputs: Record<string, string | string[]>): LockNode => ({ ...node, inputs });
const HOME_MANAGER = (nixpkgs: string | string[]): LockNode =>
  withInputs(github("nix-community", "home-manager", "8cf9cb2ee78aa129e5b8220135a511a2be254c0c"), { nixpkgs });

const DUPLICATE_LOCK = lock(
  { "home-manager": HOME_MANAGER("nixpkgs_2"), nixpkgs: UNSTABLE, nixpkgs_2: UNSTABLE_OLD },
  { "home-manager": "home-manager", nixpkgs: "nixpkgs" },
);

const BLOCK_FLAKE = nix(
  "{",
  '  description = "workstation";',
  "  inputs = {",
  '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
  '    home-manager.url = "github:nix-community/home-manager";',
  "  };",
  "  outputs = { self, nixpkgs, home-manager }: { };",
  "}",
);

const HYPRLAND_LOCK = lock(
  {
    hyprland: withInputs(github("hyprwm", "Hyprland", "0c7a7e2d569eeed9d6025f3eef4ea0690d90845d"), { nixpkgs: "nixpkgs_2" }),
    nixpkgs: UNSTABLE,
    nixpkgs_2: UNSTABLE_OLD,
  },
  { hyprland: "hyprland", nixpkgs: "nixpkgs" },
);

const HYPRLAND_FLAKE = nix(
  "{",
  "  inputs = {",
  '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
  '    hyprland.url = "github:hyprwm/Hyprland";',
  "  };",
  "  outputs = { self, nixpkgs, hyprland }: { };",
  "}",
);

ruleTester(rule, {
  valid: [
    {
      name: "home-manager already follows nixpkgs (follows path in the lock)",
      files: {
        "flake.nix": nix(
          "{",
          "  inputs = {",
          '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
          '    home-manager.url = "github:nix-community/home-manager";',
          '    home-manager.inputs.nixpkgs.follows = "nixpkgs";',
          "  };",
          "  outputs = { self, nixpkgs, home-manager }: { };",
          "}",
        ),
        "flake.lock": lock({ "home-manager": HOME_MANAGER(["nixpkgs"]), nixpkgs: UNSTABLE }, { "home-manager": "home-manager", nixpkgs: "nixpkgs" }),
      },
    },
    {
      name: "trap: a second nixpkgs node with the same revision shares every store path",
      files: {
        "flake.nix": BLOCK_FLAKE,
        "flake.lock": lock(
          { "home-manager": HOME_MANAGER("nixpkgs_2"), nixpkgs: UNSTABLE, nixpkgs_2: UNSTABLE },
          { "home-manager": "home-manager", nixpkgs: "nixpkgs" },
        ),
      },
    },
    {
      name: "trap: follows already declared in flake.nix but the lock is stale (re-locking fixes it)",
      files: {
        "flake.nix": nix(
          "{",
          "  inputs = {",
          '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
          "    home-manager = {",
          '      url = "github:nix-community/home-manager";',
          '      inputs.nixpkgs.follows = "nixpkgs";',
          "    };",
          "  };",
          "  outputs = { self, nixpkgs, home-manager }: { };",
          "}",
        ),
        "flake.lock": DUPLICATE_LOCK,
      },
    },
    {
      name: "trap: the flake has no nixpkgs input of its own to follow",
      files: {
        "flake.nix": nix(
          "{",
          "  inputs = {",
          '    home-manager.url = "github:nix-community/home-manager";',
          '    sops-nix.url = "github:Mic92/sops-nix";',
          "  };",
          "  outputs = { self, home-manager, sops-nix }: { };",
          "}",
        ),
        "flake.lock": lock(
          {
            "home-manager": HOME_MANAGER("nixpkgs"),
            nixpkgs: UNSTABLE,
            nixpkgs_2: UNSTABLE_OLD,
            "sops-nix": withInputs(github("Mic92", "sops-nix", "f30b1bac192e2dc252107ac8a59a03ad25e1b96e"), { nixpkgs: "nixpkgs_2" }),
          },
          { "home-manager": "home-manager", "sops-nix": "sops-nix" },
        ),
      },
    },
    {
      name: "trap: Hyprland is not followed on purpose so hyprland.cachix.org (in nixConfig) has its outputs",
      files: {
        "flake.nix": HYPRLAND_FLAKE.replace(
          "  outputs",
          [
            "  nixConfig = {",
            '    extra-substituters = [ "https://hyprland.cachix.org" ];',
            '    extra-trusted-public-keys = [ "hyprland.cachix.org-1:a7pgxzMz7+chwVL3/pzj6jIBMioiJM7ypFP8PwtkuGc=" ];',
            "  };",
            "  outputs",
          ].join("\n"),
        ),
        "flake.lock": HYPRLAND_LOCK,
      },
    },
    {
      name: "trap: Hyprland's cache is pulled by cachix-action in CI",
      files: {
        "flake.nix": HYPRLAND_FLAKE,
        "flake.lock": HYPRLAND_LOCK,
        ".github/workflows/ci.yml": [
          "on: push",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "      - uses: cachix/install-nix-action@v31",
          "      - uses: cachix/cachix-action@v16",
          "        with:",
          "          name: my-cache",
          "          extraPullNames: hyprland",
          "      - run: nix build",
          "",
        ].join("\n"),
      },
    },
    {
      name: "trap: a nixpkgs fork is not a duplicate of NixOS/nixpkgs",
      files: {
        "flake.nix": BLOCK_FLAKE,
        "flake.lock": lock(
          {
            "home-manager": HOME_MANAGER("nixpkgs_2"),
            nixpkgs: UNSTABLE,
            nixpkgs_2: github("nix-community", "nixpkgs", "5e4fbfb6b3de1aa2872b76d49fafc942626e2add", { ref: "nixos-unstable" }),
          },
          { "home-manager": "home-manager", nixpkgs: "nixpkgs" },
        ),
      },
    },
  ],
  invalid: [
    {
      name: "home-manager pulls its own nixos-unstable: fix inserts follows inside the inputs block",
      files: { "flake.nix": BLOCK_FLAKE, "flake.lock": DUPLICATE_LOCK },
      errors: [{ path: "flake.nix", line: 5, messageIncludes: "`home-manager` locks its own nixpkgs (`nixpkgs` → lock node `nixpkgs_2`" }],
      output: {
        "flake.nix": BLOCK_FLAKE.replace(
          '    home-manager.url = "github:nix-community/home-manager";\n',
          '    home-manager.url = "github:nix-community/home-manager";\n    home-manager.inputs.nixpkgs.follows = "nixpkgs";\n',
        ),
      },
    },
    {
      name: "top-level inputs.<x>.url bindings and a dependency that follows a stable root input",
      files: {
        "flake.nix": nix(
          "{",
          '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
          '  inputs.nixpkgs-stable.url = "github:NixOS/nixpkgs/nixos-24.11";',
          '  inputs.sops-nix.url = "github:Mic92/sops-nix"; # secrets',
          "  outputs = { self, nixpkgs, nixpkgs-stable, sops-nix }: { };",
          "}",
        ),
        "flake.lock": lock(
          {
            nixpkgs: UNSTABLE,
            "nixpkgs-stable": STABLE,
            nixpkgs_2: STABLE_OLD,
            "sops-nix": withInputs(github("Mic92", "sops-nix", "f30b1bac192e2dc252107ac8a59a03ad25e1b96e"), {
              "nixpkgs-stable": "nixpkgs_2",
            }),
          },
          { nixpkgs: "nixpkgs", "nixpkgs-stable": "nixpkgs-stable", "sops-nix": "sops-nix" },
        ),
      },
      errors: [{ line: 4, messageIncludes: "instead of following `nixpkgs-stable`; flake.lock holds 3 distinct nixpkgs revisions" }],
      output: {
        "flake.nix": nix(
          "{",
          '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
          '  inputs.nixpkgs-stable.url = "github:NixOS/nixpkgs/nixos-24.11";',
          '  inputs.sops-nix.url = "github:Mic92/sops-nix"; # secrets',
          '  inputs.sops-nix.inputs.nixpkgs-stable.follows = "nixpkgs-stable";',
          "  outputs = { self, nixpkgs, nixpkgs-stable, sops-nix }: { };",
          "}",
        ),
      },
    },
    {
      name: "input attribute set: the follows line is added inside it",
      files: {
        "flake.nix": nix(
          "{",
          "  inputs = {",
          '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
          "    home-manager = {",
          '      url = "github:nix-community/home-manager";',
          "    };",
          "  };",
          "  outputs = { self, nixpkgs, home-manager }: { };",
          "}",
        ),
        "flake.lock": DUPLICATE_LOCK,
      },
      errors: [{ line: 5, messageIncludes: "`home-manager`" }],
      output: {
        "flake.nix": nix(
          "{",
          "  inputs = {",
          '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
          "    home-manager = {",
          '      url = "github:nix-community/home-manager";',
          '      inputs.nixpkgs.follows = "nixpkgs";',
          "    };",
          "  };",
          "  outputs = { self, nixpkgs, home-manager }: { };",
          "}",
        ),
      },
    },
    {
      name: "different release: reported with a compatibility warning and no autofix",
      files: {
        "flake.nix": BLOCK_FLAKE.replace("nixos-unstable", "nixos-24.11"),
        "flake.lock": lock(
          { "home-manager": HOME_MANAGER("nixpkgs_2"), nixpkgs: STABLE, nixpkgs_2: UNSTABLE },
          { "home-manager": "home-manager", nixpkgs: "nixpkgs" },
        ),
      },
      errors: [{ line: 5, messageIncludes: "It asks for `github:NixOS/nixpkgs/nixos-unstable` at a3c0b3b" }],
      output: { "flake.nix": BLOCK_FLAKE.replace("nixos-unstable", "nixos-24.11") },
    },
    {
      name: "flake.nix the parser cannot read (let ... in): reported on the lock node",
      files: {
        "flake.nix": nix(
          "let",
          '  systems = [ "x86_64-linux" ];',
          "in {",
          '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
          '  inputs.home-manager.url = "github:nix-community/home-manager";',
          "  outputs = { self, nixpkgs, home-manager }: { };",
          "}",
        ),
        "flake.lock": DUPLICATE_LOCK,
      },
      errors: [{ path: "flake.lock", line: nodeLine(DUPLICATE_LOCK, "home-manager"), messageIncludes: "`home-manager`" }],
    },
    {
      name: "two inputs each bring their own nixpkgs",
      files: {
        "flake.nix": nix(
          "{",
          "  inputs = {",
          '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
          '    home-manager.url = "github:nix-community/home-manager";',
          '    disko.url = "github:nix-community/disko";',
          "  };",
          "  outputs = { self, nixpkgs, home-manager, disko }: { };",
          "}",
        ),
        "flake.lock": lock(
          {
            disko: withInputs(github("nix-community", "disko", "2814a5224a47ca19e858e027f7e8ff74a8aee811"), { nixpkgs: "nixpkgs_3" }),
            "home-manager": HOME_MANAGER("nixpkgs_2"),
            nixpkgs: UNSTABLE,
            nixpkgs_2: UNSTABLE_OLD,
            nixpkgs_3: github("NixOS", "nixpkgs", "0ff09db9d034a04acd4e8908820ba0b410d7a33a", { ref: "nixpkgs-unstable" }),
          },
          { disko: "disko", "home-manager": "home-manager", nixpkgs: "nixpkgs" },
        ),
      },
      errors: [
        { line: 4, messageIncludes: "`home-manager`" },
        { line: 5, messageIncludes: "`disko` locks its own nixpkgs (`nixpkgs` → lock node `nixpkgs_3`" },
      ],
    },
  ],
});
