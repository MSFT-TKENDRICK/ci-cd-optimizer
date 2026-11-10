import type { Location } from "../../types.js";
import { usesAction } from "../caching/shared.js";
import { commandsOf, defineRule, expandedJobSteps } from "../helpers.js";
import type { NixInvocation } from "./shared.js";
import { nixInvocation } from "./shared.js";

const NIX_DEVELOP_ACTION = "nicknovitski/nix-develop";
const SHELL_ENTRY = /\bnix\s+(?:\S+\s+)*?develop\b|\bnix-shell\b/;
const DEFAULT_INSTALLABLE = new Set([".", ".#", ".#default", "./.", "./.#default"]);

interface DevShell {
  key: string;
  nixShell: boolean;
  /** Installable and flags, with the default flake output normalised to `.`. */
  args: string[];
}

/** Identifies invocations that load the same environment: same tool, same installable/flags, same directory. */
function devShell(nix: NixInvocation, directory: string): DevShell | undefined {
  if (nix.inner === undefined) return undefined;
  const develop = nix.binary === "nix" && nix.subcommand === "develop";
  if (!develop && nix.binary !== "nix-shell") return undefined;
  const args = nix.args.map((arg) => (develop && DEFAULT_INSTALLABLE.has(arg) ? "." : arg));
  if (develop && args.length === 0) args.push(".");
  return { key: `${nix.binary} ${nix.subcommand} ${args.join(" ")} @${directory}`, nixShell: !develop, args };
}

interface Group {
  shell: DevShell;
  /** One site per step, keyed by file and step. */
  sites: Map<string, { location: Location; label: string; viaShell: boolean }>;
}

export default defineRule({
  meta: {
    id: "nix/dev-shell-reinvoked-per-step",
    ruleset: "nix",
    description: "Several steps of one job each start the same `nix develop` / `nix-shell` environment.",
    rationale:
      "Every `nix develop --command` or `nix-shell --run` step starts Nix from scratch: it re-resolves the flake (or re-evaluates `shell.nix`, which has no evaluation cache and typically imports all of nixpkgs), realises the dev-shell environment, spawns a new bash that sources the stdenv setup, and re-runs the shell's `shellHook`, so hooks that install tools, create virtualenvs or print banners execute once per step. Loading the environment once with `nicknovitski/nix-develop` exports the shell's variables to `GITHUB_ENV` and its PATH entries to `GITHUB_PATH`, so later `run:` steps and third-party `uses:` actions see the toolchain without another Nix start. A job-level `defaults.run.shell: nix develop --command bash -e {0}` removes the repetition from the YAML but still starts `nix develop` in every step.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: { minSteps: 2 },
    validateOptions: (options) =>
      Object.entries(options)
        .filter(([key, value]) => key === "minSteps" && (typeof value !== "number" || !Number.isInteger(value) || value < 2))
        .map(([key]) => `${key} must be an integer of at least 2`),
    references: [
      "https://github.com/nicknovitski/nix-develop#usage",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-develop",
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-eval-cache",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#defaultsrunshell",
    ],
    impact: "low",
    example: {
      bad: "- run: nix develop --command cargo fmt --check\n- run: nix develop --command cargo clippy\n- run: nix develop --command cargo test",
      good: "- uses: nicknovitski/nix-develop@v1\n- run: cargo fmt --check\n- run: cargo clippy\n- run: cargo test",
    },
  },
  check({ project, options, report }) {
    const minSteps = options.minSteps;
    for (const workflow of project.workflows) {
      if (SHELL_ENTRY.test(workflow.shell ?? "")) continue;
      for (const job of workflow.jobs) {
        if (SHELL_ENTRY.test(job.shell ?? "")) continue;
        const expanded = expandedJobSteps(project, workflow, job);
        if (expanded.some(({ step }) => usesAction(step, NIX_DEVELOP_ACTION))) continue;
        const groups = new Map<string, Group>();
        const add = (shell: DevShell | undefined, stepKey: string, location: Location, label: string, viaShell: boolean): void => {
          if (!shell) return;
          const group = groups.get(shell.key) ?? { shell, sites: new Map() };
          if (!group.sites.has(stepKey)) group.sites.set(stepKey, { location, label, viaShell });
          groups.set(shell.key, group);
        };
        for (const { step, path } of expanded) {
          if (!step.run) continue;
          const directory = step.workingDirectory ?? job.workingDirectory ?? workflow.workingDirectory ?? "";
          const stepKey = `${path}:${step.key}`;
          const viaShell = step.shell !== undefined ? nixInvocation(step.shell, step.run.line) : undefined;
          if (viaShell) {
            add(devShell(viaShell, directory), stepKey, { path, line: step.run.line }, `shell: ${step.shell ?? ""}`, true);
            continue;
          }
          for (const { command, line } of commandsOf(step)) {
            const nix = nixInvocation(command, line);
            if (nix) add(devShell(nix, directory), stepKey, { path, line }, command, false);
          }
        }
        for (const { shell, sites: bySite } of groups.values()) {
          const sites = [...bySite.values()];
          const first = sites[0];
          if (!first || sites.length < minSteps) continue;
          const tool = shell.nixShell ? "nix-shell" : "nix develop";
          const lines = sites.map((site) => site.location.line).join(", ");
          const custom = shell.args.join(" ") !== ".";
          const action = `- uses: nicknovitski/nix-develop@v1${custom ? `\n  with:\n    arguments: "${shell.args.join(" ")}"` : ""}`;
          const defaults = `defaults:\n  run:\n    shell: nix develop${custom ? ` ${shell.args.join(" ")}` : ""} --command bash -e {0}`;
          report({
            path: first.location.path,
            line: first.location.line,
            key: `${job.key}.dev-shell.${shell.key}`,
            message: `\`${tool}\` is started separately in ${sites.length} steps of job \`${job.id}\` (lines ${lines}); each start re-${shell.nixShell ? "evaluates the Nix expression" : "resolves the flake"}, rebuilds the shell environment and re-runs its shellHook. First: \`${first.label}\`.`,
            suggestion: shell.nixShell
              ? "Run the commands in one step (`nix-shell --run 'cmd1 && cmd2'`), or expose the environment as a flake `devShells.<system>.default` and load it once:\n- uses: nicknovitski/nix-develop@v1\n- run: cmd1\n- run: cmd2"
              : `Load the dev shell once; later steps (including \`uses:\` actions) inherit its PATH and variables:\n${action}\n- run: <command 1>\n- run: <command 2>\nOr, to keep each step inside the shell without repeating it, set on the job (still one \`nix develop\` per step):\n${defaults}`,
            confidence: "high",
            related: sites.slice(1).map((site) => site.location),
          });
        }
      }
    }
  },
});
