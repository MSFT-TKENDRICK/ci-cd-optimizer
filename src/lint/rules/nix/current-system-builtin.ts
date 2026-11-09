import { identsNamed } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import { inheritStatements, inLambdaDefault, isValueUse, lintableNixFiles } from "./expr.js";

const SUGGESTION = [
  "Make the platform an explicit input instead of reading it from the evaluating machine.",
  'Flake: enumerate the systems you support, e.g. `forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];` and `packages = forAllSystems (system: { default = nixpkgs.legacyPackages.${system}.hello; });`.',
  "Without flakes: take a required `{ system }:` argument and call `nix-build --argstr system x86_64-linux`.",
  "Inside package code, use `stdenv.hostPlatform.system` (or `pkgs.stdenv.hostPlatform`) instead.",
].join(" ");

export default defineRule({
  meta: {
    id: "nix/current-system-builtin",
    ruleset: "nix",
    description: "Nix expressions should not read `builtins.currentSystem`, the platform of the machine running the evaluation.",
    rationale:
      "`builtins.currentSystem` evaluates to the `system`/`eval-system` setting of the machine that runs Nix, so the same expression produces different derivations (and different store paths) on an x86_64-linux CI runner, an aarch64-darwin laptop and a remote builder. It hides which platforms are actually supported, makes cross-platform cache behaviour accidental, and is one of the impure constants that pure evaluation mode (the default for flakes) removes, so the expression fails under `nix build`/`nix flake check`. Passing the system explicitly, or enumerating supported systems in flake outputs, makes the platform part of the expression's interface.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/stable/language/builtins.html#builtins-currentSystem",
      "https://nix.dev/manual/nix/stable/command-ref/conf-file.html#conf-pure-eval",
      "https://nix.dev/manual/nix/stable/command-ref/conf-file.html#conf-eval-system",
    ],
    impact: "medium",
    example: {
      bad: "let pkgs = import nixpkgs { system = builtins.currentSystem; }; in pkgs.hello",
      good: '{ nixpkgs, ... }: {\n  packages = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: {\n    default = nixpkgs.legacyPackages.${system}.hello;\n  });\n}',
    },
  },
  check({ project, report }) {
    for (const file of lintableNixFiles(project)) {
      const hits: { offset: number; line: number; text: string }[] = [];
      for (const ident of identsNamed(file, "builtins.currentSystem", "__currentSystem")) {
        if (isValueUse(file, ident)) hits.push({ offset: ident.offset, line: ident.line, text: ident.text });
      }
      for (const statement of inheritStatements(file)) {
        if (statement.source !== "builtins") continue;
        const name = statement.names.find((entry) => entry.name === "currentSystem");
        if (name) hits.push({ offset: name.offset, line: file.lineOf(name.offset), text: "inherit (builtins) currentSystem" });
      }
      hits.sort((a, b) => a.offset - b.offset);
      let count = 0;
      for (const hit of hits) {
        count += 1;
        const isDefault = inLambdaDefault(file.masked, hit.offset);
        report({
          path: file.path,
          line: hit.line,
          message: `\`${hit.text}\` makes this expression depend on the platform of whichever machine evaluates it${
            isDefault ? " (used as an argument default, so every caller that omits `system` gets the host platform)" : ""
          }; it is unavailable in pure evaluation mode, so \`nix build\`/\`nix flake check\` fail on it.`,
          suggestion: SUGGESTION,
          confidence: isDefault ? "medium" : "high",
          key: `currentSystem#${count}`,
        });
      }
    }
  },
});
