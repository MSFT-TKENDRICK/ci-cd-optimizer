import rule from "../../../../src/lint/rules/nix/nix-build-inside-docker.js";
import { describe, expect, it } from "vitest";
import { ruleTester, runRule } from "../../rule-tester.js";

ruleTester(rule, {
  valid: [
    {
      name: "nix build in a non-nixos/nix base image",
      files: { Dockerfile: "FROM ubuntu:24.04\nRUN nix build .#app\n" },
    },
    {
      name: "image whose last path segments only resemble nixos/nix",
      files: { Dockerfile: "FROM mynixos/nix:latest\nRUN nix build .#app\n" },
    },
    {
      name: "installing tools without building",
      files: { Dockerfile: "FROM nixos/nix:2.24.0\nRUN nix-env -iA nixpkgs.jq\nRUN nix-channel --update && nix-collect-garbage -d\n" },
    },
    {
      name: "/nix cache mount seeded from the image",
      files: {
        Dockerfile: "# syntax=docker/dockerfile:1\nFROM nixos/nix:2.24.0 AS builder\nCOPY . /src\nRUN --mount=type=cache,target=/nix,from=nixos/nix:2.24.0,source=/nix nix build /src#app\n",
      },
    },
    {
      name: "nix build only mentioned in an echo",
      files: { Dockerfile: 'FROM nixos/nix\nRUN echo "run nix build .#app to build"\n' },
    },
    {
      name: "non-building subcommands and dry runs",
      files: { Dockerfile: "FROM nixos/nix\nRUN nix flake check --no-build\nRUN nix build --dry-run .#app\nRUN nix-build --help\n" },
    },
    {
      name: "sandbox enabled on the command line in a privileged step",
      files: { Dockerfile: "# syntax=docker/dockerfile:1-labs\nFROM nixos/nix\nRUN --security=insecure nix build --option sandbox true .#app\n" },
    },
    {
      name: "sandbox enabled in nix.conf by an earlier step of a parent stage",
      files: {
        Dockerfile: 'FROM nixos/nix AS base\nRUN echo "sandbox = true" >> /etc/nix/nix.conf\nFROM base\nRUN --security=insecure nix-build -A app\n',
      },
    },
    {
      name: "custom nix.conf copied in",
      files: { Dockerfile: "FROM nixos/nix\nCOPY nix.conf /etc/nix/nix.conf\nRUN nix-build -A app\n" },
    },
    {
      name: "later non-nix stage named differently from the nix stage",
      files: { Dockerfile: "FROM nixos/nix AS builder\nRUN nix-env -iA nixpkgs.hello\nFROM ubuntu:24.04 AS runtime\nRUN nix build .#app\n" },
    },
  ],
  invalid: [
    {
      name: "classic nix-build after copying the source",
      files: { Dockerfile: "FROM nixos/nix\nWORKDIR /src\nCOPY . .\nRUN nix-build -A app\n" },
      errors: [{ path: "Dockerfile", line: 4, messageIncludes: "`nix-build -A app` builds inside `nixos/nix`" }],
    },
    {
      name: "flake build on a continuation line",
      files: {
        Dockerfile:
          'FROM nixos/nix:2.24.0 AS builder\nCOPY . /src\nWORKDIR /src\nRUN mkdir -p /out && \\\n    nix --extra-experimental-features "nix-command flakes" build .#app\n',
      },
      errors: [{ path: "Dockerfile", line: 5, messageIncludes: "builds inside `nixos/nix:2.24.0`" }],
    },
    {
      name: "GHCR copy of the image",
      files: { Dockerfile: "FROM ghcr.io/nixos/nix:2.24.0\nRUN nix build .#app\n" },
      errors: [{ path: "Dockerfile", line: 2, messageIncludes: "`ghcr.io/nixos/nix:2.24.0`" }],
    },
    {
      name: "stage built on a nixos/nix stage",
      files: { Dockerfile: "FROM nixos/nix AS base\nRUN nix-channel --update\nFROM base AS builder\nRUN nix build .#app\n" },
      errors: [{ path: "Dockerfile", line: 4, messageIncludes: "via stage `base`" }],
    },
    {
      name: "image from a global build arg",
      files: { Dockerfile: "ARG NIX_IMAGE=nixos/nix:latest\nFROM ${NIX_IMAGE}\nRUN nix build .#app\n" },
      errors: [{ path: "Dockerfile", line: 3, messageIncludes: "`nixos/nix:latest`" }],
    },
    {
      name: "privileged step that leaves the sandbox off",
      files: { Dockerfile: "# syntax=docker/dockerfile:1-labs\nFROM nixos/nix\nRUN --security=insecure nix build --option sandbox false .#app\n" },
      errors: [{ path: "Dockerfile", line: 3, messageIncludes: "sandbox = false" }],
    },
    {
      name: "build wrapped in nix develop",
      files: { Dockerfile: "FROM nixos/nix\nRUN nix develop -c nix build .#app\n" },
      errors: [{ path: "Dockerfile", line: 2, messageIncludes: "`nix develop -c nix build .#app`" }],
    },
    {
      name: "one report per RUN with two builds",
      files: { Dockerfile: "FROM nixos/nix\nRUN nix build .#a && nix build .#b\nRUN nix-build -A c\n" },
      errors: [
        { path: "Dockerfile", line: 2, messageIncludes: "`nix build .#a`" },
        { path: "Dockerfile", line: 3, messageIncludes: "`nix-build -A c`" },
      ],
    },
  ],
});

describe("nix/nix-build-inside-docker suggestion", () => {
  it("proposes streamLayeredImage and a seeded /nix cache mount with the syntax directive", () => {
    const [diagnostic] = runRule(rule, { files: { Dockerfile: "FROM nixos/nix:2.24.0\nRUN nix build .#app\n" } });
    expect(diagnostic?.suggestion).toContain("pkgs.dockerTools.streamLayeredImage {");
    expect(diagnostic?.suggestion).toContain("nix build .#image && ./result | docker image load");
    expect(diagnostic?.suggestion).toContain("RUN --mount=type=cache,target=/nix,from=nixos/nix:2.24.0,source=/nix nix build .#app");
    expect(diagnostic?.suggestion).toContain("# syntax=docker/dockerfile:1");
    expect(diagnostic?.fix).toBeUndefined();
  });

  it("omits the syntax note when the directive is present", () => {
    const [diagnostic] = runRule(rule, { files: { Dockerfile: "# syntax=docker/dockerfile:1\nFROM nixos/nix\nRUN nix-build\n" } });
    expect(diagnostic?.suggestion).not.toContain("as the first line");
  });
});
