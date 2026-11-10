import { defineRule } from "../helpers.js";
import type { ProjectModel } from "../../project.js";
import type { ReportDescriptor } from "../../types.js";
import {
  NIX_INSTALLER_ACTIONS,
  floatingNixSource,
  nestedInvocations,
  nixCommandSites,
  nixInvocation,
  siteCommands,
  type NixCommandSite,
  type NixInvocation,
} from "./shared.js";

type ChannelMode = "--add" | "--remove" | "--list" | "--update" | "--list-generations" | "--rollback";

const MODES = new Set<string>(["--add", "--remove", "--list", "--update", "--list-generations", "--rollback"]);

/** Common options nix-channel accepts before or after its operation, with the number of values they take. */
const CHANNEL_ARITY: Record<string, number> = {
  "--option": 2,
  "--extra-option": 2,
  "-I": 1,
  "--include": 1,
  "-j": 1,
  "--max-jobs": 1,
  "--cores": 1,
  "--log-format": 1,
  "--store": 1,
};

export interface ChannelArgs {
  /** The last operation flag, as nix-channel keeps the last one it sees. */
  mode?: ChannelMode;
  args: string[];
}

/** Parses nix-channel's command line: one operation flag and its positional arguments, in any order. */
export function channelArgs(words: string[]): ChannelArgs {
  let mode: ChannelMode | undefined;
  const args: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (MODES.has(word)) mode = word as ChannelMode;
    else if (word.startsWith("-") && word.length > 1) index += word.includes("=") ? 0 : (CHANNEL_ARITY[word] ?? 0);
    else args.push(word);
  }
  return { ...(mode ? { mode } : {}), args };
}

/** The channel name `nix-channel --add <url>` uses when none is given: the URL's last component without `-stable`/`-unstable`. */
export function defaultChannelName(url: string): string {
  const base = url.replace(/\/+$/, "").split("/").pop() ?? url;
  return base.replace(/-unstable$/, "").replace(/-stable$/, "");
}

const GITHUB_ARCHIVE = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:archive|tarball)\//;

/** A commit tarball of the repository a channel URL follows (nixos.org channels are built from NixOS/nixpkgs). */
function pinnedTarball(url: string): string {
  const repo = GITHUB_ARCHIVE.exec(url)?.[1] ?? "NixOS/nixpkgs";
  return `https://github.com/${repo}/archive/<commit>.tar.gz`;
}

function suggestion(name: string, tarball: string): string {
  return [
    "Do not subscribe the runner to a channel; pin the expression where it is used. For classic commands, set the search path at job level:",
    "env:",
    `  NIX_PATH: ${name}=${tarball}`,
    `or pass \`-I ${name}=${tarball}\` to nix-build/nix-shell (and \`-f ${tarball}\` to nix-env, which reads channels rather than NIX_PATH).`,
    `With flakes, declare the input instead and commit flake.lock:`,
    `inputs.${/^[A-Za-z_][\w'-]*$/.test(name) ? name : `"${name}"`}.url = "github:${GITHUB_ARCHIVE.exec(tarball)?.[1] ?? "NixOS/nixpkgs"}/<branch-or-commit>";`,
  ].join("\n");
}

/** True when an installer action sets Nix up for the job; those installers subscribe to no channel, so `--update` alone is a no-op. */
function installsWithAction(project: ProjectModel, site: NixCommandSite): boolean {
  if (!site.job) return true;
  const position = site.job.entries.findIndex((entry) => entry.step === site.step);
  return site.job.entries.slice(0, Math.max(0, position)).some(({ step, owner }) =>
    !step.if && !owner.if && NIX_INSTALLER_ACTIONS.has(step.uses?.action.name ?? ""),
  );
}

/** True when the job (or composite action) adds a channel itself, so `--update` refreshes a subscription reported at its `--add`. */
function addsChannel(project: ProjectModel, site: NixCommandSite): boolean {
  return siteCommands(project, site).some(({ command }) => {
    const nix = nixInvocation(command, 0);
    return (nix ? nestedInvocations(nix) : []).some((entry) => entry.binary === "nix-channel" && channelArgs(entry.args).mode === "--add");
  });
}

function addReport(site: NixCommandSite, nix: NixInvocation, args: string[]): ReportDescriptor | undefined {
  const [url, given] = args;
  if (url === undefined) return undefined;
  const source = floatingNixSource(url);
  if (!source) return undefined;
  const name = given ?? defaultChannelName(url);
  if (name.includes("$")) return undefined;
  return {
    path: site.path,
    line: nix.line,
    message: `\`nix-channel --add ${url}${given ? ` ${given}` : ""}\` subscribes the runner to ${source.reason} under the name \`${name}\`. A later update can change that channel's revision; only expressions actually resolving through it are affected. Other logging or pinning may record the resolved revision.`,
    suggestion: suggestion(name, pinnedTarball(url)),
    confidence: source.indirect ? "medium" : "high",
  };
}

function updateReport(project: ProjectModel, site: NixCommandSite, nix: NixInvocation, args: string[]): ReportDescriptor | undefined {
  if (installsWithAction(project, site) || addsChannel(project, site)) return undefined;
  const which = args.length > 0 ? `channel${args.length > 1 ? "s" : ""} ${args.map((name) => `\`${name}\``).join(", ")}` : "every channel the runner is subscribed to";
  const name = args.length === 1 && args[0] && !args[0].includes("$") ? args[0] : "nixpkgs";
  return {
    path: site.path,
    line: nix.line,
    message: `\`nix-channel --update${args.length > 0 ? ` ${args.join(" ")}` : ""}\` refreshes ${which}. If those subscriptions are mutable and used by later evaluation, dependencies can change independently of the repository. Existing pinned subscriptions, empty channel lists or explicit search-path overrides may avoid that effect.`,
    suggestion: suggestion(name, pinnedTarball("")),
    confidence: "medium",
  };
}

export default defineRule({
  meta: {
    id: "nix/channel-in-ci",
    ruleset: "nix",
    description: "`nix-channel --add/--update` in CI makes evaluation depend on a channel that moves.",
    rationale:
      "Channel subscriptions live outside the Nix expressions consuming them. A mutable channel URL can resolve differently after an update, while immutable snapshots, explicit search paths and recorded revisions can constrain or document the selection. Adding a channel alone does not establish that a build uses it. Prefer an explicit, reviewed dependency policy where frozen inputs are required; this detector does not establish reproducibility or the presence/absence of runtime provenance.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/nix-channel",
      "https://nix.dev/tutorials/first-steps/towards-reproducibility-pinning-nixpkgs",
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-nix-path",
    ],
    impact: "medium",
    example: {
      bad: "- run: |\n    nix-channel --add https://nixos.org/channels/nixpkgs-unstable nixpkgs\n    nix-channel --update\n    nix-build '<nixpkgs>' -A hello",
      good: "- run: nix-build '<nixpkgs>' -A hello\n  env:\n    NIX_PATH: nixpkgs=https://github.com/NixOS/nixpkgs/archive/<commit>.tar.gz",
    },
  },
  check({ project, report }) {
    for (const site of nixCommandSites(project)) {
      nestedInvocations(site.nix).forEach((nix, depth) => {
        if (nix.binary !== "nix-channel") return;
        const { mode, args } = channelArgs(nix.args);
        const found = mode === "--add" ? addReport(site, nix, args) : mode === "--update" ? updateReport(project, site, nix, args) : undefined;
        if (found) report({ ...found, key: `${site.path}:${site.line}:${depth}:channel-in-ci` });
      });
    }
  },
});
