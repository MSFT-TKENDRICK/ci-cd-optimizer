import type { FlakeInput, FlakeLockNode } from "../../parsers/nix.js";
import type { NixFlake } from "../../project.js";
import { defineRule } from "../helpers.js";
import { NIXPKGS_CHANNEL, NIXPKGS_DEV_BRANCH, STABLE_CHANNEL, githubSource, inputLine, lockOf, rootNode, str } from "./flake.js";

const FULL_REV = /^[0-9a-f]{40}$/i;
const NIXPKGS_TARBALL = /^(?:tarball\+)?https:\/\/(?:www\.)?github\.com\/nixos\/nixpkgs\/(?:archive|tarball)\/(.+?)(?:\.tar\.gz|\.zip)?$/i;

interface Tracked {
  /** The branch, or undefined for the repository's default branch (`master`). */
  branch?: string;
}

function branchOf(ref: string | undefined): Tracked | undefined {
  const branch = ref?.replace(/^refs\/heads\//, "");
  if (branch === undefined || branch === "") return {};
  if (FULL_REV.test(branch) || NIXPKGS_CHANNEL.test(branch) || !NIXPKGS_DEV_BRANCH.test(branch)) return undefined;
  return { branch };
}

/** The development branch a flake.nix nixpkgs input tracks, or undefined when it tracks a channel, a revision, or something else. */
function declaredBranch(input: FlakeInput): Tracked | undefined {
  const tarball = input.url !== undefined ? NIXPKGS_TARBALL.exec(input.url) : null;
  if (tarball?.[1]) return branchOf(tarball[1]);
  const source = githubSource(input);
  if (!source || source.owner.toLowerCase() !== "nixos" || source.repo.toLowerCase() !== "nixpkgs" || source.rev) return undefined;
  return branchOf(source.ref);
}

/** The same check on a lock node's `original`, for inputs whose flake.nix URL the parser cannot read. */
function lockedBranch(node: FlakeLockNode | undefined): Tracked | undefined {
  const original = node?.original;
  if (!original || str(original.type) !== "github" || str(original.rev)) return undefined;
  if (str(original.owner)?.toLowerCase() !== "nixos" || str(original.repo)?.toLowerCase() !== "nixpkgs") return undefined;
  return branchOf(str(original.ref));
}

function replacement(branch: string | undefined): string {
  const release = branch !== undefined ? /^release-(\d{2}\.\d{2})$/.exec(branch)?.[1] : undefined;
  return release ? `nixos-${release}` : "nixos-unstable";
}

function describe(branch: string | undefined): string {
  return branch === undefined ? "the default branch (`master`)" : `\`${branch}\``;
}

function suggestion(name: string, branch: string | undefined): string {
  const channel = replacement(branch);
  const darwin = channel === "nixos-unstable" ? "nixpkgs-unstable" : `nixpkgs-${channel.slice("nixos-".length)}-darwin`;
  return [
    `Track a channel branch, which only advances to commits Hydra has built and tested, then re-lock just this input:`,
    "",
    "```nix",
    `inputs.${name}.url = "github:NixOS/nixpkgs/${channel}";`,
    "```",
    "",
    "```sh",
    `nix flake update ${name}`,
    "```",
    "",
    `Use \`${darwin}\` instead if the flake mainly builds for macOS${channel === "nixos-unstable" ? `, or \`${STABLE_CHANNEL}\` for the current stable release` : ""}. If you need a specific \`master\` commit, pin it explicitly (\`github:NixOS/nixpkgs/<40-char-rev>\`) so the choice is deliberate.`,
  ].join("\n");
}

interface Finding {
  name: string;
  url?: string;
  tracked: Tracked;
  path: string;
  line: number;
}

/**
 * Inputs tracking a nixpkgs development branch. flake.nix is authoritative; the lock's `original`
 * (what flake.nix said when it was last locked) is used for inputs whose URL is interpolated and
 * for flake.nix files the parser cannot read (e.g. `let ... in { ... }`).
 */
function* nixpkgsDevInputs(flake: NixFlake): Generator<Finding> {
  const lock = lockOf(flake);
  const fromLock = function* (names: Iterable<string>): Generator<Finding> {
    if (!lock) return;
    for (const name of names) {
      const node = rootNode(lock, name);
      const tracked = lockedBranch(node);
      if (tracked && node) yield { name, tracked, path: lock.path, line: node.line };
    }
  };
  const info = flake.info;
  if (!info || !flake.nix) {
    yield* fromLock(Object.keys(lock?.rootInputs ?? {}));
    return;
  }
  for (const input of info.inputs.values()) {
    if (input.name === "self" || input.follows !== undefined) continue;
    if (!input.flakeRef) {
      yield* fromLock([input.name]);
      continue;
    }
    const tracked = declaredBranch(input);
    if (tracked) yield { name: input.name, ...(input.url !== undefined ? { url: input.url } : {}), tracked, path: flake.nix.path, line: inputLine(input) };
  }
}

export default defineRule({
  meta: {
    id: "nix/nixpkgs-input-not-channel",
    ruleset: "nix",
    description: "A nixpkgs flake input tracks `master`, a `release-*` or `staging*` branch instead of a channel branch.",
    rationale:
      "Commits reach nixpkgs `master`, `staging` and `release-YY.MM` before Hydra has built them. The channel branches (`nixos-unstable`, `nixpkgs-unstable`, `nixos-YY.MM`, `nixpkgs-YY.MM-darwin`, and their `-small` variants) only advance to a commit after Hydra finished the corresponding jobset, so the binaries for that revision are already on cache.nixos.org. A lock taken from a development branch can therefore point at a revision whose changed packages have no substitutes yet, and CI builds them, and everything depending on them, from source. Locking a development branch also picks up changes that have not passed the channel's tests.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://wiki.nixos.org/wiki/Channel_branches",
      "https://nix.dev/concepts/faq#channel-branches",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake#flake-references",
    ],
    impact: "medium",
    example: {
      bad: 'inputs.nixpkgs.url = "github:NixOS/nixpkgs";  # default branch: master',
      good: 'inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
    },
  },
  check({ project, report }) {
    for (const flake of project.nix.flakes) {
      for (const { name, url, tracked, path, line } of nixpkgsDevInputs(flake)) {
        const reference = url !== undefined ? ` (\`${url}\`)` : "";
        report({
          path,
          line,
          key: `${flake.dir}:${name}`,
          message: `Input \`${name}\`${reference} tracks nixpkgs ${describe(tracked.branch)}, a development branch that advances before Hydra has built it, so packages changed in the locked revision may have no binaries on cache.nixos.org yet and are built from source.`,
          suggestion: suggestion(name, tracked.branch),
        });
      }
    }
  },
});
