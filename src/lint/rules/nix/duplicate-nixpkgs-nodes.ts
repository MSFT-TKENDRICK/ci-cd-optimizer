import { resolveLockInput, type FlakeLock, type FlakeLockNode, type NixBinding } from "../../parsers/nix.js";
import type { NixFlake, ProjectModel } from "../../project.js";
import { usesAction } from "../caching/shared.js";
import { defineRule } from "../helpers.js";
import { confValues, nixJobs } from "./shared.js";
import { describeOriginal, flakeBindings, inputLine, isNixpkgsNode, lockOf, nodeIdentity, shortRev, str } from "./flake.js";

const GENERIC_HOST_LABELS = new Set(["cache", "cachix", "nixos", "nix", "binary", "binaries", "store", "www", "org", "com", "io", "net", "dev", "app"]);

interface RootTarget {
  name: string;
  node: FlakeLockNode;
}

interface Duplicate {
  input: string;
  inputNode: FlakeLockNode;
  edge: string;
  dep: FlakeLockNode;
  target: RootTarget;
  compatible: boolean;
}

/** nixpkgs release a ref belongs to: `unstable` for master and the unstable channels, `YY.MM` for release/channel branches. */
function release(node: FlakeLockNode): string | undefined {
  const original = node.original;
  const type = str(original?.type);
  if (!original || str(original.rev) || (type !== "github" && type !== "indirect" && type !== "git")) return undefined;
  const ref = str(original.ref)?.replace(/^refs\/heads\//, "");
  if (ref === undefined || /^(?:master|nixos-unstable(?:-small)?|nixpkgs-unstable)$/.test(ref)) return "unstable";
  return /^(?:nixos-(\d{2}\.\d{2})(?:-small)?|nixpkgs-(\d{2}\.\d{2})-darwin|release-(\d{2}\.\d{2}))$/.exec(ref)?.slice(1).find(Boolean);
}

function rootTargets(lock: FlakeLock): RootTarget[] {
  const targets: RootTarget[] = [];
  for (const [name, reference] of Object.entries(lock.rootInputs)) {
    const node = resolveLockInput(lock, reference);
    if (node && isNixpkgsNode(node)) targets.push({ name, node });
  }
  return targets;
}

function pickTarget(targets: RootTarget[], dep: FlakeLockNode): { target: RootTarget; compatible: boolean } | undefined {
  const wanted = release(dep);
  const same = wanted === undefined ? undefined : targets.find((target) => release(target.node) === wanted);
  if (same) return { target: same, compatible: true };
  const fallback = targets.find((target) => target.name === "nixpkgs") ?? targets[0];
  return fallback ? { target: fallback, compatible: false } : undefined;
}

/** Lowercased, punctuation-free names of binary caches the repository configures (`hyprland` for `https://hyprland.cachix.org`). */
function cacheNames(project: ProjectModel, flake: NixFlake): Set<string> {
  const names = new Set<string>();
  const addUrl = (value: string): void => {
    for (const url of value.split(/\s+/)) {
      const host = /^[a-z0-9+.-]+:\/\/([^/:?#]+)/i.exec(url)?.[1];
      for (const label of host?.toLowerCase().split(".") ?? []) if (!GENERIC_HOST_LABELS.has(label)) names.add(label);
    }
  };
  for (const [key, entry] of flake.info?.nixConfig ?? []) {
    if (/substituters$/.test(key)) entry.values.forEach(addUrl);
  }
  for (const job of nixJobs(project)) {
    for (const setting of confValues(job.conf, "substituters", true)) addUrl(setting.value);
    for (const step of job.caches) {
      if (!usesAction(step, "cachix/cachix-action")) continue;
      for (const input of ["name", "extraPullNames"]) {
        const value = step.with.get(input)?.value;
        if (typeof value === "string") value.split(/[\s,]+/).forEach((name) => name && names.add(name.toLowerCase()));
      }
    }
  }
  return new Set([...names].map((name) => name.replace(/[^a-z0-9]/g, "")).filter((name) => name.length >= 4));
}

/** Potential upstream-cache usage is a conservative opt-out, not evidence of actual cache hits. */
function hasOwnCache(input: string, caches: Set<string>): boolean {
  const name = input.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (name.length < 4) return false;
  return [...caches].some((cache) => cache.includes(name) || name.includes(cache));
}

function duplicates(flake: NixFlake, lock: FlakeLock, caches: Set<string>, bindings: NixBinding[]): Duplicate[] {
  const targets = rootTargets(lock);
  if (targets.length === 0) return [];
  const rootIds = new Set(targets.map((target) => nodeIdentity(target.node)));
  const found: Duplicate[] = [];
  for (const [input, reference] of Object.entries(lock.rootInputs)) {
    if (typeof reference !== "string") continue;
    const inputNode = lock.nodes.get(reference);
    if (!inputNode || isNixpkgsNode(inputNode) || hasOwnCache(input, caches)) continue;
    const declared = flake.info?.inputs.get(input);
    for (const [edge, depReference] of Object.entries(inputNode.inputs)) {
      if (typeof depReference !== "string") continue;
      const dep = lock.nodes.get(depReference);
      if (!dep || !isNixpkgsNode(dep)) continue;
      const identity = nodeIdentity(dep);
      if (identity === undefined || rootIds.has(identity)) continue;
      if (declared?.nestedFollows.has(edge)) continue;
      if (bindings.some(({ path }) => path[0] === "inputs" && path[1] === input && path[2] === "inputs" && path[3] === edge)) continue;
      const picked = pickTarget(targets, dep);
      if (picked) found.push({ input, inputNode, edge, dep, ...picked });
    }
  }
  return found;
}

function describeNode(node: FlakeLockNode): string {
  const source = describeOriginal(node.original);
  const rev = shortRev(str(node.locked?.rev));
  return [source ? `\`${source}\`` : undefined, rev ? `at ${rev}` : undefined].filter(Boolean).join(" ") || "an unknown revision";
}

export default defineRule({
  meta: {
    id: "nix/duplicate-nixpkgs-nodes",
    ruleset: "nix",
    description: "A flake input brings its own nixpkgs revision instead of following the flake's `nixpkgs`, so flake.lock holds several nixpkgs copies.",
    rationale:
      "Distinct nixpkgs revisions can add source fetches, evaluation work and different derivations when those inputs are used. They do not imply that every package differs: unchanged derivations can still share store paths. A follows declaration changes the dependency revision and requires regenerating flake.lock; sharing a channel name does not establish compatibility. Review and test that change, including upstream binary-cache coverage, rather than applying it automatically.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake#flake-inputs",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake#lock-files",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake-lock",
    ],
    impact: "medium",
    fixable: false,
    example: {
      bad: 'inputs.home-manager.url = "github:nix-community/home-manager";',
      good: 'inputs.home-manager.url = "github:nix-community/home-manager";\ninputs.home-manager.inputs.nixpkgs.follows = "nixpkgs";',
    },
  },
  check({ project, report }) {
    for (const flake of project.nix.flakes) {
      const lock = lockOf(flake);
      if (!lock) continue;
      const identities = new Set([...lock.nodes.values()].filter(isNixpkgsNode).map(nodeIdentity).filter((id) => id !== undefined));
      if (identities.size < 2) continue;
      const nixFile = flake.nix;
      const bindings = nixFile ? flakeBindings(nixFile) : [];
      for (const duplicate of duplicates(flake, lock, cacheNames(project, flake), bindings)) {
        const { input, edge, dep, target, compatible } = duplicate;
        const declared = flake.info?.inputs.get(input);
        const onFlake = nixFile !== undefined && declared !== undefined;
        const mismatch = compatible
          ? ""
          : ` It asks for ${describeNode(dep)} while \`${target.name}\` is ${describeNode(target.node)}; check that \`${input}\` supports that revision before following it.`;
        report({
          path: onFlake ? nixFile.path : lock.path,
          line: onFlake ? inputLine(declared) : duplicate.inputNode.line,
          key: `${flake.dir}:${input}/${edge}`,
          message: `Input \`${input}\` locks its own nixpkgs (\`${edge}\` → lock node \`${dep.name}\`, ${describeNode(dep)}) instead of following \`${target.name}\`; flake.lock holds ${identities.size} distinct nixpkgs revisions. Used inputs may require extra fetches and evaluation; unchanged derivations can still share store paths.${mismatch}`,
          suggestion: [
            `Only if \`${input}\` supports your nixpkgs revision, consider the following dependency change, regenerate the lock and test all affected outputs:`,
            "",
            "```nix",
            `inputs.${input}.inputs.${edge}.follows = "${target.name}";`,
            "```",
            "",
            "```sh",
            "nix flake lock",
            "```",
            "",
            `\`${input}\` is then built against your nixpkgs revision instead of the one it was tested with. Skip this if \`${input}\` publishes a binary cache you rely on, because its cached outputs were built with its own nixpkgs.`,
          ].join("\n"),
        });
      }
    }
  },
});
