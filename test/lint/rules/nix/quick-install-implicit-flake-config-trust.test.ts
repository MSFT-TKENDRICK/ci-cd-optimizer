import rule from "../../../../src/lint/rules/nix/quick-install-implicit-flake-config-trust.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const job = (on: string, ...steps: string[]) => yml(`on: ${on}`, "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", ...steps);

ruleTester(rule, {
  valid: [
    {
      name: "NIX_CONFIG overrides the appended line",
      files: yml(
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    env:",
        "      NIX_CONFIG: accept-flake-config = false",
        "    steps:",
        "      - uses: nixbuild/nix-quick-install-action@v30",
        "      - run: nix build",
      ),
    },
    {
      name: "releases before v25 do not append accept-flake-config",
      files: job("push", "      - uses: nixbuild/nix-quick-install-action@v24", "      - run: nix build"),
    },
    {
      name: "Nix 2.12 is not configured to accept flake config",
      files: job("push", "      - uses: nixbuild/nix-quick-install-action@v30", "        with:", "          nix_version: 2.12.0", "      - run: nix build"),
    },
    {
      name: "classic nix-build never reads flake nixConfig",
      files: job("push", "      - uses: nixbuild/nix-quick-install-action@v30", "      - run: nix-build release.nix"),
    },
    {
      name: "CLI flag disables it for the only flake command",
      files: job("push", "      - uses: nixbuild/nix-quick-install-action@v30", "      - run: nix build --option accept-flake-config false"),
    },
    {
      name: "untrusted pull_request jobs are left to nix/accept-flake-config-untrusted",
      files: job("pull_request", "      - uses: nixbuild/nix-quick-install-action@v30", "      - run: nix build"),
    },
    {
      name: "other installers do not accept flake config by default",
      files: job("push", "      - uses: cachix/install-nix-action@v31", "      - run: nix build"),
    },
  ],
  invalid: [
    {
      name: "Nix 2.13.6 compares newer than the installer threshold 2.13",
      files: job("push", "      - uses: nixbuild/nix-quick-install-action@v30", "        with:", "          nix_version: 2.13.6", "      - run: nix build"),
      errors: [{ line: 6, messageIncludes: "accept-flake-config = true" }],
      output: null,
    },
    {
      name: "default quick-install with a flake build",
      files: job("push", "      - uses: nixbuild/nix-quick-install-action@v30", "      - run: nix build"),
      errors: [{ line: 6, messageIncludes: "nixbuild/nix-quick-install-action@v30` appends `accept-flake-config = true`" }],
      output: null,
    },
    {
      name: "nix_conf false is overridden; remote flake named",
      files: job(
        "push",
        "      - uses: nixbuild/nix-quick-install-action@v30",
        "        with:",
        "          nix_conf: accept-flake-config = false",
        "      - run: nix run github:owner/tool -- --version",
      ),
      errors: [{ line: 6, messageIncludes: "`nixbuild/nix-quick-install-action@v30` appends `accept-flake-config = true` to nix.conf, and a flake-evaluating command in job `build` has no recognized later override. It can accept eligible `nixConfig` settings without confirmation. This job also references remote flake `github:owner/tool`. The false setting in nix_conf is followed by the action's true setting; last assignment wins." }],
    },
    {
      name: "fork-guarded pull_request job is still reported here",
      files: yml(
        "on: pull_request",
        "jobs:",
        "  build:",
        "    if: github.event.pull_request.head.repo.full_name == github.repository",
        "    runs-on: ubuntu-latest",
        "    env:",
        "      CI: true",
        "    steps:",
        "      - uses: nixbuild/nix-quick-install-action@v35",
        "      - run: nix flake check",
      ),
      errors: [{ line: 9, messageIncludes: "job `build`" }],
    },
    {
      name: "SHA pin with a version comment and a nix develop shell",
      files: yml(
        "on: push",
        "defaults:",
        "  run:",
        "    shell: nix develop --command bash -e {0}",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: nixbuild/nix-quick-install-action@5bb6a3b3abe66fd09bbf250dce8ada94f856a703 # v30",
        "      - run: make",
      ),
      errors: [{ line: 9, messageIncludes: "job `build`" }],
    },
  ],
});
