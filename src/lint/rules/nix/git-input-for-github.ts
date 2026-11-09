import { fix, replaceOnLine } from "../../fix.js";
import type { FlakeInput } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import { parseGitHubGitUrl, type GitHubGitUrl } from "./flake.js";

/** Query parameters with a `github:` equivalent (or none needed). Others, such as `submodules` and `lfs`, need a git checkout. */
const CONVERTIBLE = new Set(["ref", "rev", "dir", "shallow", "allRefs"]);
const REV = /^[0-9a-f]{40}$/i;

interface Conversion {
  url: string;
  /** False when the replacement drops information or needs a judgement call. */
  exact: boolean;
}

/** The `github:` reference equivalent to a git URL on github.com, or undefined when the URL needs git. */
function convert(git: GitHubGitUrl): Conversion | undefined {
  if ([...git.params.keys()].some((key) => !CONVERTIBLE.has(key))) return undefined;
  const rawRef = git.params.get("ref");
  const rev = git.params.get("rev");
  if (rev !== undefined && !REV.test(rev)) return undefined;
  if (rawRef !== undefined && /^refs\//.test(rawRef) && !/^refs\/(?:heads|tags)\//.test(rawRef)) return undefined;
  // Without a ref both fetchers follow the default branch, so `ref=HEAD` is dropped.
  const stripped = rawRef?.replace(/^refs\/(?:heads|tags)\//, "");
  const ref = stripped === "HEAD" ? undefined : stripped;
  if (ref === "") return undefined;
  const dir = git.params.get("dir");
  const query: string[] = [];
  let path = `github:${git.owner}/${git.repo}`;
  if (rev !== undefined) path += `/${rev}`;
  else if (ref !== undefined && !ref.includes("/")) path += `/${ref}`;
  else if (ref !== undefined) query.push(`ref=${encode(ref)}`);
  if (dir) query.push(`dir=${encode(dir)}`);
  const exact = git.scheme === "https" && rawRef === ref && !ref?.includes("/") && !(ref !== undefined && rev !== undefined);
  return { url: query.length ? `${path}?${query.join("&")}` : path, exact };
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, "/");
}

function declaredUrl(input: FlakeInput): string | undefined {
  return input.urlLine !== undefined ? input.url : undefined;
}

export default defineRule({
  meta: {
    id: "nix/git-input-for-github",
    ruleset: "nix",
    description: "A flake input fetches a github.com repository with `git+https://` or `git+ssh://` instead of the `github:` tarball fetcher.",
    rationale:
      "A `git+…` flake reference makes Nix fetch the repository with git, which transfers the history of the requested ref into Nix's git cache before it can copy the tree into the store. A `github:` reference downloads one tarball of the commit; the Nix manual describes this as often much faster and using less disk space because it does not fetch the history. On ephemeral CI runners, where the git cache starts empty, every job pays for the full fetch.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake#types",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake#flake-references",
      "https://github.com/cachix/install-nix-action#inputs",
    ],
    impact: "low",
    fixable: true,
    example: {
      bad: 'inputs.devshell.url = "git+https://github.com/numtide/devshell?ref=main";',
      good: 'inputs.devshell.url = "github:numtide/devshell/main";',
    },
  },
  check({ project, report }) {
    for (const flake of project.nix.flakes) {
      const file = flake.nix;
      if (!file || !flake.info) continue;
      const source = project.files.get(file.path);
      const usesRevCount = /\brevCount\b/.test(file.masked);
      for (const input of flake.info.inputs.values()) {
        const url = declaredUrl(input);
        if (url === undefined || input.flakeRef?.type !== "git" || input.urlLine === undefined) continue;
        const git = parseGitHubGitUrl(url);
        const conversion = git ? convert(git) : undefined;
        if (!git || !conversion) continue;
        const ssh = git.scheme === "ssh";
        const safe = conversion.exact && !usesRevCount && source !== undefined && source.content === file.content;
        const edit = safe ? replaceOnLine(source, input.urlLine, `"${url}"`, `"${conversion.url}"`) : undefined;
        const caveats = [
          ssh
            ? "Over SSH this input is probably private: `github:` authenticates with a token instead of an SSH key, so give Nix one with `access-tokens = github.com=<token>` (cachix/install-nix-action's `github_access_token` input); the default `GITHUB_TOKEN` only reaches the workflow's own repository."
            : "If the repository is private, Nix needs `access-tokens = github.com=<token>` (cachix/install-nix-action's `github_access_token` input) to download it.",
          usesRevCount
            ? "flake.nix reads `revCount`, which `github:` inputs do not provide; make sure it is not read from this input."
            : undefined,
        ].filter((text): text is string => text !== undefined);
        report({
          path: file.path,
          line: input.urlLine,
          key: `${flake.dir}:${input.name}`,
          message: `Input \`${input.name}\` fetches \`${url}\` with git, transferring the ref's history into Nix's git cache on every fresh runner; \`${conversion.url}\` downloads a single tarball of the commit instead.`,
          suggestion: [
            "Use the `github:` fetcher, then re-lock the input:",
            "",
            "```nix",
            `inputs.${input.name}.url = "${conversion.url}";`,
            "```",
            "",
            "```sh",
            `nix flake lock --update-input ${input.name}`,
            "```",
            "",
            ...caveats,
          ].join("\n"),
          ...(edit ? { fix: fix(`Use \`${conversion.url}\` (then run \`nix flake lock\`)`, edit) } : {}),
        });
      }
    }
  },
});
