import { describe, expect, it } from "vitest";
import rule, { floatingForgeRef, nixEnvArgs } from "../../../../src/lint/rules/nix/imperative-install.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const REV = "0123456789abcdef0123456789abcdef01234567";
const head = (installer = "      - uses: cachix/install-nix-action@v31"): string[] => ["on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", installer];
const job = (...steps: string[]): string => yml(...head(), ...steps);
const container = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    container: nixos/nix", "    steps:", "      - uses: actions/checkout@v4", ...steps);

describe("nixEnvArgs", () => {
  it("expands short-option clusters like Nix's argument parser", () => {
    expect(nixEnvArgs(["-iA", "nixpkgs.hello"])).toMatchObject({ install: true, attr: true, selectors: ["nixpkgs.hello"] });
    expect(nixEnvArgs(["-if", "https://example.org/x.tar.gz", "hello"])).toMatchObject({ install: true, file: "https://example.org/x.tar.gz", selectors: ["hello"] });
    expect(nixEnvArgs(["-j4", "-i", "hello"])).toMatchObject({ install: true, selectors: ["hello"] });
  });
  it("skips option values and reads --opt=value", () => {
    expect(nixEnvArgs(["--file=.", "--install", "--attr", "tools", "-I", "nixpkgs=x"])).toMatchObject({ install: true, attr: true, file: ".", selectors: ["tools"] });
    expect(nixEnvArgs(["-p", "/tmp/p", "-q"])).toMatchObject({ install: false, selectors: [] });
    expect(nixEnvArgs(["-i", "-E", "f: f.hello"])).toMatchObject({ install: true, indirect: true });
  });
});

describe("floatingForgeRef", () => {
  it("flags default-branch and branch refs only", () => {
    expect(floatingForgeRef("github:numtide/treefmt#x")?.reason).toBe("the default branch of github:numtide/treefmt");
    expect(floatingForgeRef("github:cachix/devenv/main")?.reason).toBe("the main branch of github:cachix/devenv");
    expect(floatingForgeRef("github:cachix/devenv/v1.3.1")).toBeUndefined();
    expect(floatingForgeRef(`github:cachix/devenv/${REV}`)).toBeUndefined();
    expect(floatingForgeRef(`github:cachix/devenv?rev=${REV}`)).toBeUndefined();
    expect(floatingForgeRef(".#tools")).toBeUndefined();
  });
});

describe("suggestions", () => {
  it("rewrites nixpkgs installables to flake.lock and commit pins", () => {
    const [diagnostic] = runRule(rule, { files: job("      - run: nix profile install nixpkgs#jq github:numtide/treefmt#default") });
    expect(diagnostic?.suggestion).toContain("nix profile install --inputs-from . nixpkgs#jq");
    expect(diagnostic?.suggestion).toContain("nix profile install github:NixOS/nixpkgs/<commit>#jq");
    expect(diagnostic?.suggestion).toContain("nix profile install github:numtide/treefmt/<commit>#default");
  });
  it("drops the channel prefix from nix-env attribute paths", () => {
    const [diagnostic] = runRule(rule, { files: container("      - run: nix-env -iA nixpkgs.hello nixpkgs.jq") });
    expect(diagnostic?.suggestion).toContain("nix-env -f https://github.com/NixOS/nixpkgs/archive/<commit>.tar.gz -iA hello jq");
    expect(diagnostic?.suggestion).toContain("nix shell --inputs-from . nixpkgs#hello nixpkgs#jq --command <cmd>");
  });
});

ruleTester(rule, {
  valid: [
    { name: "nix-env from the repository's own expression", files: job("      - run: nix-env -f . -iA tools") },
    { name: "nix-env of a store path", files: job("      - run: nix-env -i /nix/store/abc-hello-2.12") },
    { name: "nix-env from a nixpkgs commit tarball", files: job(`      - run: nix-env -f https://github.com/NixOS/nixpkgs/archive/${REV}.tar.gz -iA hello`) },
    { name: "nix-env without -f under install-nix-action (no channels exist, the command fails rather than floats)", files: job("      - run: nix-env -iA nixpkgs.hello") },
    {
      name: "job manages channels itself (reported by nix/channel-in-ci)",
      files: container("      - run: nix-channel --add https://nixos.org/channels/nixos-24.05 nixpkgs && nix-channel --update", "      - run: nix-env -iA nixpkgs.hello"),
    },
    { name: "nix-env query is not an install", files: container("      - run: nix-env -qaP hello") },
    { name: "-I is not mistaken for -i", files: container("      - run: nix-env -I nixpkgs=channel:nixos-unstable -q") },
    { name: "nix profile install --inputs-from . uses flake.lock", files: job("      - run: nix profile install --inputs-from . nixpkgs#jq") },
    { name: "nix profile install of the repository's flake", files: job("      - run: nix profile install .#ci-tools") },
    { name: "nix profile install of a pinned nixpkgs commit", files: job(`      - run: nix profile install github:NixOS/nixpkgs/${REV}#jq`) },
    { name: "nix profile install of a tagged release", files: job("      - run: nix profile install github:cachix/devenv/v1.3.1") },
    {
      name: "self-hosted runner without installer may pin nixpkgs in its registry",
      files: yml("on: push", "jobs:", "  build:", "    runs-on: [self-hosted, nix]", "    steps:", "      - run: nix profile install nixpkgs#jq"),
    },
  ],
  invalid: [
    {
      name: "nix-env -iA without -f in a nixos/nix container uses its channels",
      files: container("      - run: nix-env -iA nixpkgs.hello"),
      errors: [{ line: 8, messageIncludes: "`nix-env` installs `nixpkgs.hello` from the channels in `~/.nix-defexpr` (no `-f`)" }],
    },
    {
      name: "nix-env -f channel:",
      files: job("      - run: nix-env -f channel:nixos-unstable -iA hello"),
      errors: [{ line: 7, messageIncludes: "from `-f channel:nixos-unstable`, which follows the nixos-unstable channel" }],
    },
    {
      name: "nix-env -if with a branch tarball",
      files: job("      - run: nix-env -if https://github.com/NixOS/nixpkgs/archive/nixos-24.05.tar.gz hello"),
      errors: [{ line: 7, messageIncludes: "the nixos-24.05 branch of NixOS/nixpkgs" }],
    },
    {
      name: "nix-env -f '<nixpkgs>' with a floating nix_path",
      files: job("        with:", "          nix_path: nixpkgs=channel:nixos-unstable", "      - run: nix-env -f '<nixpkgs>' -iA jq"),
      errors: [{ line: 9, messageIncludes: "install-nix-action's `nix_path` input" }],
    },
    {
      name: "nix profile install nixpkgs#jq on a GitHub-hosted runner",
      files: job("      - run: nix profile install nixpkgs#jq"),
      errors: [{ line: 7, messageIncludes: "`nix profile install` installs `nixpkgs#jq` from the flake registry's `nixpkgs` entry" }],
    },
    {
      name: "nix profile add of a nixpkgs branch",
      files: job("      - run: nix profile add github:NixOS/nixpkgs/nixos-unstable#jq"),
      errors: [{ line: 7, messageIncludes: "the nixos-unstable branch of nixpkgs" }],
    },
    {
      name: "nix profile install of another flake's default branch",
      files: job("      - run: |", "          nix profile install github:numtide/treefmt", "          treefmt --ci"),
      errors: [{ line: 8, messageIncludes: "`github:numtide/treefmt` from the default branch of github:numtide/treefmt" }],
    },
  ],
});
