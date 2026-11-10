import rule from "../../../../src/lint/rules/nix/no-binary-cache-configured.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]) => `${lines.join("\n")}\n`;
const jobOn = (runsOn: string, ...steps: string[]) => yml("on: push", "jobs:", "  build:", `    runs-on: ${runsOn}`, "    steps:", ...steps);
const job = (...steps: string[]) => jobOn("ubuntu-24.04", ...steps);
const install = "      - uses: cachix/install-nix-action@v31";

ruleTester(rule, {
  valid: [
    { name: "dev-shell child cache settings are unknown", files: job(install, "      - run: nix develop -c nix-build release.nix") },
    { name: "cachix-action configured", files: job(install, "      - uses: cachix/cachix-action@v17", "        with:", "          name: mycache", "      - run: nix build .#default") },
    { name: "cache-nix-action restores the store", files: job(install, "      - uses: nix-community/cache-nix-action@v7", "        with:", "          primary-key: nix-${{ hashFiles('flake.lock') }}", "      - run: nix flake check") },
    {
      name: "extra-substituters in installer config",
      files: job(install, "        with:", "          extra_nix_config: |", "            extra-substituters = https://mycache.cachix.org", "      - run: nix build"),
    },
    { name: "cachix use command", files: job(install, "      - run: cachix use mycache", "      - run: nix-build") },
    { name: "flake check without building", files: job(install, "      - run: nix flake check --no-build") },
    { name: "dry run only", files: job(install, "      - run: nix build --dry-run .#default") },
    { name: "only a dev shell", files: job(install, "      - run: nix develop -c make test") },
    { name: "self-hosted runner keeps its store", files: jobOn("[self-hosted, nix]", install, "      - run: nix build") },
    { name: "no installer step (preinstalled Nix image)", files: job("      - run: nix build") },
    {
      name: "trusted flake nixConfig adds a substituter",
      files: {
        ".github/workflows/ci.yml": job("      - uses: nixbuild/nix-quick-install-action@v35", "      - run: nix build"),
        "flake.nix": '{\n  nixConfig.extra-substituters = [ "https://mycache.cachix.org" ];\n  outputs = { self }: { };\n}\n',
      },
    },
  ],
  invalid: [
    {
      name: "nix build without a cache",
      files: job("      - uses: actions/checkout@v5", install, "      - run: nix build .#default"),
      errors: [{ line: 8, messageIncludes: "runs `nix build .#default`" }],
    },
    {
      name: "reported once per job at the first build",
      files: job("      - uses: DeterminateSystems/nix-installer-action@v23", "      - run: |", "          nix flake check .", "          nix build .#a"),
      errors: [{ line: 8, messageIncludes: "`nix flake check .`" }],
    },
    {
      name: "untrusted flake nixConfig substituter does not count",
      files: {
        ".github/workflows/ci.yml": job(install, "      - run: nix build"),
        "flake.nix": '{\n  nixConfig.extra-substituters = [ "https://mycache.cachix.org" ];\n  outputs = { self }: { };\n}\n',
      },
      errors: [{ line: 7, messageIncludes: "Job `build` runs `nix build` against local targets with no additional binary cache visible before this build. Outputs absent from default or externally configured caches may be rebuilt on fresh runners." }],
    },
    {
      name: "hosted matrix runners",
      files: yml(
        "on: push",
        "jobs:",
        "  build:",
        "    strategy:",
        "      matrix:",
        "        os: [ubuntu-24.04, macos-15]",
        "    runs-on: ${{ matrix.os }}",
        "    steps:",
        install,
        "      - run: nix build .#app",
      ),
      errors: [{ line: 10, messageIncludes: "Job `build`" }],
    },
  ],
});
