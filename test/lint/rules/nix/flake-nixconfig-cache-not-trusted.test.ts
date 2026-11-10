import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/nix/flake-nixconfig-cache-not-trusted.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

const KEY = "demo.cachix.org-1:8sTYb3qyGkWwVjZRNBp4uxqTU0OT2YwM2ePLZVKfW9o=";
const COMMUNITY_KEY = "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=";

const flake = (...config: string[]): string =>
  nix(
    "{",
    '  description = "demo";',
    "  nixConfig = {",
    ...config,
    "  };",
    '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";',
    "  outputs = { self, nixpkgs }: { };",
    "}",
  );

// The cache URL is on line 4.
const FLAKE = flake('    extra-substituters = [ "https://demo.cachix.org" ];', `    extra-trusted-public-keys = [ "${KEY}" ];`);

const PLAIN_FLAKE = nix("{", '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";', "  outputs = { self, nixpkgs }: { };", "}");

/** Lines 1-7 are the header; steps start on line 8. */
const workflow = (steps: string[], options: { runsOn?: string; job?: string[] } = {}): string =>
  nix(
    "name: ci",
    "on:",
    "  push:",
    "jobs:",
    "  build:",
    `    runs-on: ${options.runsOn ?? "ubuntu-latest"}`,
    ...(options.job ?? []),
    "    steps:",
    ...steps,
  );

const CHECKOUT = "      - uses: actions/checkout@v4";
const INSTALL = "      - uses: cachix/install-nix-action@v31";

const files = (wf: string, extra: Record<string, string> = {}): Record<string, string> => ({
  "flake.nix": FLAKE,
  ".github/workflows/ci.yml": wf,
  ...extra,
});

