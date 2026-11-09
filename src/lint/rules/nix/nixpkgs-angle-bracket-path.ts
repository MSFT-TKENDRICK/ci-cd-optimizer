import { searchPaths } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import { inLambdaDefault, lintableNixFiles, validateStringLists } from "./expr.js";

function suggestionFor(name: string): string {
  const [root = name, ...rest] = name.split("/");
  const sub = rest.length > 0 ? `/${rest.join("/")}` : "";
  const usage = sub ? `"\${${root}}${sub}"` : root;
  if (root === "nixpkgs") {
    return [
      `Pin nixpkgs in the repository instead of reading it from NIX_PATH, then use \`${usage}\` where \`<${name}>\` was.`,
      `Flake: \`inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";\` (locked to a commit in flake.lock) and \`nixpkgs.legacyPackages.\${system}\` / \`import nixpkgs { inherit system; }\`.`,
      'Without flakes: `nixpkgs = builtins.fetchTarball { url = "https://github.com/NixOS/nixpkgs/archive/<commit>.tar.gz"; sha256 = "<hash printed by: nix-prefetch-url --unpack URL>"; };`, or manage the pin with npins/niv.',
    ].join(" ");
  }
  return [
    `Declare \`${root}\` as a pinned input instead of reading it from NIX_PATH, then use \`${usage}\` where \`<${name}>\` was.`,
    `Flake: \`inputs.${root}.url = "<flake reference>";\` (locked in flake.lock).`,
    `Without flakes: \`${root} = builtins.fetchTarball { url = "<archive URL of a specific commit>"; sha256 = "<hash printed by: nix-prefetch-url --unpack URL>"; };\`.`,
  ].join(" ");
}

export default defineRule({
  meta: {
    id: "nix/nixpkgs-angle-bracket-path",
    ruleset: "nix",
    description: "Nix expressions should not use `<nixpkgs>`-style lookup paths, which resolve through the machine's NIX_PATH.",
    rationale:
      "A lookup path such as `<nixpkgs>` is resolved at evaluation time against the `NIX_PATH` environment variable / `nix-path` setting of whichever machine runs Nix. The same commit therefore evaluates against whatever channel a developer last ran `nix-channel --update` on, a different nixpkgs on each CI runner image, and a new one after every channel update: results are not reproducible and binary-cache hits depend on the runner. Pure evaluation mode (the default for flakes) refuses lookup paths altogether. Pinning the dependency as a flake input (locked in flake.lock) or as `fetchTarball` with a commit URL and `sha256` makes the evaluated nixpkgs a function of the repository alone.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { ignore: [] as string[] },
    validateOptions: (options) => validateStringLists(options, "ignore"),
    references: [
      "https://nix.dev/manual/nix/stable/language/constructs/lookup-path.html",
      "https://nix.dev/guides/best-practices#search-path",
      "https://nix.dev/manual/nix/stable/command-ref/conf-file.html#conf-pure-eval",
    ],
    impact: "high",
    example: {
      bad: "{ pkgs ? import <nixpkgs> { } }:\npkgs.hello",
      good: '{\n  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";\n  outputs = { nixpkgs, ... }: {\n    packages.x86_64-linux.default = nixpkgs.legacyPackages.x86_64-linux.hello;\n  };\n}',
    },
  },
  check({ project, options, report }) {
    const ignored = new Set(options.ignore);
    for (const file of lintableNixFiles(project)) {
      const seen = new Map<string, number>();
      for (const lookup of searchPaths(file)) {
        const root = lookup.name.split("/")[0] ?? lookup.name;
        // `<nix/fetchurl.nix>` and friends are Nix's own built-in corepkgs, not NIX_PATH entries.
        if (root === "nix" || ignored.has(lookup.name) || ignored.has(root)) continue;
        const count = (seen.get(lookup.name) ?? 0) + 1;
        seen.set(lookup.name, count);
        const isDefault = inLambdaDefault(file.masked, lookup.offset);
        report({
          path: file.path,
          line: lookup.line,
          message: `\`<${lookup.name}>\` is resolved from NIX_PATH on the machine that evaluates this file${
            isDefault ? " (whenever the caller does not pass this argument, e.g. plain `nix-build`/`nix-shell`)" : ""
          }, so the ${root === "nixpkgs" ? "nixpkgs revision" : `\`${root}\` revision`} used depends on that machine's channels rather than on this repository; pure evaluation (flakes) rejects it.`,
          suggestion: suggestionFor(lookup.name),
          confidence: isDefault ? "medium" : "high",
          key: `<${lookup.name}>#${count}`,
        });
      }
    }
  },
});
