import { usesAction } from "../caching/shared.js";
import { defineRule, stepLine, steps } from "../helpers.js";

/** actions/cache and its drop-in replacements, including restore/save-only variants. */
const FILE_CACHE_ACTIONS = ["actions", "buildjet", "useblacksmith", "runs-on"].flatMap((owner) => [
  `${owner}/cache`,
  `${owner}/cache/restore`,
  `${owner}/cache/save`,
]);

/** `/nix`, `/nix/store[/...]`, `/nix/var[/...]` and `/nix/*` globs. */
const NIX_STORE_PATH = /^\/nix(?:\/(?:store|var|\*{1,2})(?:\/.*)?)?\/?$/;

const SNIPPET = [
  "- uses: nix-community/cache-nix-action@v7",
  "  with:",
  "    primary-key: nix-${{ runner.os }}-${{ hashFiles('**/*.nix', '**/flake.lock') }}",
  "    restore-prefixes-first-match: nix-${{ runner.os }}-",
  "    gc-max-store-size-linux: 1G",
].join("\n");

export default defineRule({
  meta: {
    id: "nix/raw-store-cache",
    ruleset: "nix",
    description: "Do not cache `/nix/store` or `/nix/var/nix` with actions/cache; use a Nix-aware cache.",
    rationale:
      "The Nix store is only consistent together with its SQLite database (`/nix/var/nix/db/db.sqlite`), which records which store paths are valid and their references. actions/cache archives and extracts plain files as the runner user: on a multi-user install `/nix/store` is root-owned and read-only, so extraction can fail with permission errors, and restoring the store without the database (or a stale database over the one the installer just created) leaves paths Nix does not consider valid or registrations for paths that are missing. Nothing is garbage-collected before saving, so every save carries the whole store towards the 10 GB repository cache limit. nix-community/cache-nix-action merges the restored and current databases and can collect garbage before saving; a binary cache (Cachix, Attic, FlakeHub Cache) substitutes individual paths through Nix itself.",
    kind: "practice",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://github.com/nix-community/cache-nix-action#restoring-files",
      "https://nix.dev/manual/nix/2.24/store/types/local-store",
      "https://github.com/cachix/cachix-action",
    ],
    impact: "high",
    example: {
      bad: "- uses: actions/cache@v4\n  with:\n    path: /nix/store\n    key: nix-${{ hashFiles('flake.lock') }}",
      good: SNIPPET,
    },
  },
  check({ project, report }) {
    for (const { workflow, step } of steps([...project.workflows, ...project.actions])) {
      if (!usesAction(step, ...FILE_CACHE_ACTIONS)) continue;
      const path = step.with.get("path");
      if (!path || typeof path.value !== "string") continue;
      const multiline = path.value.includes("\n");
      const hits = path.value.split(/\r?\n/).flatMap((raw, index) => {
        const entry = raw.trim().replace(/^["']|["']$/g, "");
        return entry.startsWith("!") || !NIX_STORE_PATH.test(entry) ? [] : [{ entry, line: multiline ? path.line + 1 + index : path.line }];
      });
      const first = hits[0];
      if (!first) continue;
      const action = step.uses?.action.name ?? "actions/cache";
      report({
        path: workflow.path,
        line: first.line,
        key: `${step.key}.with.path`,
        message: `${action} caches ${hits.map((hit) => `\`${hit.entry}\``).join(", ")} as raw files; restoring the Nix store outside Nix desynchronises it from its database (\`/nix/var/nix/db\`) and can fail on root-owned, read-only store paths.`,
        suggestion: `Replace the step (line ${stepLine(step)}) with a Nix-aware cache that merges the store database and garbage-collects before saving:\n${SNIPPET}\nor push build outputs to a binary cache with \`cachix/cachix-action@v17\` (\`with: { name: <cache>, authToken: \${{ secrets.CACHIX_AUTH_TOKEN }} }\`).`,
      });
    }
  },
});
