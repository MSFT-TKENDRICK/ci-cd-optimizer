import type { FlakeInput } from "../../parsers/nix.js";
import { defineRule } from "../helpers.js";
import { describeOriginal, forgeKey, inputLine, lockOf, rootNode } from "./flake.js";

const COMPARABLE_QUERY = /^[^?]*(?:\?(?:(?:ref|rev|dir)=[^&]*)(?:&(?:ref|rev|dir)=[^&]*)*)?$/;

/** The flake.nix reference of an input when it can be compared field-by-field with a lock node's `original`. */
function comparableUrl(input: FlakeInput): string | undefined {
  if (input.url === undefined || input.follows !== undefined || !input.flakeRef || input.url.includes("%")) return undefined;
  if (!COMPARABLE_QUERY.test(input.url) || (input.flakeRef.ref ?? "").includes("/")) return undefined;
  return forgeKey(input.flakeRef);
}

const SUGGESTION =
  "Run `nix flake lock` (it adds or re-locks only the inputs that changed and leaves up-to-date entries alone) and commit `flake.lock`. In CI, pass `--no-update-lock-file` to `nix build`/`nix flake check` so a stale lock fails the run instead of being silently re-resolved.";

export default defineRule({
  meta: {
    id: "nix/flake-lock-missing-input",
    ruleset: "nix",
    description: "flake.lock is out of date with flake.nix: an input has no lock entry, was changed without re-locking, or a node reference dangles.",
    rationale:
      "An added or changed input may require lock regeneration; mutable references can then resolve differently, while immutable references need not. --no-update-lock-file rejects required updates, whereas --no-write-lock-file alone does not freeze resolution. This rule compares only supported literal source forms and reports direct references to missing nodes. A consistent lock constrains sources, not all build behavior.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake#lock-files",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake-lock",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-build#opt-no-update-lock-file",
      "https://github.com/NixOS/nix/blob/2.24.0/src/libflake/flake/lockfile.cc",
    ],
    impact: "medium",
    example: {
      bad: '# flake.nix\ninputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";\ninputs.rust-overlay.url = "github:oxalica/rust-overlay";\n# flake.lock root inputs: { "nixpkgs": "nixpkgs" }',
      good: '# after `nix flake lock`\n# flake.lock root inputs: { "nixpkgs": "nixpkgs", "rust-overlay": "rust-overlay" }',
    },
  },
  check({ project, report }) {
    for (const flake of project.nix.flakes) {
      const lock = lockOf(flake);
      if (!lock) continue;
      const rootLine = lock.nodes.get(lock.root)?.line ?? 1;
      if (flake.nix && flake.info) {
        for (const input of flake.info.inputs.values()) {
          if (input.name === "self") continue;
          if (!Object.hasOwn(lock.rootInputs, input.name)) {
            report({
              path: flake.nix.path,
              line: inputLine(input),
              key: `${flake.dir}:${input.name}:missing`,
              message: `Input \`${input.name}\` is declared in \`${flake.nix.path}\` but \`${lock.path}\` has no entry for it. Locking may resolve it again or fail under a frozen-lock policy; only mutable references can select newer upstream source.`,
              suggestion: SUGGESTION,
              related: [{ path: lock.path, line: rootLine }],
            });
            continue;
          }
          const declared = comparableUrl(input);
          const node = rootNode(lock, input.name);
          const locked = forgeKey(node?.original);
          if (!declared || !node || !locked || declared === locked) continue;
          report({
            path: flake.nix.path,
            line: inputLine(input),
            key: `${flake.dir}:${input.name}:stale`,
            message: `Input \`${input.name}\` is \`${input.url ?? ""}\` in \`${flake.nix.path}\` but \`${lock.path}\` still locks \`${describeOriginal(node.original) ?? node.name}\`, so the entry is ignored and the input is re-resolved on every evaluation.`,
            suggestion: SUGGESTION,
            related: [{ path: lock.path, line: node.line }],
          });
        }
      }
      for (const node of lock.nodes.values()) {
        for (const [name, reference] of Object.entries(node.inputs)) {
          if (typeof reference !== "string" || lock.nodes.has(reference)) continue;
          report({
            path: lock.path,
            line: node.line,
            key: `${flake.dir}:${node.name}.${name}:dangling`,
            message: `Lock node \`${node.name}\` maps input \`${name}\` to node \`${reference}\`, which does not exist in \`${lock.path}\`; Nix rejects this lock file.`,
            suggestion: `Preserve local edits, compare \`${lock.path}\` with a known-good revision, and regenerate a consistent lock using Nix. Review all resulting input changes rather than deleting entries or discarding work automatically.`,
          });
        }
      }
    }
  },
});
