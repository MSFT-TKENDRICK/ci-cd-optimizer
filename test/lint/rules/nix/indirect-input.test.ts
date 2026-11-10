import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/nix/indirect-input.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

/** A flake whose first input is on line 4 and whose `outputs` follows the last input's line + 1. */
const flake = (inputs: string[], outputs = "outputs = inputs: { };"): string =>
  nix("{", '  description = "demo";', "  inputs = {", ...inputs.map((line) => `    ${line}`), "  };", `  ${outputs}`, "}");

type LockNode = {
  inputs?: Record<string, string | string[]>;
  locked?: Record<string, unknown>;
  original?: Record<string, unknown>;
  flake?: boolean;
};

const lock = (nodes: Record<string, LockNode>, root: Record<string, string | string[]>): string => {
  const all: Record<string, LockNode> = { ...nodes, root: { inputs: root } };
  const sorted = Object.fromEntries(Object.keys(all).sort().map((name) => [name, all[name]]));
  return `${JSON.stringify({ nodes: sorted, root: "root", version: 7 }, null, 2)}\n`;
};

const lockedGithub = (owner: string, repo: string, rev: string): Record<string, unknown> => ({
  lastModified: 1730785428,
  narHash: `sha256-${rev.slice(0, 8)}TVJTEum+L+0zVAWvXAGbWAuXHax3KzuejaDyo=`,
  owner,
  repo,
  rev,
  type: "github",
});

const NIXPKGS_GITHUB: LockNode = {
  locked: lockedGithub("NixOS", "nixpkgs", "a3c0b3b21515f74fd2665903d4ce6bc4dc81c77c"),
  original: { owner: "NixOS", ref: "nixos-24.11", repo: "nixpkgs", type: "github" },
};

