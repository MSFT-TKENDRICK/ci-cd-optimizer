import { expandedJobSteps, defineRule } from "../helpers.js";
import type { ProjectModel } from "../../project.js";
import type { Location, ReportDescriptor } from "../../types.js";
import {
  NIX_INSTALLER_ACTIONS,
  bypassesRegistry,
  floatingFlakeRef,
  floatingNixSource,
  nestedInvocations,
  nixCommandSites,
  nixInvocation,
  nixpkgsSearchPath,
  positionalArgs,
  siteCommands,
  usesGlobalRegistry,
  type FloatingSource,
  type NixCommandSite,
  type NixInvocation,
} from "./shared.js";

const PIN_TARBALL = "https://github.com/NixOS/nixpkgs/archive/<commit>.tar.gz";

/** nix-env options that take values. `-A/--attr` is a flag for nix-env: it makes every selector an attribute path. */
const NIX_ENV_ARITY: Record<string, number> = {
  "-f": 1,
  "--file": 1,
  "-I": 1,
  "--include": 1,
  "-p": 1,
  "--profile": 1,
  "--from-profile": 1,
  "--system-filter": 1,
  "--option": 2,
  "--extra-option": 2,
  "--arg": 2,
  "--argstr": 2,
  "-j": 1,
  "--max-jobs": 1,
  "--cores": 1,
  "--max-silent-time": 1,
  "--timeout": 1,
  "--store": 1,
  "--builders": 1,
  "--log-format": 1,
  "--substituters": 1,
  "--extra-substituters": 1,
};

export interface NixEnvArgs {
  install: boolean;
  attr: boolean;
  /** The last `-f/--file` value. */
  file?: string;
  /** `-E/--from-expression` or `--from-profile`: the selectors are not looked up in a package set. */
  indirect: boolean;
  selectors: string[];
}

/**
 * Parses nix-env arguments. Short-option clusters are expanded as Nix's argument parser does: `-iA` → `-i -A`,
 * `-if x` → `-i -f x`, `-j4` → `-j 4` (letters become flags until the first non-letter, which starts a value).
 */
export function nixEnvArgs(args: string[]): NixEnvArgs {
  const words: string[] = [];
  for (const word of args) {
    if (word.length > 2 && word[0] === "-" && /[A-Za-z]/.test(word[1] ?? "")) {
      for (let index = 1; index < word.length; index += 1) {
        const char = word[index] ?? "";
        if (/[A-Za-z]/.test(char)) words.push(`-${char}`);
        else {
          words.push(word.slice(index));
          break;
        }
      }
    } else words.push(word);
  }
  const parsed: NixEnvArgs = { install: false, attr: false, indirect: false, selectors: [] };
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "--") {
      parsed.selectors.push(...words.slice(index + 1));
      break;
    }
    if (!word.startsWith("-") || word.length === 1) {
      parsed.selectors.push(word);
      continue;
    }
    const assigned = /^(--[\w-]+)=([\s\S]*)$/.exec(word);
    const name = assigned?.[1] ?? word;
    if (name === "-i" || name === "--install") parsed.install = true;
    else if (name === "-A" || name === "--attr") parsed.attr = true;
    else if (name === "-E" || name === "--from-expression" || name === "--from-profile") parsed.indirect = true;
    if (name === "-f" || name === "--file") {
      const value = assigned ? assigned[2] : words[index + 1];
      if (value !== undefined) parsed.file = value;
    }
    if (!assigned) index += NIX_ENV_ARITY[name] ?? 0;
  }
  return parsed;
}

