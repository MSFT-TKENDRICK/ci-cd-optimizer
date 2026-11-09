import { identsNamed } from "../../parsers/nix.js";
import type { NixArgument, NixFile, NixIdent, NixString } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import {
  attrKeys,
  attrsetOf,
  bindingNamed,
  callArgument,
  enclosingOpen,
  inheritedFromBuiltins,
  isShadowed,
  leadingString,
  lintableNixFiles,
  previousWord,
  snippet,
  stringAt,
  unwrapParens,
} from "./expr.js";

const IMPORTERS = new Set(["import", "scopedImport", "callPackage"]);

interface Finding {
  url?: NixString;
  shown: string;
}

/** A `builtins.fetchurl` argument without `sha256`, or undefined when it is pinned or not analysable. */
function unverified(file: NixFile, arg: NixArgument): Finding | undefined {
  const shown = snippet(file, arg.start, arg.end);
  const literal = leadingString(file, arg);
  if (literal) return { url: literal, shown };
  const open = attrsetOf(file, unwrapParens(file, arg));
  if (open === undefined) return undefined;
  const keys = attrKeys(file, open);
  // `hash` is not accepted by builtins.fetchurl ("unsupported argument"), so such calls already fail loudly.
  if (keys.has("sha256") || keys.has("hash")) return undefined;
  const urlBinding = bindingNamed(file, open, "url");
  const url = urlBinding ? stringAt(file, urlBinding.valueStart) : undefined;
  return { ...(url ? { url } : {}), shown };
}

/** `import (builtins.fetchurl ...)`: the fetched file is evaluated as Nix code. */
function importer(file: NixFile, ident: NixIdent): string | undefined {
  const open = enclosingOpen(file.masked, ident.offset);
  if (open < 0 || file.masked[open] !== "(") return undefined;
  const word = previousWord(file.masked, open);
  return word && IMPORTERS.has(word) ? word : undefined;
}

export default defineRule({
  meta: {
    id: "nix/builtins-fetchurl-unverified",
    ruleset: "nix",
    description: "`builtins.fetchurl` downloads at evaluation time without an integrity check; pin it with `sha256` or use the `pkgs.fetchurl` fixed-output fetcher.",
    rationale:
      "`builtins.fetchurl` is an evaluation-time primop: Nix downloads the file while evaluating, before any build starts, and without a `sha256` it trusts whatever the server returns. The download is only considered fresh for `tarball-ttl` (3600 seconds by default), so a changed or compromised file silently changes the evaluation result, and pure evaluation (the flake default) rejects the call (\"requires a 'sha256' argument\"). When the result is passed to `import`, remote Nix code is executed with no integrity check at all. The nixpkgs `fetchurl` instead creates a fixed-output derivation: the download happens at build time, is verified against `hash`, and the content-addressed output can be substituted from a binary cache.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/stable/language/builtins.html#builtins-fetchurl",
      "https://nixos.org/manual/nixpkgs/stable/#sec-pkgs-fetchers-fetchurl",
      "https://nix.dev/manual/nix/stable/command-ref/conf-file.html#conf-tarball-ttl",
      "https://nix.dev/manual/nix/stable/command-ref/conf-file.html#conf-pure-eval",
    ],
    impact: "high",
    example: {
      bad: 'src = builtins.fetchurl "https://example.org/tool-1.2.tar.gz";',
      good: 'src = pkgs.fetchurl {\n  url = "https://example.org/tool-1.2.tar.gz";\n  hash = "sha256-<from: nix store prefetch-file https://example.org/tool-1.2.tar.gz>";\n};',
    },
  },
  check({ project, report }) {
    for (const file of lintableNixFiles(project)) {
      const calls: NixIdent[] = identsNamed(file, "builtins.fetchurl");
      if (inheritedFromBuiltins(file).has("fetchurl") && !isShadowed(file, "fetchurl")) calls.push(...identsNamed(file, "fetchurl"));
      calls.sort((a, b) => a.offset - b.offset);
      let count = 0;
      for (const ident of calls) {
        const arg = callArgument(file, ident);
        if (!arg) continue;
        const finding = unverified(file, arg);
        if (!finding) continue;
        count += 1;
        const url = finding.url && !finding.url.interpolated ? finding.url.value : "<url>";
        const imported = importer(file, ident);
        const label = `\`${ident.text} ${finding.shown}\``;
        report({
          path: file.path,
          line: ident.line,
          message: imported
            ? `\`${imported}\` of ${label} evaluates Nix code downloaded at evaluation time with no integrity check: whatever the server returns (re-fetched after \`tarball-ttl\`, 1 hour by default) is executed, and pure evaluation (the flake default) rejects the call.`
            : `${label} downloads at evaluation time with no \`sha256\`, so the content is never verified, is re-fetched after \`tarball-ttl\` (1 hour by default), and pure evaluation (the flake default) rejects the call.`,
          suggestion: imported
            ? [
                `${imported} (${ident.text} {`,
                `  url = "${url}"; # an immutable URL (commit- or version-addressed)`,
                `  sha256 = "<output of: nix-prefetch-url ${url}>";`,
                "})",
                "",
                "Better still, vendor the file into the repository or declare it as a flake input with `flake = false`.",
              ].join("\n")
            : [
                "pkgs.fetchurl {",
                `  url = "${url}";`,
                `  hash = "<SRI hash from: nix store prefetch-file ${url}>";`,
                "}",
                "",
                "`pkgs.fetchurl` is a fixed-output derivation: it downloads at build time, verifies the hash and can be substituted from a binary cache. If the value is needed during evaluation, keep `builtins.fetchurl` but add `sha256 = \"<output of: nix-prefetch-url <url>>\";`.",
              ].join("\n"),
          confidence: "high",
          key: `fetchurl#${count}`,
        });
      }
    }
  },
});
