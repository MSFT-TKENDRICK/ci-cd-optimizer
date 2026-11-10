import rule from "../../../../src/lint/rules/nix/accept-flake-config-untrusted.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]) => `${lines.join("\n")}\n`;
const workflow = (trigger: string, ...steps: string[]) => yml(`on: ${trigger}`, "jobs:", "  check:", "    runs-on: ubuntu-24.04", "    steps:", ...steps);
const headCheckout = ["      - uses: actions/checkout@v5", "        with:", "          ref: ${{ github.event.pull_request.head.sha }}"];
const acceptInstaller = ["      - uses: cachix/install-nix-action@v31", "        with:", "          extra_nix_config: |", "            accept-flake-config = true"];
const rejectInstaller = ["      - uses: cachix/install-nix-action@v31", "        with:", "          extra_nix_config: |", "            accept-flake-config = false"];

ruleTester(rule, {
  valid: [
    { name: "push-only workflow", files: workflow("push", ...acceptInstaller, "      - run: nix flake check") },
    { name: "flake config explicitly rejected", files: workflow("pull_request", ...rejectInstaller, "      - run: nix flake check") },
    {
      name: "pull_request_target building the base branch",
      files: workflow("pull_request_target", "      - uses: actions/checkout@v5", ...acceptInstaller, "      - run: nix flake check"),
    },
    {
      name: "fork pull requests excluded by the job condition",
      files: yml(
        "on: pull_request",
        "jobs:",
        "  check:",
        "    if: github.event.pull_request.head.repo.full_name == github.repository",
        "    runs-on: ubuntu-24.04",
        "    steps:",
        ...acceptInstaller,
        "      - run: nix flake check",
      ),
    },
    {
      name: "job runs only on push",
      files: yml("on: [push, pull_request]", "jobs:", "  check:", "    if: github.event_name == 'push'", "    runs-on: ubuntu-24.04", "    steps:", ...acceptInstaller, "      - run: nix flake check"),
    },
    { name: "CLI flag overrides the installer", files: workflow("pull_request", ...acceptInstaller, "      - run: nix flake check --no-accept-flake-config") },
    { name: "classic nix-build ignores flake config", files: workflow("pull_request", ...acceptInstaller, "      - run: nix-build release.nix") },
    {
      name: "old quick-install Nix does not accept flake config",
      files: workflow("pull_request", "      - uses: nixbuild/nix-quick-install-action@v35", "        with:", "          nix_version: 2.12.0", "      - run: nix build"),
    },
  ],
  invalid: [
    {
      name: "pull_request_target with head checkout and installer setting",
      files: workflow("pull_request_target", ...headCheckout, ...acceptInstaller, "      - run: nix flake check"),
      errors: [{ line: 12, messageIncludes: "`pull_request_target` job that checks out the pull request head `check`" }],
      output: null,
    },
    {
      name: "NIX_CONFIG in job env",
      files: yml(
        "on: pull_request",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-24.04",
        "    env:",
        "      NIX_CONFIG: accept-flake-config = true",
        "    steps:",
        "      - uses: DeterminateSystems/nix-installer-action@v23",
        "      - run: nix build",
      ),
      errors: [{ line: 3, messageIncludes: "`NIX_CONFIG` sets `accept-flake-config = true`" }],
    },
    {
      name: "quick-install implicit trust",
      files: workflow("pull_request", "      - uses: nixbuild/nix-quick-install-action@v35", "      - run: nix build"),
      errors: [{ line: 6, messageIncludes: "appends `accept-flake-config = true`" }],
    },
    {
      name: "command-line flag",
      files: workflow("pull_request", "      - uses: cachix/install-nix-action@v31", "      - run: nix build --accept-flake-config .#default"),
      errors: [{ line: 7, messageIncludes: "the command line sets" }],
    },
    {
      name: "no autofix when the flake needs non-cache settings",
      files: {
        ".github/workflows/ci.yml": workflow("pull_request", ...acceptInstaller, "      - run: nix flake check"),
        "flake.nix": '{\n  nixConfig.allow-import-from-derivation = true;\n  outputs = { self }: { };\n}\n',
      },
      errors: [{ line: 9, messageIncludes: "In `pull_request` workflow `check`, the installer's nix.conf input sets `accept-flake-config = true`. A pull-request-controlled flake can request eligible Nix settings without confirmation; actual effects depend on the installation, trusted-user policy and command overrides." }],
      output: null,
    },
  ],
});
