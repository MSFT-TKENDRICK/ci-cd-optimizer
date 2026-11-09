import rule from "../../../../src/lint/rules/nix/nix-shell-dash-p-unpinned.js";
import { ruleTester } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const head = ["on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: cachix/install-nix-action@v31"];
const job = (...steps: string[]): string => yml(...head, ...steps);
const channelPath = ["        with:", "          nix_path: nixpkgs=channel:nixos-unstable"];
const REV = "0123456789abcdef0123456789abcdef01234567";

ruleTester(rule, {
  valid: [
    { name: "nix-shell -p without any nixpkgs search path entry (lookup would fail, not float)", files: job("      - run: nix-shell -p hello --run hello") },
    {
      name: "nix_path pinned to a commit tarball",
      files: job("        with:", `          nix_path: nixpkgs=https://github.com/NixOS/nixpkgs/archive/${REV}.tar.gz`, "      - run: nix-shell -p hello --run hello"),
    },
    {
      name: "-I pin takes precedence over a floating nix_path",
      files: job(...channelPath, `      - run: nix-shell -I nixpkgs=https://github.com/NixOS/nixpkgs/archive/${REV}.tar.gz -p hello --run hello`),
    },
    { name: "nix run --inputs-from . resolves nixpkgs from flake.lock", files: job("      - run: nix run --inputs-from . nixpkgs#hello") },
    { name: "nix run of a nixpkgs commit", files: job(`      - run: nix run github:NixOS/nixpkgs/${REV}#hello`) },
    { name: "nix shell of the repository's own flake", files: job("      - run: nix shell .#tools --command make") },
    {
      name: "self-hosted runner without installer may pin nixpkgs in its system registry",
      files: yml("on: push", "jobs:", "  build:", "    runs-on: [self-hosted, nix]", "    steps:", "      - run: nix run nixpkgs#hello"),
    },
    { name: "words after -- belong to the program", files: job("      - run: nix run .#app -- nixpkgs#hello") },
    {
      name: "job pins nixpkgs in the registry first",
      files: job(`      - run: nix registry pin nixpkgs github:NixOS/nixpkgs/${REV}`, "      - run: nix run nixpkgs#hello"),
    },
    { name: "nixpkgs ref pinned by rev query", files: job(`      - run: nix shell 'github:NixOS/nixpkgs?rev=${REV}#jq' -c jq --version`) },
  ],
  invalid: [
    {
      name: "nix-shell -p with install-nix-action nix_path on a channel",
      files: job(...channelPath, "      - run: nix-shell -p shellcheck --run 'shellcheck x.sh'"),
      errors: [{ line: 9, messageIncludes: "`nix-shell -p shellcheck` takes `<nixpkgs>` from install-nix-action's `nix_path` input" }],
    },
    {
      name: "nix run nixpkgs#hello through the global registry",
      files: job("      - run: nix run nixpkgs#hello"),
      errors: [{ line: 7, messageIncludes: "resolves `nixpkgs#hello` through the flake registry's `nixpkgs` entry" }],
    },
    {
      name: "nix shell with several floating refs reports once",
      files: job("      - run: nix shell github:NixOS/nixpkgs/nixos-24.05#jq nixpkgs#yq -c jq --version"),
      errors: [{ line: 7, messageIncludes: "`github:NixOS/nixpkgs/nixos-24.05#jq`, `nixpkgs#yq`" }],
    },
    {
      name: "Determinate installer maps <nixpkgs> to the registry",
      files: yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: DeterminateSystems/nix-installer-action@v21", "      - run: nix-shell -p hello --run hello"),
      errors: [{ line: 7, messageIncludes: "Determinate installer" }],
    },
    {
      name: "job NIX_PATH on a branch tarball",
      files: yml(
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    env:",
        "      NIX_PATH: nixpkgs=https://github.com/NixOS/nixpkgs/archive/nixos-unstable.tar.gz",
        "    steps:",
        "      - uses: cachix/install-nix-action@v31",
        "      - run: nix-shell -p jq --run 'jq --version'",
      ),
      errors: [{ line: 9, messageIncludes: "the nixos-unstable branch of NixOS/nixpkgs" }],
    },
    {
      name: "nested in nix develop",
      files: job("      - run: nix develop -c nix run nixpkgs#hello"),
      errors: [{ line: 7, messageIncludes: "`nix run` resolves `nixpkgs#hello`" }],
    },
  ],
});
