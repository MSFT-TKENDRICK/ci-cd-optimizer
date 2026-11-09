import type { Location } from "../../types.js";
import { defineRule } from "../helpers.js";
import {
  bypassesRegistry,
  floatingFlakeRef,
  floatingNixSource,
  hasOption,
  nestedInvocations,
  nixCommandSites,
  nixpkgsSearchPath,
  positionalArgs,
  usesGlobalRegistry,
  type FloatingSource,
} from "./shared.js";

const PIN_TARBALL = "https://github.com/NixOS/nixpkgs/archive/<commit>.tar.gz";

export default defineRule({
  meta: {
    id: "nix/nix-shell-dash-p-unpinned",
    ruleset: "nix",
    description: "Ad-hoc `nix-shell -p` / `nix run nixpkgs#…` / `nix shell nixpkgs#…` tools come from a moving nixpkgs branch.",
    rationale:
      "`nix-shell -p pkg` evaluates `with import <nixpkgs> {}; …`, so the packages come from whatever the `nixpkgs` entry of the search path (`-I`, then `NIX_PATH`, then the `nix-path` setting) points at; a `channel:nixos-unstable` or `…/archive/nixos-unstable.tar.gz` entry is downloaded afresh once the tarball cache expires and follows the branch. Likewise `nix run nixpkgs#pkg` and `nix shell nixpkgs#pkg` resolve the indirect `nixpkgs` reference through the flake registry, whose global entry is `github:NixOS/nixpkgs/nixpkgs-unstable`, and nothing records the revision used. Either way the tool version (and every dependency of it) changes with upstream pushes rather than with the commit under test, so a rerun of an old commit can build or lint differently and cache hits are lost whenever the branch moves. Pinning nixpkgs to a commit, or resolving `nixpkgs` from the repository's own `flake.lock` with `--inputs-from .`, makes the tool part of the reviewed inputs.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/nix-shell",
      "https://nix.dev/manual/nix/2.24/command-ref/env-common#env-NIX_PATH",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-registry",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-env-shell",
      "https://nix.dev/tutorials/first-steps/towards-reproducibility-pinning-nixpkgs",
    ],
    impact: "medium",
    example: {
      bad: "- uses: cachix/install-nix-action@v31\n  with:\n    nix_path: nixpkgs=channel:nixos-unstable\n- run: nix-shell -p shellcheck --run 'shellcheck scripts/*.sh'",
      good: "- uses: cachix/install-nix-action@v31\n- run: nix shell --inputs-from . nixpkgs#shellcheck --command shellcheck scripts/*.sh",
    },
  },
  check({ project, report }) {
    for (const site of nixCommandSites(project)) {
      const chain = nestedInvocations(site.nix);
      chain.forEach((nix, depth) => {
        const key = `${site.path}:${site.line}:${depth}:floating-nixpkgs`;
        if (nix.binary === "nix-shell" && hasOption(nix, "-p", "--packages")) {
          const source = nixpkgsSearchPath(project, site, chain, depth);
          const floating = source ? floatingNixSource(source.value) : undefined;
          if (!source || !floating || (floating.indirect && !usesGlobalRegistry(project, site))) return;
          const packages = positionalArgs(nix).filter((word) => !word.startsWith("-"));
          const shown = packages.length > 0 ? packages.join(" ") : "<packages>";
          const sourceLocation: Location = { path: source.path, line: source.line };
          const separate = source.path !== site.path || source.line !== nix.line;
          report({
            path: site.path,
            line: nix.line,
            key,
            message: `\`nix-shell -p ${shown}\` takes \`<nixpkgs>\` from ${source.origin} (\`nixpkgs=${source.value}\`), which follows ${floating.reason}: the packages change whenever that branch moves, not when this repository changes.`,
            suggestion: `Pin nixpkgs to a commit for this command:\nnix-shell -I nixpkgs=${PIN_TARBALL} -p ${shown}${nix.inner !== undefined ? ` --run '${nix.inner}'` : ""}\nor, with a flake, take nixpkgs from flake.lock:\nnix shell --inputs-from . ${packages.length > 0 ? packages.map((name) => `nixpkgs#${name}`).join(" ") : "nixpkgs#<package>"} --command <cmd>\nor declare the tools in \`devShells.default\` and run \`nix develop --command <cmd>\`.`,
            confidence: floating.indirect ? "medium" : "high",
            ...(separate ? { related: [sourceLocation] } : {}),
          });
          return;
        }
        if (nix.binary !== "nix" || (nix.subcommand !== "run" && nix.subcommand !== "shell")) return;
        if (bypassesRegistry(nix)) return;
        const positionals = positionalArgs(nix);
        const installables = nix.subcommand === "run" ? positionals.slice(0, 1) : positionals;
        const floating: Array<{ ref: string; source: FloatingSource }> = [];
        for (const ref of installables) {
          const source = floatingFlakeRef(ref);
          if (source) floating.push({ ref, source });
        }
        const indirectOk = floating.some(({ source }) => source.indirect) ? usesGlobalRegistry(project, site) : true;
        const reported = floating.filter(({ source }) => !source.indirect || indirectOk);
        const first = reported[0];
        if (!first) return;
        const attrs = reported.map(({ ref }) => ref.replace(/^[^#]*#?/, "") || "<package>");
        const refs = reported.map(({ ref }) => `\`${ref}\``).join(", ");
        const wrapped = nix.inner !== undefined ? ` --command ${nix.inner}` : nix.subcommand === "shell" ? " --command <cmd>" : "";
        report({
          path: site.path,
          line: nix.line,
          key,
          message: `\`nix ${nix.subcommand}\` resolves ${refs} through ${first.source.reason}; nothing records the nixpkgs revision, so the tool changes whenever that branch moves.`,
          suggestion: `Resolve nixpkgs from this repository's flake.lock:\nnix ${nix.subcommand} --inputs-from . ${attrs.map((attr) => `nixpkgs#${attr}`).join(" ")}${wrapped}\nor pin a commit explicitly:\nnix ${nix.subcommand} ${attrs.map((attr) => `github:NixOS/nixpkgs/<commit>#${attr}`).join(" ")}${wrapped}`,
          confidence: first.source.indirect ? "medium" : "high",
        });
      });
    }
  },
});
