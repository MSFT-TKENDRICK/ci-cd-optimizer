import rule from "../../../../src/lint/rules/nix/get-env-builtin.js";
import { ruleTester } from "../../rule-tester.js";

const nix = (...lines: string[]): string => `${lines.join("\n")}\n`;

ruleTester(rule, {
  valid: [
    {
      name: "explicit argument",
      files: { "default.nix": nix('{ version ? "0.0.0-dev" }:', "{ inherit version; }") },
    },
    {
      name: "mentions in comments and strings",
      files: {
        "default.nix": nix("# builtins.getEnv \"HOME\" is impure", "{ pkgs }:", 'pkgs.writeText "x" "use builtins.getEnv sparingly"'),
      },
    },
    {
      name: "attribute named getEnv and a local function named getEnv",
      files: {
        "default.nix": nix(
          "let",
          "  getEnv = name: { HOME = \"/home/ci\"; }.${name};",
          "in {",
          "  home = getEnv \"HOME\";",
          "  lib.getEnv = getEnv;",
          "}",
        ),
      },
    },
    {
      name: "allowed variable",
      files: { "default.nix": nix('let home = builtins.getEnv "HOME"; in home') },
      options: { allow: ["HOME"] },
    },
    {
      name: "getEnv inherited from another set",
      files: { "default.nix": nix("{ env }:", "let inherit (env) getEnv; in getEnv \"PATH\"") },
    },
  ],
  invalid: [
    {
      name: "version from environment",
      files: { "default.nix": nix("let", '  version = builtins.getEnv "APP_VERSION";', "in { inherit version; }") },
      errors: [{ line: 2, messageIncludes: '`builtins.getEnv "APP_VERSION"` reads the evaluating process\'s environment' }],
    },
    {
      name: "secret is called out",
      files: { "nix/deploy.nix": nix("{ pkgs }:", "pkgs.writeText \"cfg\" (builtins.getEnv \"GITHUB_TOKEN\")") },
      errors: [{ line: 2, messageIncludes: "world-readable `.drv`" }],
    },
    {
      name: "inherit (builtins) getEnv, __getEnv and a computed name",
      files: {
        "default.nix": nix(
          "let",
          "  inherit (builtins) getEnv;",
          '  a = getEnv "HOME";',
          "  b = __getEnv (\"X\" + \"Y\");",
          "in [ a b ]",
        ),
      },
      errors: [
        { line: 3, messageIncludes: '`getEnv "HOME"`' },
        { line: 4, messageIncludes: '`__getEnv ("X" + "Y")`' },
      ],
    },
  ],
});
