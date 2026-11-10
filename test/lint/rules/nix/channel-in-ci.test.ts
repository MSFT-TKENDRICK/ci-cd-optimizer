import { describe, expect, it } from "vitest";
import rule, { channelArgs, defaultChannelName } from "../../../../src/lint/rules/nix/channel-in-ci.js";
import { ruleTester, runRule } from "../../rule-tester.js";

const yml = (...lines: string[]): string => `${lines.join("\n")}\n`;
const REV = "0123456789abcdef0123456789abcdef01234567";
const job = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: cachix/install-nix-action@v31", ...steps);
const container = (...steps: string[]): string =>
  yml("on: push", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    container: nixos/nix", "    steps:", "      - uses: actions/checkout@v4", ...steps);

describe("channelArgs", () => {
  it("reads the operation and its arguments in any order", () => {
    expect(channelArgs(["--add", "https://nixos.org/channels/nixos-unstable", "nixpkgs"])).toEqual({ mode: "--add", args: ["https://nixos.org/channels/nixos-unstable", "nixpkgs"] });
    expect(channelArgs(["nixpkgs", "--update", "--option", "tarball-ttl", "0"])).toEqual({ mode: "--update", args: ["nixpkgs"] });
    expect(channelArgs(["--list"])).toEqual({ mode: "--list", args: [] });
  });
});

describe("defaultChannelName", () => {
  it("drops -unstable/-stable from the URL's last component, as nix-channel does", () => {
    expect(defaultChannelName("https://nixos.org/channels/nixpkgs-unstable")).toBe("nixpkgs");
    expect(defaultChannelName("https://nixos.org/channels/nixos-unstable/")).toBe("nixos");
    expect(defaultChannelName("https://nixos.org/channels/nixos-24.05")).toBe("nixos-24.05");
  });
});

describe("suggestions", () => {
  it("pins the channel's own repository under the channel's name", () => {
    const [diagnostic] = runRule(rule, {
      files: job("      - run: nix-channel --add https://github.com/nix-community/home-manager/archive/master.tar.gz home-manager"),
    });
    expect(diagnostic?.suggestion).toContain("NIX_PATH: home-manager=https://github.com/nix-community/home-manager/archive/<commit>.tar.gz");
    expect(diagnostic?.suggestion).toContain('inputs.home-manager.url = "github:nix-community/home-manager/<branch-or-commit>";');
    expect(diagnostic?.confidence).toBe("high");
  });
  it("reports a bare --update with medium confidence", () => {
    const [diagnostic] = runRule(rule, { files: container("      - run: nix-channel --update") });
    expect(diagnostic?.confidence).toBe("medium");
    expect(diagnostic?.suggestion).toContain("NIX_PATH: nixpkgs=https://github.com/NixOS/nixpkgs/archive/<commit>.tar.gz");
  });
});

ruleTester(rule, {
  valid: [
    { name: "listing channels changes nothing", files: container("      - run: nix-channel --list") },
    { name: "removing a channel", files: container("      - run: nix-channel --remove nixpkgs") },
    { name: "a released channel snapshot does not move", files: container("      - run: nix-channel --add https://releases.nixos.org/nixos/24.05/nixos-24.05.7376.0123456789ab nixpkgs") },
    {
      name: "a commit tarball, then --update (which refreshes that pinned channel)",
      files: container(`      - run: nix-channel --add https://github.com/NixOS/nixpkgs/archive/${REV}.tar.gz nixpkgs && nix-channel --update`),
    },
    { name: "--update after install-nix-action, which subscribes to no channel", files: job("      - run: nix-channel --update") },
    { name: "a URL from a variable cannot be judged", files: container("      - run: nix-channel --add \"$CHANNEL_URL\" nixpkgs && nix-channel --update") },
    { name: "the command is only printed", files: container('      - run: echo "run nix-channel --update to refresh"') },
    {
      name: "a composite action that no job uses",
      files: {
        ".github/actions/refresh/action.yml": yml("name: refresh", "runs:", "  using: composite", "  steps:", "    - run: nix-channel --update", "      shell: bash"),
      },
    },
  ],
  invalid: [
    {
      name: "subscribing to nixpkgs-unstable",
      files: job("      - run: nix-channel --add https://nixos.org/channels/nixpkgs-unstable nixpkgs"),
      errors: [{ line: 7, messageIncludes: "`nix-channel --add https://nixos.org/channels/nixpkgs-unstable nixpkgs` subscribes the runner to the nixpkgs-unstable channel under the name `nixpkgs`" }],
    },
    {
      name: "the default channel name is derived from the URL",
      files: container("      - run: |", "          sudo nix-channel --add https://channels.nixos.org/nixos-unstable", "          sudo nix-channel --update"),
      errors: [{ line: 9, messageIncludes: "the nixos-unstable channel under the name `nixos`" }],
    },
    {
      name: "a GitHub branch tarball",
      files: job("      - run: nix-channel --add https://github.com/nix-community/home-manager/archive/master.tar.gz home-manager"),
      errors: [{ line: 7, messageIncludes: "the master branch of nix-community/home-manager under the name `home-manager`" }],
    },
    {
      name: "--update of the container image's channels",
      files: container("      - run: nix-channel --update nixpkgs"),
      errors: [{ line: 8, messageIncludes: "`nix-channel --update nixpkgs` refreshes channel `nixpkgs`. If those subscriptions are mutable and used by later evaluation, dependencies can change independently of the repository. Existing pinned subscriptions, empty channel lists or explicit search-path overrides may avoid that effect." }],
    },
    {
      name: "--update on a self-hosted runner without an installer",
      files: yml("on: push", "jobs:", "  build:", "    runs-on: [self-hosted, nixos]", "    steps:", "      - run: sudo nix-channel --update", "      - run: nix-build '<nixpkgs>' -A hello"),
      errors: [{ line: 6, messageIncludes: "every channel the runner is subscribed to" }],
    },
  ],
});