describe("nix/indirect-input", () => {
  ruleTester(rule, {
    valid: [
      {
        name: "explicit github: inputs",
        files: { "flake.nix": flake(['nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";', 'flake-utils.url = "github:numtide/flake-utils";']) },
      },
      {
        name: "a follows-only input and a source input with flake = false",
        files: {
          "flake.nix": flake([
            'home-manager.url = "github:nix-community/home-manager";',
            'nixpkgs.follows = "home-manager/nixpkgs";',
            'src = { url = "github:acme/assets"; flake = false; };',
          ]),
        },
      },
      {
        name: "attribute-style github input and a relative path input",
        files: {
          "flake.nix": flake(['pkgs = { type = "github"; owner = "NixOS"; repo = "nixpkgs"; ref = "nixos-24.11"; };', 'sub.url = "path:./sub";']),
        },
      },
      {
        name: "outputs only takes self and declared inputs, or binds them all with @",
        files: {
          "flake.nix": flake(['nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";'], "outputs = { self, nixpkgs, ... }@inputs: { };"),
        },
      },
      {
        name: "trap: inputs imported from another file cannot be read, so outputs args are not implicit inputs",
        files: {
          "flake.nix": nix("{", "  inputs = import ./inputs.nix;", "  outputs = { self, nixpkgs }: { };", "}"),
        },
      },
      {
        name: "trap: inputs merged with // cannot be fully read",
        files: {
          "flake.nix": nix(
            "{",
            '  inputs = { nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11"; } // import ./extra-inputs.nix;',
            "  outputs = { self, nixpkgs, flake-utils }: { };",
            "}",
          ),
        },
      },
      {
        name: "trap: an input whose source the parser cannot read is not untyped",
        files: { "flake.nix": flake(["src = builtins.fromJSON (builtins.readFile ./src.json);"]) },
      },
      {
        name: "trap: the lock says an inferred input was not resolved through the registry",
        files: {
          "flake.nix": flake(['nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";'], "outputs = { self, nixpkgs, utils }: { };"),
          "flake.lock": lock(
            {
              nixpkgs: NIXPKGS_GITHUB,
              utils: {
                locked: lockedGithub("numtide", "flake-utils", "11707dc2f618dd54ca8739b309ec4fc024de578b"),
                original: { owner: "numtide", repo: "flake-utils", type: "github" },
              },
            },
            { nixpkgs: "nixpkgs", utils: "utils" },
          ),
        },
      },
      {
        name: "flakes under templates/ are samples",
        files: { "templates/default/flake.nix": flake(['nixpkgs.url = "nixpkgs";']) },
      },
    ],
    invalid: [
      {
        name: "bare registry id",
        files: { "flake.nix": flake(['nixpkgs.url = "nixpkgs";']) },
        errors: [{ path: "flake.nix", line: 4, messageIncludes: 'Input `nixpkgs` uses the indirect flake reference `nixpkgs`' }],
      },
      {
        name: "flake: reference with a branch keeps the branch",
        files: { "flake.nix": flake(['nixpkgs.url = "flake:nixpkgs/nixos-24.11";']) },
        errors: [{ line: 4, messageIncludes: "e.g. `github:NixOS/nixpkgs/nixos-24.11`" }],
      },
      {
        name: "registry id with a branch, written in the attribute-set form",
        files: { "flake.nix": flake(["home-manager = {", '  url = "home-manager/release-24.11";', "};"]) },
        errors: [{ line: 5, messageIncludes: "github:nix-community/home-manager/release-24.11" }],
      },
      {
        name: "an input declared only through nested follows is an indirect reference",
        files: {
          "flake.nix": flake(['nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";', 'home-manager.inputs.nixpkgs.follows = "nixpkgs";']),
        },
        errors: [{ line: 5, messageIncludes: "Input `home-manager` has no `url` or `type`" }],
      },
      {
        name: "an outputs argument that is not declared is an implicit indirect input",
        files: {
          "flake.nix": flake(['nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";'], "outputs = { self, nixpkgs, flake-utils }: { };"),
        },
        errors: [{ line: 6, messageIncludes: "`outputs` takes `flake-utils`, which is not declared under `inputs`" }],
      },
      {
        name: "type = indirect attribute form",
        files: { "flake.nix": flake(['pkgs = { type = "indirect"; id = "nixpkgs"; ref = "nixos-24.11"; };']) },
        errors: [{ line: 4, messageIncludes: 'declared with `type = "indirect"` (`flake:nixpkgs/nixos-24.11`)' }],
      },
      {
        name: "unregistered id takes its owner from the lock",
        files: {
          "flake.nix": flake(['mytool.url = "mytool";']),
          "flake.lock": lock(
            {
              mytool: {
                locked: lockedGithub("acme", "mytool", "0f0d5e0e8f1b2c3d4e5f60718293a4b5c6d7e8f9"),
                original: { id: "mytool", type: "indirect" },
              },
            },
            { mytool: "mytool" },
          ),
        },
        errors: [{ path: "flake.nix", line: 4, messageIncludes: "Input `mytool` uses the indirect flake reference `mytool`, which Nix resolves through whichever flake registry wins on the machine (~/.config/nix/registry.json, then /etc/nix/registry.json, then the downloaded global registry); every `nix flake update` re-resolves it there. Declare the source explicitly, e.g. `github:acme/mytool/0f0d5e0e8f1b2c3d4e5f60718293a4b5c6d7e8f9`." }],
      },
      {
        name: "unregistered id without a lock gets a placeholder owner",
        files: { "flake.nix": flake(['mytool.url = "flake:mytool";']) },
        errors: [{ line: 4, messageIncludes: "e.g. `github:<owner>/mytool`" }],
      },
      {
        name: "a literal indirect url is reported even when the lock disagrees",
        files: {
          "flake.nix": flake(['nixpkgs.url = "nixpkgs/nixos-24.11";']),
          "flake.lock": lock({ nixpkgs: NIXPKGS_GITHUB }, { nixpkgs: "nixpkgs" }),
        },
        errors: [{ path: "flake.nix", line: 4, messageIncludes: "`nixpkgs/nixos-24.11`" }],
      },
      {
        name: "nested flake reports at its own flake.nix",
        files: {
          "flake.nix": flake(['nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";']),
          "nix/dev/flake.nix": flake(['nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";', 'devshell.inputs.nixpkgs.follows = "nixpkgs";']),
        },
        errors: [{ path: "nix/dev/flake.nix", line: 5, messageIncludes: "`devshell`" }],
      },
    ],
  });

  describe("suggestion", () => {
    const suggestion = (files: Record<string, string>): string | undefined => runRule(rule, { files })[0]?.suggestion;

    it("points a bare nixpkgs at the channel the global registry uses and mentions the stable channel", () => {
      const text = suggestion({ "flake.nix": flake(['nixpkgs.url = "nixpkgs";']) });
      expect(text).toContain('inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";');
      expect(text).toContain("github:NixOS/nixpkgs/nixos-26.05");
      expect(text).toContain("nix flake lock --update-input nixpkgs");
    });

    it("maps registry ids to their GitHub repository", () => {
      const text = suggestion({ "flake.nix": flake(['utils.url = "flake-utils";']) });
      expect(text).toContain('inputs.utils.url = "github:numtide/flake-utils";');
      expect(text).not.toContain("<owner>");
    });

    it("explains an unknown owner and a store-path lock from a machine-local registry pin", () => {
      const text = suggestion({
        "flake.nix": flake(['mytool.url = "mytool";']),
        "flake.lock": lock(
          {
            mytool: {
              locked: {
                lastModified: 1730785428,
                narHash: "sha256-PfDJdmb5bFS0Z2NIA4M8C3V/k1dsBGvnZ/U2jRaVwWQ=",
                path: "/nix/store/7a2kc1rxzxh9a1rli5q0r5d2c8j3a5ap-source",
                type: "path",
              },
              original: { id: "mytool", type: "indirect" },
            },
          },
          { mytool: "mytool" },
        ),
      });
      expect(text).toContain('inputs.mytool.url = "github:<owner>/mytool";');
      expect(text).toContain("nix flake metadata mytool");
      expect(text).toContain("/nix/store/7a2kc1rxzxh9a1rli5q0r5d2c8j3a5ap-source");
    });
  });
});
