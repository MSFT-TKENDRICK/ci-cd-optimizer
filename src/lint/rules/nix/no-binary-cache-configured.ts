import { usesAction } from "../caching/shared.js";
import { defineRule, expandedJobSteps, stepLine } from "../helpers.js";
import {
  NIX_CACHE_ACTIONS,
  NIX_INSTALLER_ACTIONS,
  confValues,
  flakeConfigTrust,
  hasFlag,
  isGitHubHosted,
  nixInvocation,
  nixJobs,
  type NixInvocation,
} from "./shared.js";

/** True when the invocation realises derivations (rather than only evaluating or querying them). */
function builds(nix: NixInvocation): boolean {
  if (hasFlag(nix, "--dry-run")) return false;
  if (nix.binary === "nix-build") return true;
  if (nix.binary !== "nix") return false;
  if (nix.subcommand === "build") return true;
  return nix.subcommand === "flake check" && !hasFlag(nix, "--no-build");
}

/** The build invocation itself, or the one wrapped by `nix develop -c` / `nix-shell --run`. */
function buildInvocation(nix: NixInvocation): NixInvocation | undefined {
  if (builds(nix)) return nix;
  const inner = nix.inner === undefined ? undefined : nixInvocation(nix.inner, nix.line);
  return inner && builds(inner) ? inner : undefined;
}

/** Commands that register a binary cache as a substituter or restore store paths from one. */
const CACHE_COMMAND = /\b(?:cachix\s+use|attic\s+use|attic\s+login)\b|\bnix\s+copy\b.*\s--from\b/;

const CACHE_SNIPPET = [
  "- uses: cachix/cachix-action@v17",
  "  with:",
  "    name: <your-cache>",
  "    authToken: ${{ secrets.CACHIX_AUTH_TOKEN }}",
].join("\n");

export default defineRule({
  meta: {
    id: "nix/no-binary-cache-configured",
    ruleset: "nix",
    description: "A job builds this repository's Nix derivations without any binary cache beyond cache.nixos.org.",
    rationale:
      "Before building a derivation Nix asks each substituter for its output path, which is a hash of the derivation's inputs. The default substituter, cache.nixos.org, only contains outputs that Hydra built from nixpkgs, so the derivations this repository defines (its packages, checks, and anything they override) are never found there and are rebuilt from source on every run of an ephemeral GitHub-hosted runner, together with any nixpkgs derivation whose inputs an overlay changed. A binary cache that CI pushes to (Cachix, FlakeHub Cache, Attic, magic-nix-cache) or a restored `/nix` store (cache-nix-action) turns unchanged outputs into downloads.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-substituters",
      "https://nix.dev/guides/recipes/continuous-integration-github-actions",
      "https://github.com/cachix/cachix-action",
      "https://github.com/nix-community/cache-nix-action",
      "https://github.com/DeterminateSystems/flakehub-cache-action",
    ],
    impact: "high",
    example: {
      bad: "steps:\n  - uses: actions/checkout@v5\n  - uses: cachix/install-nix-action@v31\n  - run: nix build .#default",
      good: `steps:\n  - uses: actions/checkout@v5\n  - uses: cachix/install-nix-action@v31\n${CACHE_SNIPPET.replace(/^/gm, "  ")}\n  - run: nix build .#default`,
    },
  },
  check({ project, report }) {
    for (const model of nixJobs(project)) {
      const { workflow, job } = model;
      if (!isGitHubHosted(job)) continue;
      const expanded = expandedJobSteps(project, workflow, job);
      if (!expanded.some(({ step }) => NIX_INSTALLER_ACTIONS.has(step.uses?.action.name ?? ""))) continue;
      const cached = expanded.some(
        ({ step }) =>
          usesAction(step, ...NIX_CACHE_ACTIONS) ||
          (usesAction(step, "actions/cache", "actions/cache/restore") && /(^|[\s'"])\/nix\b/m.test(String(step.with.get("path")?.value ?? ""))),
      );
      if (cached) continue;
      if (confValues(model.conf, "substituters", true).length > 0) continue;
      if (model.commands.some(({ command }) => CACHE_COMMAND.test(command))) continue;
      const flakeSubstituters = project.nix.flakes.some((flake) => flake.info?.nixConfig.has("substituters") || flake.info?.nixConfig.has("extra-substituters"));
      if (flakeSubstituters && flakeConfigTrust(model).length > 0) continue;

      const first = model.commands.flatMap((entry) => {
        const build = entry.nix ? buildInvocation(entry.nix) : undefined;
        return build ? [{ entry, build }] : [];
      })[0];
      if (!first) continue;
      const { entry, build } = first;
      const shown = [build.binary, build.subcommand, ...build.args].filter(Boolean).join(" ");
      report({
        path: workflow.path,
        line: entry.direct ? entry.line : stepLine(entry.owner),
        key: `${job.key}.nix-binary-cache`,
        message: `Job \`${job.id}\` runs \`${shown}\` with no binary cache besides cache.nixos.org, so derivations defined in this repository are rebuilt from source on every run.`,
        suggestion: `Add a cache step right after the Nix installer and let CI push to it, for example:\n${CACHE_SNIPPET}\nAlternatives: \`DeterminateSystems/flakehub-cache-action@v3\` (needs \`permissions: id-token: write\`), \`DeterminateSystems/magic-nix-cache-action@v15\`, or \`nix-community/cache-nix-action@v7\` with \`primary-key: nix-\${{ runner.os }}-\${{ hashFiles('**/*.nix', '**/flake.lock') }}\` (Linux/macOS, Nix >= 2.24).`,
      });
    }
  },
});
