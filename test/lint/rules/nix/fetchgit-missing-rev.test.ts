import rule from "../../../../src/lint/rules/nix/fetchgit-missing-rev.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

ruleTester(rule, {
  valid: [
    {
      name: "rev pinned",
      files: {
        "default.nix": nix(
          "builtins.fetchGit {",
          '  url = "https://github.com/owner/repo.git";',
          '  ref = "main";',
          '  rev = "0123456789abcdef0123456789abcdef01234567";',
          "}",
        ),
      },
    },
    {
      name: "local repository paths are not remote fetches",
      files: { "default.nix": nix("{", "  self = builtins.fetchGit ./.;", '  other = builtins.fetchGit { url = "/srv/git/repo"; };', "}") },
    },
    {
      name: "mentions in comments, strings and attribute names",
      files: {
        "default.nix": nix(
          '# builtins.fetchGit "https://github.com/owner/repo"',
          "{ pkgs }:",
          "{",
          '  doc = "builtins.fetchGit { url = \\"https://x\\"; }";',
          "  fetchGit = null;",
          "}",
        ),
      },
    },
    {
      name: "nixpkgs fetchgit (lower-case) is a fixed-output fetcher",
      files: {
        "pkgs/app/default.nix": nix(
          "{ fetchgit }:",
          'fetchgit { url = "https://example.org/repo.git"; rev = "v1.0"; hash = "sha256-AQ=="; }',
        ),
      },
    },
  ],
  invalid: [
    {
      name: "string URL fetches HEAD",
      files: { "default.nix": nix('let src = builtins.fetchGit "https://github.com/owner/repo.git"; in src') },
      errors: [{ line: 1, messageIncludes: "whatever the remote's `HEAD` points to" }],
    },
    {
      name: "ref only is mutable",
      files: {
        "nix/deps.nix": nix(
          "{",
          "  lib = builtins.fetchGit {",
          '    url = "git@github.com:owner/private.git";',
          '    ref = "release-1.x";',
          "  };",
          "}",
        ),
      },
      errors: [{ line: 2, messageIncludes: "the current tip of `release-1.x`, a mutable ref" }],
    },
    {
      name: "narHash without rev and a bare fetchGit",
      files: {
        "default.nix": nix(
          "[",
          '  (builtins.fetchGit { url = "https://example.org/a.git"; narHash = "sha256-AQ=="; })',
          '  (fetchGit { url = "ssh://git@example.org/b.git"; ref = "refs/heads/dev"; })',
          "]",
        ),
      },
      errors: [
        { line: 2, messageIncludes: "`narHash` only detects the change after the fact" },
        { line: 3, messageIncludes: "`refs/heads/dev`" },
      ],
    },
  ],
});
