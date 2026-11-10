import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/nix/no-lock-update-automation.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

const FLAKE = nix(
  "{",
  '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";',
  '  inputs.flake-utils.url = "github:numtide/flake-utils";',
  "  outputs = { self, nixpkgs, flake-utils }: { };",
  "}",
);

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

const lockedGithub = (owner: string, repo: string, rev: string, lastModified: number): Record<string, unknown> => ({
  lastModified,
  narHash: `sha256-${rev.slice(0, 8)}TVJTEum+L+0zVAWvXAGbWAuXHax3KzuejaDyo=`,
  owner,
  repo,
  rev,
  type: "github",
});

// nixpkgs pinned 2024-11-05, flake-utils pinned 2024-03-11 (the older one).
const LOCK = lock(
  {
    "flake-utils": {
      inputs: { systems: "systems" },
      locked: lockedGithub("numtide", "flake-utils", "b1d9ab70662946ef0850d488da1c9019f3a9752a", 1710146030),
      original: { owner: "numtide", repo: "flake-utils", type: "github" },
    },
    nixpkgs: {
      locked: lockedGithub("NixOS", "nixpkgs", "a3c0b3b21515f74fd2665903d4ce6bc4dc81c77c", 1730785428),
      original: { owner: "NixOS", ref: "nixos-24.11", repo: "nixpkgs", type: "github" },
    },
    systems: {
      locked: lockedGithub("nix-systems", "default", "da67096a3b9bf56a91d16901293e51ba5b49a27e", 1681028828),
      original: { owner: "nix-systems", repo: "default", type: "github" },
    },
  },
  { "flake-utils": "flake-utils", nixpkgs: "nixpkgs" },
);

const FLAKE_FILES = { "flake.nix": FLAKE, "flake.lock": LOCK };

const DEPENDABOT_ACTIONS_ONLY = nix(
  "version: 2",
  "updates:",
  '  - package-ecosystem: "github-actions"',
  '    directory: "/"',
  "    schedule:",
  '      interval: "weekly"',
);

const DEPENDABOT_NIX = nix(
  "version: 2",
  "updates:",
  '  - package-ecosystem: "nix"',
  '    directory: "/"',
  "    schedule:",
  '      interval: "weekly"',
);

const workflow = (on: string[], steps: string[]): string =>
  nix("name: lock", "on:", ...on.map((line) => `  ${line}`), "jobs:", "  update:", "    runs-on: ubuntu-latest", "    steps:", ...steps.map((line) => `      ${line}`));

const INSTALL = ["- uses: actions/checkout@v4", "- uses: DeterminateSystems/nix-installer-action@v16"];

