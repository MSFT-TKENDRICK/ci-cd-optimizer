import { identsNamed, nixBindings } from "../../parsers/nix.js";
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
  if (nixBindings(file, open).some((binding) => binding.path[0] === "${}")) return undefined;
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
      "When demanded, an unpinned builtins.fetchurl call lacks a declared expected content digest. Download/cache behavior depends on Nix settings and availability, and pure evaluation rejects an unpinned demanded fetch. Importing the result may evaluate remote Nix code. A reviewed digest constrains bytes, not source trust or whole-build reproducibility. pkgs.fetchurl is a build-time fixed-output fetcher; substituting it into evaluation-time code can introduce IFD, so it is not a universally equivalent replacement.",
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
      if (isShadowed(file, "builtins")) continue;
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
            ? `\`${imported}\` of ${label} can evaluate downloaded Nix code without a declared expected content hash. If demanded in pure evaluation (the flake default), this unpinned call is rejected.`
            : `${label} has no declared \`sha256\` for verifying the expected bytes. Cache freshness can depend on \`tarball-ttl\` (1 hour by default); pure evaluation rejects the unpinned call if it is demanded.`,
          suggestion: imported
            ? [
                `${imported} (${ident.text} {`,
                `  url = "${url}"; # an immutable URL (commit- or version-addressed)`,
                `  sha256 = "<output of: nix-prefetch-url ${url}>";`,
                "})",
                "",
                "Independently verify the source before accepting a fetched digest. Alternatively vendor reviewed code or declare a reviewed, locked flake input with `flake = false`.",
              ].join("\n")
            : [
                "pkgs.fetchurl {",
                `  url = "${url}";`,
                `  hash = "<SRI hash from: nix store prefetch-file ${url}>";`,
                "}",
                "",
                "`pkgs.fetchurl` is build-time: only use it where that preserves evaluation behavior. Otherwise keep `builtins.fetchurl` and add a sha256. Independently verify the source before accepting any fetched digest; prefetching alone does not establish trust.",
              ].join("\n"),
          confidence: "high",
          key: `fetchurl#${count}`,
        });
      }
    }
  },
});
