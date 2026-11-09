import rule from "../../../../src/lint/rules/nix/git-input-for-github.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

const flake = (...inputs: string[]): string =>
  nix("{", '  description = "service";', "  inputs = {", ...inputs.map((line) => `    ${line}`), "  };", "  outputs = inputs: { };", "}");

const REV = "1a0a5f2ab5d6a0b5bf9ce5b5c5e3cf0b6d2e1a7c";

ruleTester(rule, {
  valid: [
    {
      name: "github: reference already uses the tarball fetcher",
      files: { "flake.nix": flake('devshell.url = "github:numtide/devshell";') },
    },
    {
      name: "trap: submodules=1 needs a git checkout",
      files: { "flake.nix": flake('firmware.url = "git+https://github.com/acme/firmware?ref=main&submodules=1";') },
    },
    {
      name: "trap: lfs=1 needs git-lfs",
      files: { "flake.nix": flake('assets.url = "git+https://github.com/acme/assets?lfs=1";') },
    },
    {
      name: "git+https on GitLab is not a GitHub repository",
      files: { "flake.nix": flake('tools.url = "git+https://gitlab.com/acme/tools?ref=main";') },
    },
    {
      name: "trap: self-hosted git server whose path mentions github.com",
      files: { "flake.nix": flake('mirror.url = "git+https://git.example.com/github.com/acme/tools";') },
    },
    {
      name: "trap: attribute-set git input with submodules",
      files: {
        "flake.nix": flake('vendor = { type = "git"; url = "https://github.com/acme/vendor"; submodules = true; };'),
      },
    },
    {
      name: "trap: pull-request refs only exist in git",
      files: { "flake.nix": flake('patched.url = "git+https://github.com/acme/patched?ref=refs/pull/42/head";') },
    },
    {
      name: "trap: commented-out git input",
      files: {
        "flake.nix": flake('# devshell.url = "git+https://github.com/numtide/devshell";', 'devshell.url = "github:numtide/devshell";'),
      },
    },
  ],
  invalid: [
    {
      name: "git+https with a branch is rewritten to github:",
      files: {
        "flake.nix": flake(
          'nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
          'devshell.url = "git+https://github.com/numtide/devshell?ref=main";',
        ),
      },
      errors: [{ path: "flake.nix", line: 5, messageIncludes: "`github:numtide/devshell/main`" }],
      output: {
        "flake.nix": flake(
          'nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
          'devshell.url = "github:numtide/devshell/main";',
        ),
      },
    },
    {
      name: "pinned rev, .git suffix and shallow=1 collapse to a github: rev",
      files: { "flake.nix": flake(`tools = { url = "git+https://github.com/acme/tools.git?shallow=1&rev=${REV}"; flake = false; };`) },
      errors: [{ line: 4, messageIncludes: "Input `tools`" }],
      output: { "flake.nix": flake(`tools = { url = "github:acme/tools/${REV}"; flake = false; };`) },
    },
    {
      name: "dir parameter is carried over",
      files: { "flake.nix": flake('infra.url = "git+https://github.com/acme/infra?ref=v2&dir=nix";') },
      errors: [{ line: 4, messageIncludes: "`github:acme/infra/v2?dir=nix`" }],
      output: { "flake.nix": flake('infra.url = "github:acme/infra/v2?dir=nix";') },
    },
    {
      name: "git+ssh is reported without a fix: it likely relies on an SSH key",
      files: { "flake.nix": flake('secrets.url = "git+ssh://git@github.com/acme/secrets.git?ref=main";') },
      errors: [{ line: 4, messageIncludes: "`github:acme/secrets/main`" }],
      output: { "flake.nix": flake('secrets.url = "git+ssh://git@github.com/acme/secrets.git?ref=main";') },
    },
    {
      name: "outputs reading revCount suppress the fix",
      files: {
        "flake.nix": nix(
          "{",
          '  inputs.lib.url = "git+https://github.com/acme/lib";',
          "  outputs = { self, lib }: { version = toString lib.revCount; };",
          "}",
        ),
      },
      errors: [{ line: 2, messageIncludes: "`github:acme/lib`" }],
      output: {
        "flake.nix": nix(
          "{",
          '  inputs.lib.url = "git+https://github.com/acme/lib";',
          "  outputs = { self, lib }: { version = toString lib.revCount; };",
          "}",
        ),
      },
    },
    {
      name: "a branch name containing a slash moves to ?ref= and is not auto-fixed",
      files: { "flake.nix": flake('feature.url = "git+https://github.com/acme/app?ref=feature/cache";') },
      errors: [{ line: 4, messageIncludes: "`github:acme/app?ref=feature/cache`" }],
      output: { "flake.nix": flake('feature.url = "git+https://github.com/acme/app?ref=feature/cache";') },
    },
    {
      name: "subflake inputs are checked too",
      files: {
        "flake.nix": flake('devshell.url = "github:numtide/devshell";'),
        "nix/ci/flake.nix": flake('treefmt.url = "git+https://github.com/numtide/treefmt-nix";'),
      },
      errors: [{ path: "nix/ci/flake.nix", line: 4, messageIncludes: "`github:numtide/treefmt-nix`" }],
    },
  ],
});
