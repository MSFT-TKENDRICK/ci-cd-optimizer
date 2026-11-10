import type { FlakeLockNode } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import {
  SAMPLE_DIR,
  STABLE_CHANNEL,
  flakeBindings,
  hasExplicitSource,
  implicitInputs,
  inputLine,
  inputsFullyKnown,
  lockOf,
  rootNode,
  str,
} from "./flake.js";

/** Common registry examples, not authoritative mappings for the user's current registry. */
const REGISTRY: Record<string, string> = {
  agda: "agda/agda",
  agenix: "ryantm/agenix",
  arion: "hercules-ci/arion",
  bundlers: "NixOS/bundlers",
  cachix: "cachix/cachix",
  disko: "nix-community/disko",
  dreampkgs: "nix-community/dreampkgs",
  dwarffs: "edolstra/dwarffs",
  "emacs-overlay": "nix-community/emacs-overlay",
  fenix: "nix-community/fenix",
  "flake-parts": "hercules-ci/flake-parts",
  "flake-utils": "numtide/flake-utils",
  helix: "helix-editor/helix",
  "hercules-ci-agent": "hercules-ci/hercules-ci-agent",
  "hercules-ci-effects": "hercules-ci/hercules-ci-effects",
  "home-manager": "nix-community/home-manager",
  hydra: "NixOS/hydra",
  "mach-nix": "DavHau/mach-nix",
  ngipkgs: "ngi-nix/ngipkgs",
  nickel: "tweag/nickel",
  nix: "NixOS/nix",
  "nix-darwin": "nix-darwin/nix-darwin",
  "nix-serve": "edolstra/nix-serve",
  nixops: "NixOS/nixops",
  "nixos-anywhere": "nix-community/nixos-anywhere",
  "nixos-hardware": "NixOS/nixos-hardware",
  "nixos-homepage": "NixOS/nixos-homepage",
  "nixos-search": "NixOS/nixos-search",
  nixvim: "nix-community/nixvim",
  nur: "nix-community/NUR",
  patchelf: "NixOS/patchelf",
  poetry2nix: "nix-community/poetry2nix",
  "sops-nix": "Mic92/sops-nix",
  systems: "nix-systems/default",
  templates: "NixOS/templates",
};

/**
 * - `url`: `url = "nixpkgs"` / `"flake:nixpkgs/nixos-25.11"`
 * - `attrs`: `type = "indirect"; id = "nixpkgs";`
 * - `untyped`: declared without `url`, `type` or `follows` (e.g. only `flake = false` or nested follows)
 * - `implicit`: an `outputs` argument that is not declared under `inputs`
 */
type Origin = "url" | "attrs" | "untyped" | "implicit";

interface Candidate {
  name: string;
  line: number;
  id: string;
  origin: Origin;
  url?: string;
  ref?: string;
  rev?: string;
}

function replacement(candidate: Candidate, node: FlakeLockNode | undefined): { url: string; known: boolean } {
  const suffix = candidate.rev ?? candidate.ref;
  const tail = suffix ? `/${suffix}` : "";
  const owner = str(node?.locked?.owner);
  const repo = str(node?.locked?.repo);
  if (str(node?.locked?.type) === "github" && owner && repo) return { url: `github:${owner}/${repo}/${candidate.rev ?? str(node?.locked?.rev) ?? candidate.ref ?? "HEAD"}`, known: true };
  // The global registry resolves a bare `nixpkgs` to the nixpkgs-unstable channel.
  if (candidate.id === "nixpkgs") return { url: `github:NixOS/nixpkgs/${suffix ?? "nixpkgs-unstable"}`, known: true };
  const registered = REGISTRY[candidate.id];
  if (registered) return { url: `github:${registered}${tail}`, known: true };
  return { url: `github:<owner>/${candidate.id}${tail}`, known: false };
}

function describe(candidate: Candidate): string {
  const reference = `flake:${candidate.id}${candidate.ref ? `/${candidate.ref}` : ""}${candidate.rev ? `/${candidate.rev}` : ""}`;
  switch (candidate.origin) {
    case "url":
      return `Input \`${candidate.name}\` uses the indirect flake reference \`${candidate.url ?? reference}\``;
    case "attrs":
      return `Input \`${candidate.name}\` is declared with \`type = "indirect"\` (\`${reference}\`)`;
    case "untyped":
      return `Input \`${candidate.name}\` has no \`url\` or \`type\`, so Nix treats it as the indirect flake reference \`${reference}\``;
    case "implicit":
      return `\`outputs\` takes \`${candidate.name}\`, which is not declared under \`inputs\`, so Nix adds it as the indirect flake reference \`${reference}\``;
  }
}

function instruction(candidate: Candidate): string {
  switch (candidate.origin) {
    case "url":
      return "Replace the indirect reference with an explicit source, then re-lock the input:";
    case "attrs":
      return "Replace the `type`/`id`/`ref`/`rev` attributes with an explicit source, then re-lock the input:";
    case "untyped":
      return "Give the input an explicit source next to its other attributes, then re-lock it:";
    case "implicit":
      return "Declare the input with an explicit source under `inputs`, then re-lock it:";
  }
}