ruleTester(rule, {
  valid: [
    {
      name: "nested dev-shell build has an unknown child cache configuration",
      files: files(workflow([CHECKOUT, INSTALL, "      - run: nix develop -c nix build ./sub#app"]), { "flake.nix": PLAIN_FLAKE, "sub/flake.nix": FLAKE }),
    },
    {
      name: "the installer's extra_nix_config adds the substituter and key",
      files: files(
        workflow([
          CHECKOUT,
          INSTALL,
          "        with:",
          "          extra_nix_config: |",
          "            extra-substituters = https://demo.cachix.org",
          `            extra-trusted-public-keys = ${KEY}`,
          "      - run: nix build .#default",
        ]),
      ),
    },
    {
      name: "NIX_CONFIG adds the substituter with a trailing slash",
      files: files(
        workflow([CHECKOUT, INSTALL, "      - run: nix build"], {
          job: ["    env:", "      NIX_CONFIG: |", "        extra-substituters = https://demo.cachix.org/", `        extra-trusted-public-keys = ${KEY}`],
        }),
      ),
    },
    {
      name: "the installer accepts flake configuration",
      files: files(workflow([CHECKOUT, INSTALL, "        with:", "          extra_nix_config: accept-flake-config = true", "      - run: nix build"])),
    },
    {
      name: "the command passes --accept-flake-config",
      files: files(workflow([CHECKOUT, INSTALL, "      - run: nix build --accept-flake-config .#default"])),
    },
    {
      name: "cachix-action with the cache's name adds the substituter",
      files: files(workflow([CHECKOUT, INSTALL, "      - uses: cachix/cachix-action@v17", "        with:", "          name: demo", "      - run: nix build"])),
    },
    {
      name: "cachix-action pulls the cache through extraPullNames",
      files: files(
        workflow([
          CHECKOUT,
          INSTALL,
          "      - uses: cachix/cachix-action@v17",
          "        with:",
          "          name: mine",
          "          extraPullNames: nix-community, demo",
          "      - run: nix build",
        ]),
      ),
    },
    {
      name: "cachix use configures the cache",
      files: files(workflow([CHECKOUT, INSTALL, "      - run: nix profile install nixpkgs#cachix && cachix use demo", "      - run: nix build"])),
    },
    { name: "no workflows", files: { "flake.nix": FLAKE } },
    {
      name: "nixConfig only lists cache.nixos.org",
      files: files(workflow([CHECKOUT, INSTALL, "      - run: nix build"]), {
        "flake.nix": flake('    extra-substituters = [ "https://cache.nixos.org" ];'),
      }),
    },
    {
      name: "trap: classic nix-build does not read flake configuration",
      files: files(workflow([CHECKOUT, INSTALL, "      - run: nix-build default.nix"])),
    },
    {
      name: "trap: building a registry flake does not apply this flake's nixConfig",
      files: files(workflow([CHECKOUT, INSTALL, "      - run: nix build nixpkgs#hello"])),
    },
    {
      name: "trap: self-hosted runners may configure the cache in their own nix.conf",
      files: files(workflow([CHECKOUT, "      - uses: cachix/install-nix-action@v31", "      - run: nix build"], { runsOn: "[self-hosted, nix]" })),
    },
    {
      name: "trap: a subdirectory flake has the cache but the job builds the root flake",
      files: files(workflow([CHECKOUT, INSTALL, "      - run: nix build"]), { "flake.nix": PLAIN_FLAKE, "sub/flake.nix": FLAKE }),
    },
    {
      name: "trap: flake check --no-build and flake show realise nothing",
      files: files(workflow([CHECKOUT, INSTALL, "      - run: nix flake check --no-build", "      - run: nix flake show"])),
    },
    {
      name: "trap: template flakes are skipped",
      files: files(workflow([CHECKOUT, INSTALL, "      - run: nix build ./templates/default"]), {
        "flake.nix": PLAIN_FLAKE,
        "templates/default/flake.nix": FLAKE,
      }),
    },
    {
      name: "trap: a matrix working directory is not resolved",
      files: files(
        workflow([CHECKOUT, INSTALL, "      - run: nix build", "        working-directory: ${{ matrix.dir }}"], {
          job: ["    strategy:", "      matrix:", "        dir: [a, b]"],
        }),
      ),
    },
    {
      name: "trap: an attic cache configured by its own action",
      files: files(
        workflow([
          CHECKOUT,
          INSTALL,
          "      - uses: ryanccn/attic-action@v0",
          "        with:",
          "          endpoint: https://attic.example.com",
          "          cache: demo",
          "      - run: nix build",
        ]),
        { "flake.nix": flake('    extra-substituters = [ "https://attic.example.com/demo" ];') },
      ),
    },
    {
      name: "trap: nix build --expr does not evaluate the flake",
      files: files(workflow([CHECKOUT, INSTALL, "      - run: nix build --impure --expr '(import <nixpkgs> {}).hello'"])),
    },
    {
      name: "the Determinate installer's extra-conf adds the substituter",
      files: files(
        workflow([
          CHECKOUT,
          "      - uses: DeterminateSystems/nix-installer-action@v23",
          "        with:",
          "          extra-conf: |",
          "            extra-substituters = https://demo.cachix.org",
          `            extra-trusted-public-keys = ${KEY}`,
          "      - run: nix develop -c make test",
        ]),
      ),
    },
    {
      name: "the workflow-level NIX_CONFIG accepts flake configuration",
      files: files(
        nix(
          "name: ci",
          "on: push",
          "env:",
          "  NIX_CONFIG: accept-flake-config = true",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          CHECKOUT,
          INSTALL,
          "      - run: nix build",
        ),
      ),
    },
  ],
  invalid: [
    {
      name: "nothing configures the cache",
      files: files(workflow([CHECKOUT, INSTALL, "      - run: nix build"])),
      errors: [{ path: "flake.nix", line: 4, messageIncludes: "adds `https://demo.cachix.org`, but job `build` (`.github/workflows/ci.yml`) runs `nix build`" }],
    },
    {
      name: "the installer adds a different substituter",
      files: files(
        workflow([
          CHECKOUT,
          INSTALL,
          "        with:",
          "          extra_nix_config: |",
          "            extra-substituters = https://nix-community.cachix.org",
          `            extra-trusted-public-keys = ${COMMUNITY_KEY}`,
          "      - run: nix build .#default",
        ]),
      ),
      errors: [{ line: 4, messageIncludes: "runs `nix build .#default`" }],
    },
    {
      name: "only one of two caches is configured",
      files: files(
        workflow([CHECKOUT, INSTALL, "      - uses: cachix/cachix-action@v17", "        with:", "          name: demo", "      - run: nix build"]),
        {
          "flake.nix": flake(
            '    extra-substituters = [ "https://demo.cachix.org" "https://nix-community.cachix.org" ];',
            `    extra-trusted-public-keys = [ "${KEY}" "${COMMUNITY_KEY}" ];`,
          ),
        },
      ),
      errors: [{ line: 4, messageIncludes: "adds `https://nix-community.cachix.org`, but" }],
    },
    {
      name: "accept-flake-config is explicitly false",
      files: files(workflow([CHECKOUT, INSTALL, "        with:", "          extra_nix_config: accept-flake-config = false", "      - run: nix run .#deploy -- --dry-run"])),
      errors: [{ line: 4, messageIncludes: "runs `nix run .#deploy`" }],
    },
    {
      name: "cachix-action skips adding the substituter",
      files: files(
        workflow([
          CHECKOUT,
          INSTALL,
          "      - uses: cachix/cachix-action@v17",
          "        with:",
          "          name: demo",
          "          skipAddingSubstituter: true",
          "      - run: nix build",
        ]),
      ),
      errors: [{ line: 4, messageIncludes: "https://demo.cachix.org" }],
    },
    {
      name: "a step's working directory targets a subdirectory flake",
      files: files(workflow([CHECKOUT, INSTALL, "      - run: nix build", "        working-directory: sub"]), { "flake.nix": PLAIN_FLAKE, "sub/flake.nix": FLAKE }),
      errors: [{ path: "sub/flake.nix", line: 4, messageIncludes: "runs `nix build`" }],
    },
    {
      name: "a ?dir= flake reference targets a subdirectory flake",
      files: files(workflow([CHECKOUT, INSTALL, '      - run: nix build ".?dir=nix/ci#checks"']), { "flake.nix": PLAIN_FLAKE, "nix/ci/flake.nix": FLAKE }),
      errors: [{ path: "nix/ci/flake.nix", line: 4 }],
    },
    {
      name: "shell: nix develop runs every step in the flake's dev shell",
      files: files(workflow([CHECKOUT, INSTALL, "      - run: make test", "        shell: nix develop --command bash -e {0}"])),
      errors: [{ line: 4, messageIncludes: "runs `nix develop`" }],
    },
    {
      name: "the dotted nixConfig form",
      files: files(workflow([CHECKOUT, INSTALL, "      - run: nix flake check"]), {
        "flake.nix": nix(
          "{",
          '  nixConfig.extra-substituters = "https://demo.cachix.org";',
          '  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";',
          "  outputs = { self, nixpkgs }: { };",
          "}",
        ),
      }),
      errors: [{ line: 2, messageIncludes: "`nixConfig.extra-substituters` adds `https://demo.cachix.org`" }],
    },
    {
      name: "two jobs miss the cache and are reported once",
      files: files(
        nix(
          "name: ci",
          "on: push",
          "jobs:",
          "  build:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          CHECKOUT,
          INSTALL,
          "      - run: nix build",
          "  test:",
          "    runs-on: macos-latest",
          "    steps:",
          CHECKOUT,
          INSTALL,
          "      - run: nix flake check",
        ),
      ),
      errors: [{ line: 4, messageIncludes: "(and 1 more job)" }],
    },
  ],
});

