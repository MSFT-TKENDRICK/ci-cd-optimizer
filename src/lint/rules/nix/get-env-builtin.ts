import { identsNamed } from "../../parsers/nix.js";
import type { NixIdent } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import { callArgument, inheritedFromBuiltins, isShadowed, isValueUse, leadingString, lintableNixFiles, snippet, validateStringLists } from "./expr.js";

const SECRET = /TOKEN|SECRET|PASSW|PASSPHRASE|API_?KEY|PRIVATE|CREDENTIAL/i;

export default defineRule({
  meta: {
    id: "nix/get-env-builtin",
    ruleset: "nix",
    description: "Nix expressions should not read environment variables with `builtins.getEnv` during evaluation.",
    rationale:
      "A demanded `builtins.getEnv` call can make evaluation depend on the calling process's environment. Under pure or restricted evaluation it returns an empty string. This can change derived results, but an unused lazy reference need not be called or affect a derivation. Values embedded in derivation attributes can be serialized into `.drv` files in the normally world-readable Nix store; merely using a value in a condition does not imply the original value is stored. Pass non-secret configuration explicitly and keep secrets outside derivations.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: { allow: [] as string[] },
    validateOptions: (options) => validateStringLists(options, "allow"),
    references: [
      "https://nix.dev/manual/nix/stable/language/builtins.html#builtins-getEnv",
      "https://nix.dev/manual/nix/stable/command-ref/conf-file.html#conf-pure-eval",
      "https://nix.dev/manual/nix/stable/command-ref/conf-file.html#conf-restrict-eval",
    ],
    impact: "medium",
    example: {
      bad: 'let version = builtins.getEnv "APP_VERSION"; in pkgs.callPackage ./app.nix { inherit version; }',
      good: '{ version ? "0.0.0-dev" }:\npkgs.callPackage ./app.nix { inherit version; }\n# nix-build --argstr version "$APP_VERSION"',
    },
  },
  check({ project, options, report }) {
    const allowed = new Set(options.allow);
    for (const file of lintableNixFiles(project)) {
      const calls: NixIdent[] = identsNamed(file, "builtins.getEnv", "__getEnv");
      if (inheritedFromBuiltins(file).has("getEnv") && !isShadowed(file, "getEnv")) calls.push(...identsNamed(file, "getEnv"));
      calls.sort((a, b) => a.offset - b.offset);
      const seen = new Map<string, number>();
      for (const ident of calls) {
        if (isShadowed(file, ident.segments[0] ?? ident.text)) continue;
        if (!isValueUse(file, ident)) continue;
        const arg = callArgument(file, ident);
        const literal = arg ? leadingString(file, arg) : undefined;
        const name = literal && !literal.interpolated && arg?.kind === "string" ? literal.value : undefined;
        if (name !== undefined && allowed.has(name)) continue;
        const shown = name !== undefined ? `"${name}"` : arg ? snippet(file, arg.start, arg.end, 40) : "";
        const label = `${ident.text}${shown ? ` ${shown}` : ""}`;
        const variable = name ?? "VAR";
        const param = /^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) ? variable.toLowerCase() : "value";
        const count = (seen.get(variable) ?? 0) + 1;
        seen.set(variable, count);
        report({
          path: file.path,
          line: ident.line,
          message: `\`${label}\` ${arg ? "reads" : "references a builtin that can read"} the evaluating process's environment: the result can differ between machines and CI runners, and a call returns "" under pure evaluation (flakes) or restricted evaluation.${
            name !== undefined && SECRET.test(name) ? " If this is a secret, embedding its value in derivation attributes can expose it through a world-readable `.drv` file in /nix/store." : ""
          }`,
          suggestion: name !== undefined && SECRET.test(name)
            ? "Do not move a secret into a committed file, a derivation argument or an output in the Nix store. Keep secrets outside evaluation/build outputs and supply them only at the runtime boundary that needs them, with an appropriate secret mechanism."
            : `Pass non-secret values explicitly: declare a function argument (\`{ ${param} ? "<default>" }:\`) and call \`nix-build --argstr ${param} "$${variable}"\`; in a flake, expose it as a configurable output or read non-secret configuration from a committed file. ${
            name !== undefined ? `If the dependency on \`${name}\` is intended, add it to this rule's \`allow\` option.` : ""
          }`.trim(),
          confidence: name !== undefined ? "high" : "medium",
          key: `getEnv:${variable}#${count}`,
        });
      }
    }
  },
});