/** Store paths, relative/absolute paths, `result` links and shell expansions: none of them consult channels or the registry. */
function isPathArg(word: string): boolean {
  return /^(?:\/|~\/|\.{1,2}(?:\/|$|#)|path:|result(?:-[\w-]+)?$)/.test(word) || word.includes("$");
}

const FORGE_BRANCH = /^(?:master|main|develop|trunk|unstable|nixos-[\w.-]+|nixpkgs-[\w.-]+|release-[\w.-]+)$/;
const FORGE_REF = /^(?:flake:)?((?:github|gitlab|sourcehut):[^/?#]+\/[^/?#]+)(?:\/([^?#]+))?(?:\?([^#]*))?(#.*)?$/i;

/** A `github:`/`gitlab:`/`sourcehut:` flake reference that follows a branch: no ref (the default branch) or a branch name. */
export function floatingForgeRef(ref: string): FloatingSource | undefined {
  const match = FORGE_REF.exec(ref);
  if (!match?.[1] || ref.includes("$")) return undefined;
  const params = new URLSearchParams(match[3] ?? "");
  if (params.has("rev") || params.has("narHash")) return undefined;
  const branch = match[2] ?? params.get("ref") ?? undefined;
  if (branch === undefined) return { reason: `the default branch of ${match[1]}`, indirect: false };
  if (!FORGE_BRANCH.test(branch)) return undefined;
  return { reason: `the ${branch} branch of ${match[1]}`, indirect: false };
}

/** `github:owner/repo/<commit>#attr` for a forge reference. */
function pinnedForgeRef(ref: string): string {
  const match = FORGE_REF.exec(ref);
  return match?.[1] ? `${match[1]}/<commit>${match[4] ?? ""}` : ref;
}

/** The attribute a flake reference selects (`nixpkgs#jq` → `jq`). */
function fragment(ref: string): string {
  const index = ref.indexOf("#");
  return index >= 0 && index < ref.length - 1 ? ref.slice(index + 1) : "<package>";
}

/** True when the job (or composite action) runs `nix-channel` itself; `nix/channel-in-ci` reports those commands. */
function managesChannels(project: ProjectModel, site: NixCommandSite): boolean {
  return siteCommands(project, site).some(({ command }) => {
    const nix = nixInvocation(command, 0);
    return nix ? nestedInvocations(nix).some((entry) => entry.binary === "nix-channel") : /\bnix-channel\b/.test(command);
  });
}

/** True when the job installs Nix with an action; those installers do not subscribe the user to a channel. */
function installsWithAction(project: ProjectModel, site: NixCommandSite): boolean {
  if (!site.job) return true;
  const { workflow, job } = site.job;
  return expandedJobSteps(project, workflow, job).some(({ step }) => NIX_INSTALLER_ACTIONS.has(step.uses?.action.name ?? ""));
}

function nixEnvReport(project: ProjectModel, site: NixCommandSite, chain: NixInvocation[], depth: number, nix: NixInvocation): ReportDescriptor | undefined {
  const parsed = nixEnvArgs(nix.args);
  if (!parsed.install || parsed.indirect) return undefined;
  const selectors = parsed.selectors.filter((word) => !isPathArg(word));
  if (selectors.length === 0) return undefined;
  const { file } = parsed;
  let source: FloatingSource | undefined;
  let origin: string;
  let related: Location | undefined;
  if (file === undefined) {
    // Without `-f`, nix-env evaluates ~/.nix-defexpr: the user's channels. Installer actions add none, so the command
    // fails there instead of floating; a job that manages channels is left to nix/channel-in-ci.
    if (installsWithAction(project, site) || managesChannels(project, site)) return undefined;
    source = { reason: "whatever revision the runner's channels were last updated to", indirect: true };
    origin = "the channels in `~/.nix-defexpr` (no `-f`)";
  } else if (file === "<nixpkgs>") {
    const found = nixpkgsSearchPath(project, site, chain, depth);
    source = found ? floatingNixSource(found.value) : undefined;
    if (!found || !source || (source.indirect && !usesGlobalRegistry(project, site))) return undefined;
    origin = `\`<nixpkgs>\` (\`nixpkgs=${found.value}\` from ${found.origin})`;
    if (found.path !== site.path || found.line !== nix.line) related = { path: found.path, line: found.line };
  } else {
    source = floatingNixSource(file);
    if (!source || (source.indirect && !usesGlobalRegistry(project, site))) return undefined;
    origin = `\`-f ${file}\``;
  }
  // Without `-f`, attribute paths start with the channel name (`nixpkgs.hello`).
  const attrs = parsed.attr ? selectors.map((selector) => (file === undefined ? selector.split(".").slice(1).join(".") || selector : selector)) : [];
  const install = parsed.attr ? `-iA ${attrs.join(" ")}` : `-i ${selectors.join(" ")}`;
  const installables = parsed.attr ? attrs.map((attr) => `nixpkgs#${attr}`).join(" ") : "nixpkgs#<attr>";
  return {
    path: site.path,
    line: nix.line,
    message: `\`nix-env\` installs \`${selectors.join(" ")}\` from ${origin}, which follows ${source.reason}: the installed version changes without any change to the repository, and nothing records which revision a run used.`,
    suggestion: `Install from a pinned nixpkgs commit:\nnix-env -f ${PIN_TARBALL} ${install}\nor, if this repository's flake has a \`nixpkgs\` input, take it from flake.lock without mutating a profile:\nnix shell --inputs-from . ${installables} --command <cmd>\nor declare the tools in \`devShells.default\` and run \`nix develop --command <cmd>\`.`,
    confidence: source.indirect ? "medium" : "high",
    ...(related ? { related: [related] } : {}),
  };
}

function profileReport(project: ProjectModel, site: NixCommandSite, nix: NixInvocation): ReportDescriptor | undefined {
  if (bypassesRegistry(nix)) return undefined;
  const found: Array<{ ref: string; source: FloatingSource; nixpkgs: boolean }> = [];
  for (const ref of positionalArgs(nix)) {
    if (isPathArg(ref)) continue;
    const nixpkgs = floatingFlakeRef(ref);
    const source = nixpkgs ?? floatingForgeRef(ref);
    if (source) found.push({ ref, source, nixpkgs: nixpkgs !== undefined });
  }
  const registry = found.some(({ source }) => source.indirect) && usesGlobalRegistry(project, site);
  const reported = found.filter(({ source }) => !source.indirect || registry);
  const first = reported[0];
  if (!first) return undefined;
  const nixpkgs = reported.filter((entry) => entry.nixpkgs).map(({ ref }) => `nixpkgs#${fragment(ref)}`);
  const others = reported.filter((entry) => !entry.nixpkgs).map(({ ref }) => pinnedForgeRef(ref));
  const lines: string[] = [];
  if (nixpkgs.length > 0) {
    lines.push(
      `If this repository's flake has a \`nixpkgs\` input, resolve nixpkgs from flake.lock:\nnix ${nix.subcommand} --inputs-from . ${nixpkgs.join(" ")}`,
      `or put the tools on PATH without mutating a profile:\nnix shell --inputs-from . ${nixpkgs.join(" ")} --command <cmd>`,
      `or pin a commit:\nnix ${nix.subcommand} ${nixpkgs.map((ref) => ref.replace(/^nixpkgs#/, "github:NixOS/nixpkgs/<commit>#")).join(" ")}`,
    );
  }
  if (others.length > 0) {
    lines.push(`${lines.length > 0 ? "and pin" : "Pin"} the other flakes to a commit or tag (or add them as flake inputs and use \`--inputs-from .\`):\nnix ${nix.subcommand} ${others.join(" ")}`);
  }
  return {
    path: site.path,
    line: nix.line,
    message: `\`nix ${nix.subcommand}\` installs ${reported.map(({ ref }) => `\`${ref}\``).join(", ")} from ${first.source.reason}; no revision is recorded, so the installed tool changes whenever that branch moves.`,
    suggestion: lines.join("\n"),
    confidence: first.source.indirect ? "medium" : "high",
  };
}

export default defineRule({
  meta: {
    id: "nix/imperative-install",
    ruleset: "nix",
    description: "`nix-env -i` / `nix profile install` installs CI tools from a channel, branch or registry entry that moves.",
    rationale:
      "`nix-env -i` without `-f` evaluates `~/.nix-defexpr`, i.e. the user's channels, whose nixpkgs revision is whatever the image or the last `nix-channel --update` fetched; `-f channel:…` or a branch tarball fetches the branch head again whenever the cached tarball expires. `nix profile install nixpkgs#pkg` resolves the indirect `nixpkgs` reference through the flake registry (the global registry maps it to `github:NixOS/nixpkgs/nixpkgs-unstable`), and `github:owner/repo` without a commit follows that repository's default branch. None of these record the revision in the repository, so the tool version — and its dependency closure — changes with upstream pushes rather than with the commit under test, and an old commit cannot be re-run with the tools it was tested with. The install also mutates a user profile, which outlives the job on self-hosted runners. Taking nixpkgs from the repository's `flake.lock` (`--inputs-from .`), a commit tarball, or a `devShells` entry used through `nix develop` keeps the tools pinned and reviewable.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/nix-env/install",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-profile-install",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-registry",
      "https://nix.dev/tutorials/first-steps/towards-reproducibility-pinning-nixpkgs",
    ],
    impact: "medium",
    example: {
      bad: "- uses: cachix/install-nix-action@v31\n- run: nix profile install nixpkgs#jq\n- run: jq . report.json",
      good: "- uses: cachix/install-nix-action@v31\n- run: nix shell --inputs-from . nixpkgs#jq --command jq . report.json",
    },
  },
  check({ project, report }) {
    for (const site of nixCommandSites(project)) {
      const chain = nestedInvocations(site.nix);
      chain.forEach((nix, depth) => {
        const found =
          nix.binary === "nix-env"
            ? nixEnvReport(project, site, chain, depth, nix)
            : nix.binary === "nix" && /^profile (?:install|add)$/.test(nix.subcommand)
              ? profileReport(project, site, nix)
              : undefined;
        if (found) report({ ...found, key: `${site.path}:${site.line}:${depth}:imperative-install` });
      });
    }
  },
});
