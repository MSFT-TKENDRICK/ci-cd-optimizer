import { identsNamed, nixBindings } from "../../parsers/nix.js";
import type { NixArgument, NixFile, NixIdent, NixString } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import { attrKeys, attrsetOf, bindingNamed, callArgument, isShadowed, leadingString, lintableNixFiles, snippet, stringAt, unwrapParens } from "./expr.js";

const COMMIT = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/i;
const GITHUB_ARCHIVE = /^(https:\/\/github\.com\/[^/]+\/[^/]+\/archive\/)([^/]+?)(\.tar\.gz|\.zip)$/;
const CHANNEL = /^https:\/\/(?:channels|nixos)\.nixos\.org\/|^channel:/;

interface Finding {
  url?: NixString;
  shown: string;
}

/** The URL string of a `fetchTarball` call that has no `sha256`, or undefined when it is pinned or not analysable. */
function unpinned(file: NixFile, arg: NixArgument): Finding | undefined {
  const literal = leadingString(file, arg);
  if (literal) return { url: literal, shown: snippet(file, arg.start, arg.end) };
  const open = attrsetOf(file, unwrapParens(file, arg));
  if (open === undefined) return undefined;
  const keys = attrKeys(file, open);
  // `hash` is rejected by Nix ("unsupported argument"), so such calls fail loudly anyway.
  if (keys.has("sha256") || keys.has("hash")) return undefined;
  if (nixBindings(file, open).some((binding) => binding.path[0] === "${}")) return undefined;
  const urlBinding = bindingNamed(file, open, "url");
  const url = urlBinding ? stringAt(file, urlBinding.valueStart) : undefined;
  return { ...(url ? { url } : {}), shown: snippet(file, arg.start, arg.end) };
}

function pinnedUrl(url: string): string {
  if (COMMIT.test(url)) return url;
  const archive = GITHUB_ARCHIVE.exec(url);
  if (archive) return `${archive[1]}<commit-sha>${archive[3]}`;
  if (CHANNEL.test(url)) return "https://github.com/NixOS/nixpkgs/archive/<commit-sha>.tar.gz";
  return url;
}

export default defineRule({
  meta: {
    id: "nix/fetchtarball-no-hash",
    ruleset: "nix",
    description: "`builtins.fetchTarball` should declare the expected unpacked-source `sha256`.",
    rationale:
      "fetchTarball downloads and unpacks during evaluation. Without an expected sha256, mutable URLs may yield different sources when cache entries expire; cache and offline settings affect revalidation. Pure evaluation rejects unpinned calls when evaluated. A declared digest checks unpacked source identity and permits reuse while the matching store object exists, but does not prevent garbage collection, guarantee availability or authenticate an unreviewed digest.",
    kind: "policy",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/stable/language/builtins.html#builtins-fetchTarball",
      "https://nix.dev/manual/nix/stable/command-ref/conf-file.html#conf-tarball-ttl",
      "https://nix.dev/manual/nix/stable/command-ref/conf-file.html#conf-pure-eval",
      "https://nix.dev/guides/best-practices#search-path",
    ],
    impact: "high",
    example: {
      bad: 'import (builtins.fetchTarball "https://github.com/NixOS/nixpkgs/archive/nixos-24.05.tar.gz") { }',
      good: 'import (builtins.fetchTarball {\n  url = "https://github.com/NixOS/nixpkgs/archive/0123456789abcdef0123456789abcdef01234567.tar.gz";\n  sha256 = "1lbvpvp3f2rqq5zgzk3wkjzgq1v6p1lrzc4brb62kg7v4hlpz9vy";\n}) { }',
    },
  },
  check({ project, report }) {
    for (const file of lintableNixFiles(project)) {
      const calls: NixIdent[] = identsNamed(file, "builtins.fetchTarball");
      if (!isShadowed(file, "fetchTarball")) calls.push(...identsNamed(file, "fetchTarball"));
      calls.sort((a, b) => a.offset - b.offset);
      let count = 0;
      for (const ident of calls) {
        const arg = callArgument(file, ident);
        if (!arg) continue;
        const finding = unpinned(file, arg);
        if (!finding) continue;
        count += 1;
        const url = finding.url && !finding.url.interpolated ? finding.url.value : undefined;
        const commit = url ? COMMIT.exec(url)?.[0] : undefined;
        const problem = commit
          ? `pins commit ${commit.slice(0, 12)} but has no \`sha256\`, so the download is never verified`
          : url
            ? `fetches \`${url}\` without an expected \`sha256\`; the URL may be immutable, but the expected unpacked bytes are not declared`
            : "has no `sha256`, so the download is never verified";
        const targetUrl = url ? pinnedUrl(url) : "https://github.com/<owner>/<repo>/archive/<commit-sha>.tar.gz";
        report({
          path: file.path,
          line: ident.line,
          message: `\`${ident.text} ${finding.shown}\` ${problem}. Cache freshness can depend on \`tarball-ttl\` (1 hour by default); pure evaluation rejects this unpinned call if demanded.`,
          suggestion: [
            `${ident.text} {`,
            `  url = "${targetUrl}";`,
            `  sha256 = "<output of: nix-prefetch-url --unpack ${targetUrl}>";`,
            "}",
            "",
            "Review the downloaded source through an independently trusted channel before accepting its digest. Alternatively use a flake input with a committed reviewed flake.lock, or npins/niv.",
          ].join("\n"),
          confidence: "high",
          key: `fetchTarball#${count}`,
        });
      }
    }
  },
});
