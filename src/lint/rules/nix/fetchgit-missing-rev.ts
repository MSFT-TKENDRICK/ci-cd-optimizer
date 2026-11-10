import { identsNamed, nixBindings } from "../../parsers/nix.js";
import type { NixArgument, NixFile, NixIdent, NixString } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import { attrKeys, attrsetOf, bindingNamed, callArgument, inheritedFromBuiltins, isShadowed, leadingString, lintableNixFiles, snippet, stringAt, unwrapParens } from "./expr.js";

const REMOTE = /^(?:(?:git\+)?(?:https?|ssh|git):\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)/;

/** The URL text when the string names a remote repository (an interpolated URL is judged by its literal prefix). */
function remoteUrl(string: NixString | undefined): string | undefined {
  if (!string) return undefined;
  const prefix = string.interpolated ? string.value.slice(0, string.value.indexOf("${")) : string.value;
  return REMOTE.test(prefix) ? string.value : undefined;
}

interface Finding {
  url: string;
  ref?: string;
  shown: string;
}

function unlocked(file: NixFile, arg: NixArgument): Finding | undefined {
  const shown = snippet(file, arg.start, arg.end);
  const literal = leadingString(file, arg);
  if (literal) {
    const url = remoteUrl(literal);
    return url ? { url, shown } : undefined;
  }
  const open = attrsetOf(file, unwrapParens(file, arg));
  if (open === undefined) return undefined;
  const keys = attrKeys(file, open);
  if (keys.has("rev") || keys.has("narHash")) return undefined;
  if (nixBindings(file, open).some((binding) => binding.path[0] === "${}")) return undefined;
  const urlBinding = bindingNamed(file, open, "url");
  const url = urlBinding ? remoteUrl(stringAt(file, urlBinding.valueStart)) : undefined;
  if (!url) return undefined;
  const refBinding = bindingNamed(file, open, "ref");
  const ref = refBinding ? stringAt(file, refBinding.valueStart) : undefined;
  return { url, ...(ref && !ref.interpolated ? { ref: ref.value } : {}), shown };
}

export default defineRule({
  meta: {
    id: "nix/fetchgit-missing-rev",
    ruleset: "nix",
    description: "`builtins.fetchGit` of a remote repository should declare a revision or supported content-hash pin.",
    rationale:
      "fetchGit resolves a remote ref during evaluation. Without a revision or supported content-hash pin, a mutable branch or tag can select different source over time. Pure evaluation rejects unlocked inputs if evaluated. A full revision identifies a Git object, but does not guarantee local cache presence, remote availability, identical fetcher metadata across options or deterministic downstream builds.",
    kind: "policy",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/stable/language/builtins.html#builtins-fetchGit",
      "https://nix.dev/manual/nix/stable/command-ref/conf-file.html#conf-tarball-ttl",
      "https://nix.dev/manual/nix/stable/command-ref/conf-file.html#conf-pure-eval",
    ],
    impact: "high",
    example: {
      bad: 'src = builtins.fetchGit { url = "https://github.com/example/lib.git"; ref = "main"; };',
      good: 'src = builtins.fetchGit {\n  url = "https://github.com/example/lib.git";\n  ref = "main";\n  rev = "0123456789abcdef0123456789abcdef01234567";\n};',
    },
  },
  check({ project, report }) {
    for (const file of lintableNixFiles(project)) {
      const calls: NixIdent[] = identsNamed(file, "builtins.fetchGit");
      if (!isShadowed(file, "fetchGit") && inheritedFromBuiltins(file).has("fetchGit")) calls.push(...identsNamed(file, "fetchGit"));
      calls.sort((a, b) => a.offset - b.offset);
      let count = 0;
      for (const ident of calls) {
        if (ident.segments[0] === "builtins" && isShadowed(file, "builtins")) continue;
        const arg = callArgument(file, ident);
        if (!arg) continue;
        const finding = unlocked(file, arg);
        if (!finding) continue;
        count += 1;
        const target = finding.ref
          ? `the current tip of \`${finding.ref}\`, a mutable ref`
          : "whatever the remote's `HEAD` points to right now";
        const branch = finding.ref ?? "<branch>";
        const url = finding.url.includes("${") ? "<url>" : finding.url;
        report({
          path: file.path,
          line: ident.line,
          message: `\`${ident.text} ${finding.shown}\` declares neither \`rev\` nor \`narHash\`, so it selects ${target}. The source can change when that reference moves; cache freshness also depends on \`tarball-ttl\` (1 hour by default). Pure evaluation rejects this unlocked call if demanded; no downstream build difference or cache miss is established.`,
          suggestion: [
            `${ident.text} {`,
            `  url = "${finding.url}";`,
            `  ref = "${branch}";`,
            `  rev = "<40-character commit from: git ls-remote ${url} ${branch.startsWith("refs/") ? branch : `refs/heads/${branch}`}>";`,
            "}",
            "",
            "Add `allRefs = true;` if the commit is not reachable from `ref`. Alternatively declare a flake input (`inputs.<name> = { url = \"git+https://...\"; flake = false; };`) so flake.lock records the revision.",
          ].join("\n"),
          confidence: "medium",
          key: `fetchGit#${count}`,
        });
      }
    }
  },
});