describe("nix/flake-nixconfig-cache-not-trusted suggestions", () => {
  it("adds the cache to the installer's own config input and warns against accept-flake-config", () => {
    const [diagnostic] = runRule(rule, {
      files: files(
        workflow([
          CHECKOUT,
          "      - uses: DeterminateSystems/nix-installer-action@v23",
          "        with:",
          "          extra-conf: |",
          "            max-jobs = auto",
          "      - run: nix build",
        ]),
      ),
    });
    expect(diagnostic?.suggestion).toContain(
      `- uses: DeterminateSystems/nix-installer-action@v23\n  with:\n    extra-conf: |\n      extra-substituters = https://demo.cachix.org\n      extra-trusted-public-keys = ${KEY}`,
    );
    expect(diagnostic?.suggestion).toContain("append these lines to the existing `extra-conf`");
    expect(diagnostic?.suggestion).toContain("`cachix/cachix-action@v17` step with `name: demo`");
    expect(diagnostic?.suggestion).toContain("Review the cache operator and public key independently");
    expect(diagnostic?.suggestion).toContain("Prefer explicit settings to `accept-flake-config = true`");
  });

  it("points related locations at the other jobs", () => {
    const wf = nix(
      "name: ci",
      "on: push",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      CHECKOUT,
      INSTALL,
      "      - run: nix build",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      CHECKOUT,
      INSTALL,
      "      - run: nix flake check",
    );
    const [diagnostic] = runRule(rule, { files: files(wf) });
    expect(diagnostic?.related).toEqual([{ path: ".github/workflows/ci.yml", line: 15 }]);
  });

  it("uses a placeholder key when the flake declares none", () => {
    const [diagnostic] = runRule(rule, {
      files: files(workflow([CHECKOUT, INSTALL, "      - run: nix build"]), {
        "flake.nix": flake('    extra-substituters = [ "https://cache.example.org/ci" ];'),
      }),
    });
    expect(diagnostic?.suggestion).toContain("extra-trusted-public-keys = <public key of cache.example.org>");
    expect(diagnostic?.suggestion).not.toContain("cachix-action");
  });
});
