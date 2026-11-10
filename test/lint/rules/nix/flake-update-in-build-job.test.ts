import { describe, expect, it } from "vitest";
import rule from "../../../../src/lint/rules/nix/flake-update-in-build-job.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const workflow = (trigger: string, ...steps: string[]): string =>
  yml(trigger, "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: cachix/install-nix-action@v31", ...steps);
const job = (...steps: string[]): string => workflow("on: [push, pull_request]", ...steps);
const flake = yml(
  "{",
  "  inputs.nixpkgs.url = \"github:NixOS/nixpkgs/nixos-unstable\";",
  "  inputs.local.url = \"path:./nix/local\";",
  "  outputs = { self, nixpkgs, local }: { };",
  "}",
);

ruleTester(rule, {
  valid: [
    {
      name: "scheduled-only update workflow",
      files: workflow("on:\n  schedule:\n    - cron: '0 4 * * 1'\n  workflow_dispatch:", "      - run: nix flake update", "      - run: nix build"),
    },
    {
      name: "job that opens a pull request with the new lock",
      files: job("      - run: nix flake update", "      - uses: peter-evans/create-pull-request@v8"),
    },
    {
      name: "job that pushes the committed lock",
      files: job("      - run: nix flake update --commit-lock-file", "      - run: git push origin HEAD:flake-update"),
    },
    {
      name: "step restricted to the schedule event",
      files: workflow("on:\n  push:\n  schedule:\n    - cron: '0 4 * * 1'", "      - if: github.event_name == 'schedule'", "        run: nix flake update", "      - run: nix build"),
    },
    {
      name: "job restricted to workflow_dispatch",
      files: yml(
        "on: [push, workflow_dispatch]",
        "jobs:",
        "  update:",
        "    if: ${{ github.event_name == 'workflow_dispatch' }}",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: cachix/install-nix-action@v31",
        "      - run: nix flake update",
      ),
    },
    {
      name: "refreshing only a local path: input",
      files: { ".github/workflows/ci.yml": job("      - run: nix flake update local", "      - run: nix build"), "flake.nix": flake },
    },
    { name: "plain nix flake lock only adds missing inputs", files: job("      - run: nix flake lock", "      - run: nix build") },
    { name: "--no-update-lock-file build", files: job("      - run: nix build --no-update-lock-file .#app") },
    { name: "the words appear after -- for the program", files: job("      - run: nix run .#tool -- --recreate-lock-file") },
    { name: "echoing the command is not running it", files: job("      - run: echo 'run nix flake update locally'") },
  ],
  invalid: [
    {
      name: "nix flake update before the build",
      files: job("      - run: nix flake update", "      - run: nix build"),
      errors: [{ line: 7, messageIncludes: "`nix flake update` in job `build` (enabled for push/pull_request) requests an update of the flake's inputs. Mutable references may differ from the committed lock, and no recognized later publication of this update is visible. Confirm that testing updated dependencies is intentional." }],
    },
    {
      name: "update nested in nix develop -c",
      files: job("      - run: nix develop -c nix flake update nixpkgs"),
      errors: [{ line: 7, messageIncludes: "`nix flake update nixpkgs`" }],
    },
    {
      name: "nix flake lock --update-input",
      files: { ".github/workflows/ci.yml": job("      - run: |", "          nix flake lock --update-input nixpkgs", "          nix build"), "flake.nix": flake },
      errors: [{ line: 8, messageIncludes: "`nix flake lock --update-input nixpkgs`" }],
    },
    {
      name: "--recreate-lock-file on a build",
      files: workflow("on: merge_group", "      - run: nix build --recreate-lock-file .#app"),
      errors: [{ line: 7, messageIncludes: "`nix build --recreate-lock-file` in job `build` (enabled for merge_group) requests an update of the flake's inputs. Mutable references may differ from the committed lock, and no recognized later publication of this update is visible. Confirm that testing updated dependencies is intentional." }],
    },
    {
      name: "a local input together with a remote one is still reported",
      files: { ".github/workflows/ci.yml": job("      - run: nix flake update local nixpkgs"), "flake.nix": flake },
      errors: [{ line: 7, messageIncludes: "inputs `local`, `nixpkgs`" }],
    },
    {
      name: "schedule exemption needs an == condition, not !=",
      files: workflow("on:\n  push:\n  schedule:\n    - cron: '0 4 * * 1'", "      - if: github.event_name != 'schedule'", "        run: nix flake update"),
      errors: [{ line: 11, messageIncludes: "`nix flake update`" }],
    },
  ],
});

describe("flake-update-in-build-job suggestion", () => {
  it("offers a scheduled updater limited to the named inputs", () => {
    const [report] = runRule(rule, { files: job("      - run: nix flake update nixpkgs") });
    expect(report?.suggestion).toContain("nix build --no-update-lock-file");
    expect(report?.suggestion).toContain("DeterminateSystems/update-flake-lock@v29");
    expect(report?.suggestion).toContain("inputs: nixpkgs");
    expect(report?.suggestion).toContain("pull-requests: write");
  });
});
