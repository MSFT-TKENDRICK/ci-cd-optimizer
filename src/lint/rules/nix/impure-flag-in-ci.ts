import type { ProjectModel } from "../../project.js";
import { defineRule } from "../helpers.js";
import { cliConf, envValue, hasOption, isFalsyConf, nestedInvocations, nixCommandSites, positionalArgs, type NixCommandSite, type NixInvocation } from "./shared.js";

/** nixpkgs `config` attributes that the `NIXPKGS_ALLOW_*` environment variables toggle (read via `builtins.getEnv`). */
const ALLOW_VARIABLES: Record<string, string> = {
  NIXPKGS_ALLOW_UNFREE: "allowUnfree = true;",
  NIXPKGS_ALLOW_INSECURE: 'permittedInsecurePackages = [ "<name>-<version>" ];',
  NIXPKGS_ALLOW_BROKEN: "allowBroken = true;",
  NIXPKGS_ALLOW_UNSUPPORTED_SYSTEM: "allowUnsupportedSystem = true;",
};

/** Subcommands that evaluate a devenv flake's dev shell, which devenv documents as requiring `--no-pure-eval`. */
const DEVENV_SUBCOMMANDS = new Set(["develop", "print-dev-env", "flake check", "flake show"]);

function impureFlags(nix: NixInvocation, path: string): string[] {
  const flags: string[] = [];
  if (hasOption(nix, "--impure")) flags.push("--impure");
  if (hasOption(nix, "--no-pure-eval")) flags.push("--no-pure-eval");
  for (const setting of cliConf(nix, path)) {
    if (setting.key === "pure-eval" && isFalsyConf(setting.value)) flags.push(`--option pure-eval ${setting.value}`);
  }
  return flags;
}

function usesDevenv(project: ProjectModel): boolean {
  return project.nix.flakes.some((flake) =>
    [...(flake.info?.inputs.values() ?? [])].some((input) => input.name === "devenv" || /\bcachix\/devenv\b/i.test(input.url ?? "")),
  );
}

/** Known-legitimate impure invocations: probing `builtins.currentSystem`, and nixGL (which must detect the host driver). */
function legitimatelyImpure(nix: NixInvocation): boolean {
  if (nix.subcommand === "eval" && /\bbuiltins\.currentSystem\b/.test(nix.command)) return true;
  return positionalArgs(nix).some((word) => /nixgl/i.test(word));
}

function allowVariables(site: NixCommandSite): string[] {
  return Object.keys(ALLOW_VARIABLES).filter(
    (name) => new RegExp(`\\b${name}\\b`).test(site.nix.command) || envValue(site.workflow, site.job?.job, site.step, name) !== undefined,
  );
}

function withoutImpure(command: string): string {
  return command
    .replace(/\s+--impure(?![\w-])/g, "")
    .replace(/\s+--no-pure-eval(?![\w-])/g, "")
    .replace(/\s+--(?:extra-)?option\s+pure-eval\s+\S+/g, "")
    .replace(/\b(?:NIXPKGS_ALLOW_[A-Z_]+=\S+\s+)+/g, "")
    .trim();
}

export default defineRule({
  meta: {
    id: "nix/impure-flag-in-ci",
    ruleset: "nix",
    description: "`--impure` (or `--no-pure-eval`) on a Nix command in CI lets evaluation depend on unrecorded runner state.",
    rationale:
      "Flake commands evaluate in pure mode: the result is a function of the flake source and the revisions pinned in flake.lock, which is what makes a CI result reproducible and lets a binary cache serve the same outputs everywhere. `--impure` (\"Allow access to mutable paths and repositories\"), `--no-pure-eval` and `--option pure-eval false` switch that off, so the expression may read environment variables through `builtins.getEnv` (the usual reason is `NIXPKGS_ALLOW_UNFREE=1`), resolve `<nixpkgs>` from whatever `NIX_PATH` the runner has, use `builtins.currentSystem`/`builtins.currentTime`, read files outside the flake by absolute path, and fetch URLs without a hash. None of that is recorded in flake.lock, so the same commit can evaluate to different derivations on another runner or a later rerun, and the impurity silently spreads to every output that depends on it. Each of these needs has a pure equivalent: nixpkgs `config` in the flake, systems enumerated in `outputs`, inputs declared and locked.",
    kind: "practice",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-build",
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-pure-eval",
      "https://nix.dev/manual/nix/2.24/language/builtins",
    ],
    impact: "high",
    example: {
      bad: "- run: NIXPKGS_ALLOW_UNFREE=1 nix build --impure .#app",
      good: "# flake.nix: pkgs = import nixpkgs { inherit system; config.allowUnfree = true; };\n- run: nix build .#app",
    },
  },
  check({ project, report }) {
    const devenv = usesDevenv(project);
    for (const site of nixCommandSites(project)) {
      nestedInvocations(site.nix).forEach((nix, depth) => {
        if (nix.binary !== "nix") return;
        const flags = impureFlags(nix, site.path);
        const first = flags[0];
        if (!first || legitimatelyImpure(nix)) return;
        if (devenv && DEVENV_SUBCOMMANDS.has(nix.subcommand)) return;
        const variables = allowVariables(site);
        const pure = withoutImpure(nix.command);
        const shown = nix.subcommand ? `nix ${nix.subcommand} ${first}` : `nix ${first}`;
        const suggestion =
          variables.length > 0
            ? `${variables.join(", ")} is only visible to an impure evaluation; set the nixpkgs config in flake.nix instead:\npkgs = import nixpkgs {\n  inherit system;\n  config = {\n${variables.map((name) => `    ${ALLOW_VARIABLES[name] ?? ""}`).join("\n")}\n  };\n};\nthen run:\n${pure}`
            : `Remove ${flags.map((flag) => `\`${flag}\``).join(" and ")} and make the evaluation pure:\n${pure}\nTake systems from the flake outputs instead of \`builtins.currentSystem\`, nixpkgs and other sources from locked flake inputs instead of \`<nixpkgs>\`/\`NIX_PATH\` or unhashed fetches, and settings from flake inputs (\`--override-input\` for CI-specific values) instead of \`builtins.getEnv\`.`;
        report({
          path: site.path,
          line: nix.line,
          key: `${site.path}:${site.line}:${depth}:impure`,
          message: `\`${shown}\` disables pure evaluation: the result can depend on the runner's environment variables, \`NIX_PATH\`, current system/time and files outside the flake, none of which flake.lock records.`,
          suggestion,
          confidence: "high",
        });
      });
    }
  },
});