function lockedStorePath(node: FlakeLockNode | undefined): string | undefined {
  const path = str(node?.locked?.path);
  return str(node?.locked?.type) === "path" && path?.startsWith("/nix/store/") ? path : undefined;
}

export default defineRule({
  meta: {
    id: "nix/indirect-input",
    ruleset: "nix",
    description: "A flake input is an indirect reference (`nixpkgs`, `flake:nixpkgs`, or no `url` at all) that Nix resolves through the mutable flake registries.",
    rationale:
      "An indirect flake reference names a registry entry instead of a source. Nix resolves it through the flake registries: the global registry (downloaded from the `flake-registry` setting and refreshed when older than `tarball-ttl`), then `/etc/nix/registry.json` (NixOS `nix.registry`), then `~/.config/nix/registry.json`, then `--override-flake`, the later taking precedence. flake.lock records what it resolved to once, but every `nix flake update` or re-lock resolves it again on whichever machine runs it, so a developer's `nix registry pin`, a NixOS `nix.registry` entry or a change to the global registry silently changes the source CI builds. An input with no `url`/`type`, or an `outputs` argument that is not declared under `inputs`, is the same indirect reference.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake#flake-inputs",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake#types",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-registry",
      "https://github.com/NixOS/flake-registry",
    ],
    impact: "medium",
    example: {
      bad: 'inputs.nixpkgs.url = "nixpkgs/nixos-26.05";',
      good: 'inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";',
    },
  },
  check({ project, report }) {
    for (const flake of project.nix.flakes) {
      const file = flake.nix;
      const info = flake.info;
      if (!file || !info || SAMPLE_DIR.test(flake.dir)) continue;
      const bindings = flakeBindings(file);
      // Inputs the parser may have missed (`inputs = import ./inputs.nix;`) would make untyped/implicit findings guesses.
      const known = inputsFullyKnown(file, bindings);
      const candidates: Candidate[] = [];
      for (const input of info.inputs.values()) {
        if (input.name === "self" || input.follows !== undefined) continue;
        const ref = input.flakeRef;
        if (ref?.type === "indirect") {
          const id = ref.id ?? input.attrs.get("id");
          if (!id) continue;
          candidates.push({
            name: input.name,
            line: inputLine(input),
            id,
            origin: input.url !== undefined ? "url" : "attrs",
            ...(input.url !== undefined ? { url: input.url } : {}),
            ...(ref.ref ? { ref: ref.ref } : {}),
            ...(ref.rev ? { rev: ref.rev } : {}),
          });
        } else if (!ref && known && !hasExplicitSource(file, bindings, input.name)) {
          candidates.push({ name: input.name, line: input.line, id: input.name, origin: "untyped" });
        }
      }
      if (known && info.outputs) {
        for (const name of implicitInputs(info)) candidates.push({ name, line: info.outputs.line, id: name, origin: "implicit" });
      }
      const lock = lockOf(flake);
      for (const candidate of candidates) {
        const node = lock ? rootNode(lock, candidate.name) : undefined;
        // For inferred candidates, a lock entry that was not resolved through the registry means flake.nix was misread.
        if ((candidate.origin === "untyped" || candidate.origin === "implicit") && node && str(node.original?.type) !== "indirect") continue;
        const target = replacement(candidate, node);
        const storePath = lockedStorePath(node);
        report({
          path: file.path,
          line: candidate.line,
          key: `${flake.dir}:${candidate.name}`,
          message: `${describe(candidate)}, which Nix resolves through whichever flake registry wins on the machine (~/.config/nix/registry.json, then /etc/nix/registry.json, then the downloaded global registry); every \`nix flake update\` re-resolves it there. Declare the source explicitly, e.g. \`${target.url}\`.`,
          suggestion: [
            `${instruction(candidate)} Review the existing lock and actual registry mapping first; a suggested source is not proof of equivalence.`,
            "",
            "```nix",
            `inputs.${candidate.name}.url = "${target.url}";`,
            "```",
            "",
            "```sh",
            `nix flake lock --update-input ${candidate.name}`,
            "```",
            ...(candidate.id === "nixpkgs" && !candidate.ref && !candidate.rev
              ? ["", `A common nixpkgs mapping follows nixpkgs-unstable, but local registry policy may differ. Choosing \`github:NixOS/nixpkgs/${STABLE_CHANNEL}\` instead changes the dependency policy and needs review.`]
              : []),
            ...(target.known
              ? []
              : ["", `Replace \`<owner>\` with the repository \`${candidate.id}\` should come from (the "Resolved URL" of \`nix flake metadata ${candidate.id}\` shows what your registries map it to).`]),
            ...(storePath
              ? [
                  "",
                  `flake.lock records the store path \`${storePath}\`, which is what a machine-local registry pin (such as NixOS's \`nix.registry\`) produces; another machine can only fetch it if that path is already in its store or substitutable.`,
                ]
              : []),
          ].join("\n"),
        });
      }
    }
  },
});
