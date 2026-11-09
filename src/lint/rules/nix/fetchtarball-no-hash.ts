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
    description: "`builtins.fetchTarball` must be called with a `sha256` so the fetched source is verified and cached permanently.",
    rationale:
      "`builtins.fetchTarball` downloads and unpacks at evaluation time. Without `sha256` Nix cannot know the content in advance: it treats the cached download as fresh only for `tarball-ttl` (3600 seconds by default), after which evaluation goes back to the network (revalidating with the ETag, or downloading again) and picks up whatever the URL serves now, so a moving URL (a branch archive or channel tarball) silently changes the whole dependency graph between two runs of the same commit, and offline evaluation breaks. Pure evaluation mode (the default for flakes, or `--pure-eval`) refuses the call outright with \"in pure evaluation mode, 'fetchTarball' requires a 'sha256' argument\". With a commit-addressed URL and `sha256` the result is a fixed-output store path that is reused from the store without any network access.",
    kind: "policy",
    defaultSeverity: "error",
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
            ? `fetches a moving URL (\`${url}\`) with no \`sha256\`: its content changes whenever that branch or channel moves`
            : "has no `sha256`, so the download is never verified";
        const targetUrl = url ? pinnedUrl(url) : "https://github.com/<owner>/<repo>/archive/<commit-sha>.tar.gz";
        report({
          path: file.path,
          line: ident.line,
          message: `\`${ident.text} ${finding.shown}\` ${problem}. Nix considers the cached download fresh only for \`tarball-ttl\` (1 hour by default) and then goes back to the network, and pure evaluation (the flake default) rejects the call.`,
          suggestion: [
            `${ident.text} {`,
            `  url = "${targetUrl}";`,
            `  sha256 = "<output of: nix-prefetch-url --unpack ${targetUrl}>";`,
            "}",
            "",
            "Or let a lock file track it: a flake input (`inputs.<name> = { url = \"github:<owner>/<repo>/<branch>\"; flake = false; };`, pinned by flake.lock and updated with `nix flake update`) or npins/niv.",
          ].join("\n"),
          confidence: "high",
          key: `fetchTarball#${count}`,
        });
      }
    }
  },
});