describe("nix/no-lock-update-automation", () => {
  ruleTester(rule, {
    valid: [
      {
        name: "Dependabot has a nix entry for the root",
        files: { ...FLAKE_FILES, ".github/dependabot.yml": DEPENDABOT_NIX },
      },
      {
        name: "Dependabot nix entry uses a directories glob that covers nested flakes",
        files: {
          ...FLAKE_FILES,
          "nix/dev/flake.nix": FLAKE,
          "nix/dev/flake.lock": LOCK,
          ".github/dependabot.yml": nix(
            "version: 2",
            "updates:",
            '  - package-ecosystem: "nix"',
            '    directories: ["/", "/nix/**"]',
            "    schedule:",
            '      interval: "weekly"',
          ),
        },
      },
      {
        name: "Renovate enables the nix manager",
        files: { ...FLAKE_FILES, "renovate.json": '{\n  "extends": ["config:recommended"],\n  "nix": { "enabled": true }\n}\n' },
      },
      {
        name: "Renovate lists nix in enabledManagers (.github/renovate.json5)",
        files: { ...FLAKE_FILES, ".github/renovate.json5": "{\n  enabledManagers: ['nix', 'github-actions'],\n}\n" },
      },
      {
        name: "trap: Renovate extends a shared org preset this rule cannot read",
        files: { ...FLAKE_FILES, "renovate.json": '{ "extends": ["config:recommended", "github>acme/renovate-config"] }\n' },
      },
      {
        name: "Renovate config embedded in package.json",
        files: {
          ...FLAKE_FILES,
          "package.json": JSON.stringify({ name: "demo", renovate: { nix: { enabled: true } } }, null, 2),
        },
      },
      {
        name: "DeterminateSystems/update-flake-lock workflow",
        files: {
          ...FLAKE_FILES,
          ".github/workflows/update.yml": workflow(
            ["workflow_dispatch:", "schedule:", "  - cron: '0 0 * * 0'"],
            [...INSTALL, "- uses: DeterminateSystems/update-flake-lock@v24"],
          ),
        },
      },
      {
        name: "scheduled workflow runs nix flake update and opens a PR",
        files: {
          ...FLAKE_FILES,
          ".github/workflows/bump.yml": workflow(
            ["schedule:", "  - cron: '0 3 * * 1'"],
            [...INSTALL, "- run: nix flake update --commit-lock-file", "- uses: peter-evans/create-pull-request@v7"],
          ),
        },
      },
      {
        name: "trap: unparsable dependabot.yml is treated as unknown",
        files: { ...FLAKE_FILES, ".github/dependabot.yml": "version: 2\nupdates: [\n  - {\n" },
      },
      {
        name: "trap: lock whose only input is a local path",
        files: {
          "flake.nix": nix("{", '  inputs.lib.url = "path:./lib";', "  outputs = { self, lib }: { };", "}"),
          "flake.lock": lock(
            {
              lib: {
                locked: { lastModified: 1730785428, narHash: "sha256-AAAA", path: "./lib", type: "path" },
                original: { path: "./lib", type: "path" },
              },
            },
            { lib: "lib" },
          ),
        },
      },
      {
        name: "trap: flake under templates/ is sample code",
        files: { "templates/default/flake.nix": FLAKE, "templates/default/flake.lock": LOCK },
      },
      {
        name: "trap: flake.nix without a lock is missing-flake-lock's finding",
        files: { "flake.nix": FLAKE },
      },
      {
        name: "trap: pull request mode with a partial inventory",
        mode: "pull_request",
        inventoryComplete: false,
        files: FLAKE_FILES,
      },
    ],
    invalid: [
      {
        name: "no automation at all",
        files: FLAKE_FILES,
        errors: [{ path: "flake.lock", line: 1, messageIncludes: "pins 2 inputs (oldest pinned commit: `flake-utils` from 2024-03-11)" }],
      },
      {
        name: "Dependabot only covers github-actions",
        files: { ...FLAKE_FILES, ".github/dependabot.yml": DEPENDABOT_ACTIONS_ONLY },
        errors: [{ line: 1, messageIncludes: '`.github/dependabot.yml` has no `package-ecosystem: "nix"` entry' }],
      },
      {
        name: "Renovate config without the (default-off) nix manager",
        files: { ...FLAKE_FILES, "renovate.json": '{ "extends": ["config:recommended", ":dependencyDashboard"] }\n' },
        errors: [{ line: 1, messageIncludes: "`renovate.json` does not enable Renovate's `nix` manager" }],
      },
      {
        name: "nix flake update only runs on push",
        files: {
          ...FLAKE_FILES,
          ".github/workflows/ci.yml": workflow(["push:"], [...INSTALL, "- run: nix flake update && nix flake check"]),
        },
        errors: [{ line: 1, messageIncludes: "`.github/workflows/ci.yml` runs `nix flake update` but has no `schedule:`/dispatch trigger" }],
      },
      {
        name: "Dependabot nix entry for / leaves a nested flake uncovered",
        files: {
          ...FLAKE_FILES,
          "dev/flake.nix": FLAKE,
          "dev/flake.lock": LOCK,
          ".github/dependabot.yml": DEPENDABOT_NIX,
        },
        errors: [{ path: "dev/flake.lock", line: 1, messageIncludes: "do not list its directory" }],
      },
    ],
  });

  it("suggests a complete dependabot.yml when none exists", () => {
    const [diagnostic] = runRule(rule, { name: "suggestion", files: FLAKE_FILES });
    expect(diagnostic?.suggestion).toContain(
      'version: 2\nupdates:\n  - package-ecosystem: "nix"\n    directory: "/"\n    schedule:\n      interval: "weekly"',
    );
    expect(diagnostic?.suggestion).toContain('"nix": { "enabled": true }');
  });

  it("suggests only the entry, with every uncovered directory, when dependabot.yml exists", () => {
    const diagnostics = runRule(rule, {
      name: "multi",
      files: {
        ...FLAKE_FILES,
        "tools/flake.nix": FLAKE,
        "tools/flake.lock": LOCK,
        ".github/dependabot.yml": DEPENDABOT_ACTIONS_ONLY,
      },
    });
    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics;
    expect(diagnostic?.message).toContain("2 lock files (`flake.lock`, `tools/flake.lock`)");
    expect(diagnostic?.suggestion).toContain('  - package-ecosystem: "nix"\n    directories:\n      - "/"\n      - "/tools"');
    expect(diagnostic?.suggestion).not.toContain("version: 2");
    expect(diagnostic?.related).toEqual([{ path: "tools/flake.lock", line: 1 }]);
  });
});
