import { usesAction } from "../caching/shared.js";
import { defineRule, expandedJobSteps, stepLine } from "../helpers.js";
import {
  NIX_CACHE_ACTIONS,
  NIX_INSTALLER_ACTIONS,
  confValues,
  effectiveNixConf,
  flakeConfigTrust,
  hasFlag,
  isGitHubHosted,
  nixInvocation,
  nixJobs,
  positionalArgs,
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
    description: "A hosted job builds local Nix targets with no additional binary cache visible before the build.",
    rationale:
      "A cache can avoid rebuilding outputs unavailable from the default substituter on fresh runners. A local target may simply reuse nixpkgs packages already in cache.nixos.org, and external machine configuration may provide another cache, so absence in the inspected repository is not proof of cache misses. Measure repeated uncached builds before adopting authenticated cache persistence; scope write credentials to trusted jobs and account for storage, transfer and exposure costs.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["recommended", "strict"],
    requires: ["complete-inventory"],
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
      const first = model.commands.flatMap((entry) => {
        const build = entry.nix ? buildInvocation(entry.nix) : undefined;
        if (!build) return [];
        const targets = positionalArgs(build);
        const local = targets.length === 0 ? project.nix.files.length > 0 : targets.some((target) => /^(?:\.(?:\/[^$`]*|#.*)?|[^:/#]+\.nix(?:#.*)?)$/.test(target));
        return local ? [{ entry, build }] : [];
      })[0];
      if (!first) continue;
      const { entry, build } = first;
      const all = expandedJobSteps(project, workflow, job);
      const index = all.findIndex((item) => item.step === entry.step && item.owner === entry.owner);
      const expanded = all.slice(0, index);
      if (!expanded.some(({ step }) => NIX_INSTALLER_ACTIONS.has(step.uses?.action.name ?? ""))) continue;
      const cached = expanded.some(
        ({ step }) =>
          usesAction(step, ...NIX_CACHE_ACTIONS) ||
          (usesAction(step, "actions/cache", "actions/cache/restore") && /(^|[\s'"])\/nix\b/m.test(String(step.with.get("path")?.value ?? ""))),
      );
      if (cached) continue;
      const configuration = effectiveNixConf(model, entry, build);
      if (!configuration || confValues(configuration, "substituters", true).length > 0) continue;
      if (model.commands.slice(0, model.commands.indexOf(entry)).some(({ command }) => CACHE_COMMAND.test(command))) continue;
      const flakeSubstituters = project.nix.flakes.some((flake) => flake.info?.nixConfig.has("substituters") || flake.info?.nixConfig.has("extra-substituters"));
      if (flakeSubstituters && flakeConfigTrust(model, (site) => site === entry).length > 0) continue;
      const shown = [build.binary, build.subcommand, ...build.args].filter(Boolean).join(" ");
      report({
        path: workflow.path,
        line: entry.direct ? entry.line : stepLine(entry.owner),
        key: `${job.key}.nix-binary-cache`,
        message: `Job \`${job.id}\` runs \`${shown}\` against local targets with no additional binary cache visible before this build. Outputs absent from default or externally configured caches may be rebuilt on fresh runners.`,
        suggestion: `Measure repeated cache misses first. If worthwhile, configure a reviewed cache before the build; permit writes only from trusted jobs and do not expose credentials to untrusted pull requests. For example, adapt this trusted-job-only setup:\n${CACHE_SNIPPET}\nA restored store is another option; include platform and Nix compatibility in its cache policy. Neither cache configuration nor a version pin guarantees a hit.`,
      });
    }
  },
});
