import { defineRule } from "../helpers.js";
import { SAMPLE_DIR, flakePath, implicitInputs, isSubflake } from "./flake.js";

export default defineRule({
  meta: {
    id: "nix/missing-flake-lock",
    ruleset: "nix",
    description: "A flake.nix with inputs has no flake.lock committed next to it.",
    rationale:
      "A flake's inputs are URLs such as `github:NixOS/nixpkgs/nixos-24.11` that name a moving branch; `flake.lock` records the exact revision and NAR hash each one resolved to. Without a committed lock every `nix build`/`nix flake check` resolves each input to whatever its branch points at right now and writes a fresh lock into the checkout, so two CI runs of the same commit can evaluate different nixpkgs revisions, nothing is reproducible, and an upstream push between runs changes derivation hashes so outputs cached by earlier runs stop matching. A common cause is `flake.lock` listed in `.gitignore`.",
    kind: "practice",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: ["complete-inventory"],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake#lock-files",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake-lock",
    ],
    impact: "high",
    example: {
      bad: "# flake.nix committed, flake.lock missing (or listed in .gitignore)\n{\n  inputs.nixpkgs.url = \"github:NixOS/nixpkgs/nixos-24.11\";\n  outputs = { self, nixpkgs }: { };\n}",
      good: "# flake.nix and flake.lock both committed\n$ nix flake lock\n$ git add flake.nix flake.lock",
    },
  },
  check({ project, report }) {
    for (const flake of project.nix.flakes) {
      if (!flake.nix || !flake.info || flake.lock) continue;
      const lockPath = flakePath(flake.dir, "flake.lock");
      if (project.files.has(lockPath)) continue;
      if (SAMPLE_DIR.test(flake.dir) || isSubflake(project, flake.dir)) continue;
      const inputs = [...flake.info.inputs.keys()].filter((name) => name !== "self");
      const names = [...inputs, ...implicitInputs(flake.info)];
      if (names.length === 0) continue;
      const shown = names
        .slice(0, 3)
        .map((name) => `\`${name}\``)
        .join(", ");
      const cd = flake.dir ? `cd ${flake.dir} && ` : "";
      report({
        path: flake.nix.path,
        line: 1,
        key: `${flake.dir}:missing-flake-lock`,
        message: `\`${flake.nix.path}\` declares ${names.length === 1 ? "input" : "inputs"} ${shown}${names.length > 3 ? ", ..." : ""} but \`${lockPath}\` is not committed, so every evaluation re-resolves them to the current upstream revisions.`,
        suggestion: `Generate and commit the lock file: \`${cd}nix flake lock && git add flake.lock\`. If \`.gitignore\` lists \`flake.lock\`, remove that entry; to keep CI from silently re-locking afterwards, pass \`--no-update-lock-file\` to \`nix build\`/\`nix flake check\` there.`,
      });
    }
  },
});
