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
      "builtins.currentSystem reads the evaluator's system/eval-system setting, not necessarily a remote builder's platform. If the value influences a derivation, different settings can select different outputs. Pure evaluation removes this constant, so a demanded reference fails; unused lazy expressions need not fail. Passing a system explicitly documents platform selection, but does not make different target platforms equivalent or prove reproducibility.",
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
          }; it is unavailable in pure evaluation mode, so evaluating this reference without an override fails. An unused lazy reference need not be evaluated.`,
          suggestion: SUGGESTION,
          confidence: isDefault ? "medium" : "high",
          key: `currentSystem#${count}`,
        });
      }
    }
  },
});
