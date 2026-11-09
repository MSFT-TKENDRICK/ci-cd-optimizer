import { indentOf, fix, insertLinesAfter } from "../../fix.js";
import { resolveLockInput, type FlakeLock, type FlakeLockNode, type NixBinding, type NixFile } from "../../parsers/nix.js";
import type { NixFlake, ProjectModel } from "../../project.js";
import type { Fix, SourceFile } from "../../types.js";
import { usesAction } from "../caching/shared.js";
import { defineRule } from "../helpers.js";
import { confValues, nixJobs } from "./shared.js";
import { describeOriginal, flakeBindings, inputLine, isNixpkgsNode, lockOf, nodeIdentity, shortRev, str } from "./flake.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_'-]*$/;
const URL_KEY = /^(?:[A-Za-z_][A-Za-z0-9_'-]*\.)*url$/;
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

/** True when the input appears to publish its own binary cache that the repository uses; following would forfeit its hits. */
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

/** Inserts `<prefix>inputs.<edge>.follows = "<target>";` after a simple single-line `<prefix>url = "...";` binding. */
function followsFix(file: NixFile, source: SourceFile, bindings: NixBinding[], duplicate: Duplicate): Fix | undefined {
  const { input, edge, target } = duplicate;
  if (!duplicate.compatible || !IDENT.test(input) || !IDENT.test(edge) || !IDENT.test(target.name)) return undefined;
  const own = bindings.filter(({ path }) => path[0] === "inputs" && path[1] === input);
  const urls = own.filter(({ path }) => path.length === 3 && path[2] === "url");
  if (urls.length !== 1 || own.some(({ path }) => path[2] === "inputs")) return undefined;
  const binding = urls[0];
  if (!binding) return undefined;
  const { masked } = file;
  const line = file.lineOf(binding.keyStart);
  if (file.lineOf(binding.valueEnd) !== line || masked[binding.valueEnd] !== ";") return undefined;
  const lineEnd = masked.indexOf("\n", binding.valueEnd);
  if (masked.slice(binding.valueEnd + 1, lineEnd < 0 ? masked.length : lineEnd).trim() !== "") return undefined;
  const lineBegin = masked.lastIndexOf("\n", binding.keyStart - 1) + 1;
  if (masked.slice(lineBegin, binding.keyStart).trim() !== "") return undefined;
  const equals = masked.lastIndexOf("=", binding.valueStart);
  const key = file.content.slice(binding.keyStart, equals).trim();
  if (!URL_KEY.test(key)) return undefined;
  const segments = key.split(".");
  if (segments.join("\0") !== binding.path.slice(-segments.length).join("\0")) return undefined;
  const prefix = key.slice(0, -"url".length);
  if (source.content !== file.content) return undefined;
  const text = `${indentOf(file.content, line)}${prefix}inputs.${edge}.follows = "${target.name}";`;
  return fix(`Make \`${input}\` follow \`${target.name}\` (then run \`nix flake lock\`)`, insertLinesAfter(source, line, [text]));
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
      "Every distinct nixpkgs node in flake.lock is a separate source tree: Nix fetches and unpacks each one, evaluates each one (nixpkgs evaluation dominates the evaluation time of most flakes), and packages built from different revisions have different store paths, so the closures of the flake's outputs cannot share them and CI downloads or builds every shared dependency once per revision. `inputs.<input>.inputs.nixpkgs.follows = \"nixpkgs\"` makes the dependency use the flake's own nixpkgs node, and the next `nix flake lock` drops the extra copy.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake#flake-inputs",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake#lock-files",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake-lock",
    ],
    impact: "medium",
    fixable: true,
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
        const source = onFlake ? project.files.get(nixFile.path) : undefined;
        const fixed = onFlake && source ? followsFix(nixFile, source, bindings, duplicate) : undefined;
        const mismatch = compatible
          ? ""
          : ` It asks for ${describeNode(dep)} while \`${target.name}\` is ${describeNode(target.node)}; check that \`${input}\` supports that revision before following it.`;
        report({
          path: onFlake ? nixFile.path : lock.path,
          line: onFlake ? inputLine(declared) : duplicate.inputNode.line,
          key: `${flake.dir}:${input}/${edge}`,
          message: `Input \`${input}\` locks its own nixpkgs (\`${edge}\` → lock node \`${dep.name}\`, ${describeNode(dep)}) instead of following \`${target.name}\`; flake.lock holds ${identities.size} distinct nixpkgs revisions, each fetched and evaluated separately, and their packages share no store paths.${mismatch}`,
          suggestion: [
            `Make \`${input}\` use your nixpkgs, then re-lock to drop the extra node:`,
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
          ...(fixed ? { fix: fixed } : {}),
        });
      }
    }
  },
});
