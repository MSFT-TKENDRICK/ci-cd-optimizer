import { posix } from "node:path";
import type { FlakeConfigEntry } from "../../parsers/nix.js";
import type { StepModel } from "../../parsers/workflow.js";
import type { ProjectModel } from "../../project.js";
import { usesAction } from "../caching/shared.js";
import { defineRule, expandedJobSteps, type ExpandedStep } from "../helpers.js";
import { SAMPLE_DIR, flakePath } from "./flake.js";
import {
  NIX_CONF_INPUTS,
  NIX_INSTALLER_ACTIONS,
  confValues,
  flakeConfigTrust,
  hasOption,
  installerConf,
  isGitHubHosted,
  isTruthyConf,
  nestedInvocations,
  nixInvocation,
  nixJobs,
  positionalArgs,
  type NixConfSetting,
  type NixInvocation,
  type NixJob,
} from "./shared.js";

interface CacheUrl {
  raw: string;
  norm: string;
  host?: string;
  key: string;
  entry: FlakeConfigEntry;
}

interface Target {
  dir: string;
  path: string;
  line: number;
  display: string;
}

interface JobView {
  model: NixJob;
  installer: StepModel;
  substituters: Set<string>;
  trusted: boolean;
  cachixNames: Set<string>;
  anyCachix: boolean;
  flakehub: boolean;
  text: string;
  targets: Target[];
}

const SUBSTITUTER_KEYS = ["extra-substituters", "substituters"];
const KEY_KEYS = ["extra-trusted-public-keys", "trusted-public-keys"];

/** `nix` subcommands that lock the flake (applying its `nixConfig`) and then realise store paths through substituters. */
const REALISING = new Set(["build", "develop", "run", "shell", "print-dev-env", "bundle", "fmt", "profile install", "profile add", "flake check"]);
/** Subcommands taking a single installable; later positionals belong to the program. */
const SINGLE_INSTALLABLE = new Set(["run", "develop", "print-dev-env", "bundle", "flake check"]);
/** Subcommands that default to the flake in the working directory when given no installable. */
const DEFAULTS_TO_CWD = new Set(["build", "develop", "run", "print-dev-env", "bundle", "flake check"]);

const WORKSPACE_PREFIX = /^(?:\$\{\{\s*github\.workspace\s*\}\}|\$GITHUB_WORKSPACE|\$\{GITHUB_WORKSPACE\})(?:\/|$)/;

function normalizeUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

function words(values: string[]): string[] {
  return values.flatMap((value) => value.split(/\s+/)).filter(Boolean);
}

/** Cache URLs a flake's `nixConfig` adds, excluding the default cache.nixos.org. */
function cacheUrls(nixConfig: Map<string, FlakeConfigEntry>): CacheUrl[] {
  const urls: CacheUrl[] = [];
  for (const key of SUBSTITUTER_KEYS) {
    const entry = nixConfig.get(key);
    if (!entry) continue;
    for (const raw of words(entry.values)) {
      if (!raw.includes("://")) continue;
      const host = hostOf(raw);
      if (host === "cache.nixos.org") continue;
      urls.push({ raw, norm: normalizeUrl(raw), ...(host ? { host } : {}), key, entry });
    }
  }
  return urls;
}

/** The repository directory of a local flake reference (`.`, `./sub#pkg`, `.?dir=sub`, `path:./sub`), relative to `cwd`. */
function localFlakeDir(word: string, cwd: string): string | undefined {
  let ref = word.replace(/#.*$/, "");
  const scheme = /^(?:path|git\+file):(.*)$/.exec(ref);
  if (scheme) ref = scheme[1] ?? "";
  const [base = "", query = ""] = ref.split("?", 2);
  if (!scheme && base !== "." && !base.startsWith("./") && base !== ".." && !base.startsWith("../")) return undefined;
  if (base.startsWith("/") || base.startsWith("~") || base.includes("$")) return undefined;
  const dir = new URLSearchParams(query).get("dir") ?? ".";
  if (dir.includes("$")) return undefined;
  const joined = posix.normalize(posix.join(cwd || ".", base || ".", dir)).replace(/\/+$/, "");
  if (joined === "..") return undefined;
  if (joined.startsWith("../")) return undefined;
  return joined === "." ? "" : joined;
}

function stepCwd(entry: ExpandedStep, model: NixJob): string | undefined {
  const raw = entry.step.workingDirectory ?? (entry.direct ? (model.job.workingDirectory ?? model.workflow.workingDirectory) : undefined) ?? "";
  const cwd = raw.trim().replace(WORKSPACE_PREFIX, "");
  return cwd.includes("$") ? undefined : cwd;
}

/** Local flake directories one Nix invocation evaluates and realises (empty when it does neither). */
function flakeTargets(nix: NixInvocation, cwd: string): string[] {
  if (nix.binary !== "nix" || !REALISING.has(nix.subcommand)) return [];
  if (nix.subcommand === "flake check" && hasOption(nix, "--no-build")) return [];
  if (hasOption(nix, "--expr", "--file", "-f")) return [];
  const positional = nix.subcommand === "fmt" ? [] : positionalArgs(nix);
  const refs = positional.length === 0 ? (DEFAULTS_TO_CWD.has(nix.subcommand) || nix.subcommand === "fmt" ? ["."] : []) : SINGLE_INSTALLABLE.has(nix.subcommand) ? positional.slice(0, 1) : positional;
  return refs.flatMap((ref) => localFlakeDir(ref, cwd) ?? []);
}

function display(nix: NixInvocation): string {
  const first = nix.subcommand === "fmt" ? undefined : positionalArgs(nix)[0];
  return `nix ${nix.subcommand}${first ? ` ${first}` : ""}`;
}

function addTargets(targets: Target[], nix: NixInvocation, cwd: string, path: string, line: number): void {
  for (const link of nestedInvocations(nix)) {
    for (const dir of flakeTargets(link, cwd)) {
      if (!targets.some((target) => target.dir === dir)) targets.push({ dir, path, line, display: display(link) });
    }
  }
}

function jobView(project: ProjectModel, model: NixJob): JobView | undefined {
  const { workflow, job } = model;
  if (!isGitHubHosted(job)) return undefined;
  const steps = expandedJobSteps(project, workflow, job);
  const installers = steps.filter((entry) => NIX_INSTALLER_ACTIONS.has(entry.step.uses?.action.name ?? ""));
  const installer = installers[0];
  if (!installer) return undefined;
  const conf: NixConfSetting[] = [...model.conf, ...installers.filter((entry) => !entry.direct).flatMap((entry) => installerConf(entry.step, entry.path))];
  const substituters = new Set(words(confValues(conf, "substituters", true).map((setting) => setting.value)).map(normalizeUrl));
  const indirectTrust = installers.some(
    (entry) => !entry.direct && confValues(installerConf(entry.step, entry.path), "accept-flake-config").some((setting) => isTruthyConf(setting.value)),
  );
  const trusted = indirectTrust || flakeConfigTrust(model).length > 0;

  const cachixNames = new Set<string>();
  let anyCachix = false;
  const addCachix = (name: string): void => {
    if (name.includes("$")) anyCachix = true;
    else if (name) cachixNames.add(name.toLowerCase());
  };
  let flakehub = false;
  const text: string[] = [];
  for (const { step } of steps) {
    if (usesAction(step, "cachix/cachix-action") && String(step.with.get("skipAddingSubstituter")?.value ?? "").trim() !== "true") {
      for (const input of ["name", "extraPullNames"]) {
        for (const name of String(step.with.get(input)?.value ?? "").split(/[\s,]+/)) addCachix(name.trim());
      }
    }
    if (usesAction(step, "determinatesystems/flakehub-cache-action", "determinatesystems/magic-nix-cache-action")) flakehub = true;
    const confInputs = NIX_CONF_INPUTS[step.uses?.action.name ?? ""] ?? [];
    for (const [name, value] of step.with) if (!confInputs.includes(name)) text.push(String(value.value));
    for (const [name, value] of Object.entries(step.env)) if (name !== "NIX_CONFIG") text.push(String(value));
  }
  for (const env of [workflow.env, job.env]) for (const [name, value] of Object.entries(env)) if (name !== "NIX_CONFIG") text.push(String(value));

  const targets: Target[] = [];
  for (const entry of model.commands) {
    for (const match of entry.command.matchAll(/\bcachix\s+use\s+(?:-\S+\s+)*([^\s;&|]+)/g)) addCachix(match[1] ?? "");
    text.push(entry.command);
    const cwd = entry.nix ? stepCwd(entry, model) : undefined;
    if (entry.nix && cwd !== undefined) addTargets(targets, entry.nix, cwd, entry.path, entry.line);
  }
  for (const step of job.steps) {
    const shell = step.shell ?? job.shell ?? workflow.shell;
    if (!step.run || !shell || !/\bnix\s+develop\b/.test(shell)) continue;
    const nix = nixInvocation(shell, step.run.line);
    const cwd = stepCwd({ step, owner: step, path: workflow.path, direct: true }, model);
    if (nix && cwd !== undefined) addTargets(targets, nix, cwd, workflow.path, step.run.line);
  }
  return { model, installer: installer.step, substituters, trusted, cachixNames, anyCachix, flakehub, text: text.join("\n").toLowerCase(), targets };
}

function covers(view: JobView, url: CacheUrl): boolean {
  if (view.trusted || view.substituters.has(url.norm)) return true;
  const host = url.host;
  if (!host) return true;
  const cachix = /^([a-z0-9-]+)\.cachix\.org$/.exec(host);
  if (cachix && (view.anyCachix || view.cachixNames.has(cachix[1] ?? ""))) return true;
  if (host === "cache.flakehub.com" && view.flakehub) return true;
  // Caches configured by tools this rule does not model (attic, custom scripts): any mention of the host counts.
  return view.text.includes(host);
}

function code(text: string): string {
  return `\`${text}\``;
}

export default defineRule({
  meta: {
    id: "nix/flake-nixconfig-cache-not-trusted",
    ruleset: "nix",
    description: "A flake's `nixConfig` adds a binary cache that CI jobs building the flake never apply.",
    rationale:
      "Settings in a flake's `nixConfig` are applied only when the flake is evaluated with `accept-flake-config = true` (apart from a short whitelist such as `bash-prompt`). Otherwise Nix asks whether to allow each one, the non-interactive answer in CI is \"no\", and it prints `ignoring untrusted flake configuration setting 'extra-substituters'` and carries on. Neither cachix/install-nix-action nor the Determinate installer sets `accept-flake-config`, and being a trusted user does not change this, so a CI job that builds the flake queries only the caches in its own nix.conf: everything the flake's cache holds and cache.nixos.org does not is rebuilt from source on every run.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake.html#flake-format",
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-accept-flake-config",
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-substituters",
      "https://github.com/cachix/cachix-action",
    ],
    impact: "medium",
    example: {
      bad: '# flake.nix\nnixConfig.extra-substituters = [ "https://demo.cachix.org" ];\n# .github/workflows/ci.yml\n- uses: cachix/install-nix-action@v31\n- run: nix build',
      good: "- uses: cachix/install-nix-action@v31\n  with:\n    extra_nix_config: |\n      extra-substituters = https://demo.cachix.org\n      extra-trusted-public-keys = demo.cachix.org-1:<key>\n- run: nix build",
    },
  },
  check({ project, report }) {
    const flakes = project.nix.flakes.flatMap((flake) => {
      if (!flake.info || SAMPLE_DIR.test(flake.dir)) return [];
      const urls = cacheUrls(flake.info.nixConfig);
      if (urls.length === 0) return [];
      const keys = words(KEY_KEYS.flatMap((key) => flake.info?.nixConfig.get(key)?.values ?? []));
      return [{ flake, urls, keys }];
    });
    if (flakes.length === 0) return;
    const views = [...nixJobs(project)].flatMap((model) => jobView(project, model) ?? []);

    for (const { flake, urls, keys } of flakes) {
      const misses: Array<{ view: JobView; target: Target; urls: CacheUrl[] }> = [];
      for (const view of views) {
        const target = view.targets.find((candidate) => candidate.dir === flake.dir);
        if (!target) continue;
        const missing = urls.filter((url) => !covers(view, url));
        if (missing.length > 0) misses.push({ view, target, urls: missing });
      }
      const first = misses[0];
      const firstUrl = first?.urls[0];
      if (!first || !firstUrl) continue;

      const path = flake.nix?.path ?? flakePath(flake.dir, "flake.nix");
      const uncovered = urls.filter((url) => misses.some((miss) => miss.urls.includes(url)));
      const { view, target } = first;
      const more = misses.length > 1 ? ` (and ${misses.length - 1} more job${misses.length > 2 ? "s" : ""})` : "";
      const listed = first.urls
        .filter((url) => url.key === firstUrl.key)
        .map((url) => code(url.raw))
        .join(", ");
      const message = `\`nixConfig.${firstUrl.key}\` adds ${listed}, but job \`${view.model.job.id}\` (\`${view.model.workflow.path}\`) runs \`${target.display}\` on this flake without \`accept-flake-config\` or ${first.urls.length > 1 ? "those substituters" : "that substituter"} in its own Nix configuration${more}, so Nix ignores the setting ("ignoring untrusted flake configuration setting") and the job never queries ${first.urls.length > 1 ? "these caches" : "this cache"}.`;

      const hosts = uncovered.flatMap((url) => url.host ?? []);
      const matchingKeys = keys.filter((key) => hosts.some((host) => key.toLowerCase().startsWith(host)));
      const keyText = (matchingKeys.length > 0 ? matchingKeys : keys).join(" ") || hosts.map((host) => `<public key of ${host}>`).join(" ");
      const confLines = [`extra-substituters = ${uncovered.map((url) => url.raw).join(" ")}`, `extra-trusted-public-keys = ${keyText}`];
      const uses = view.installer.uses;
      const input = NIX_CONF_INPUTS[uses?.action.name ?? ""]?.[0];
      const indent = (lines: string[], spaces: number): string => lines.map((line) => `${" ".repeat(spaces)}${line}`).join("\n");
      const snippet =
        uses && input
          ? `\`\`\`yaml\n- uses: ${uses.value}\n  with:\n    ${input}: |\n${indent(confLines, 6)}\n\`\`\``
          : `\`\`\`yaml\nenv:\n  NIX_CONFIG: |\n${indent(confLines, 4)}\n\`\`\``;
      const existing = uses && input && view.installer.with.has(input) ? ` (append these lines to the existing \`${input}\`)` : "";
      const cachixNames = uncovered.flatMap((url) => /^([a-z0-9-]+)\.cachix\.org$/.exec(url.host ?? "")?.[1] ?? []);
      const parts = [`Configure the cache in the job's own Nix configuration${existing}:\n${snippet}`];
      if (cachixNames.length > 0) {
        const input = cachixNames.length === 1 ? `name: ${cachixNames[0]}` : `extraPullNames: ${cachixNames.join(",")}`;
        parts.push(`For Cachix caches, a \`cachix/cachix-action@v17\` step with \`${input}\` after the installer adds the substituter and its key as well.`);
      }
      parts.push(
        "Prefer this to `accept-flake-config = true`: that lets any flake the job evaluates, including a pull request's edited flake.nix, set arbitrary Nix settings for the job.",
      );
      report({
        path,
        line: firstUrl.entry.line,
        key: `${path}:nixconfig-cache`,
        message,
        suggestion: parts.join("\n"),
        related: misses.slice(1).map((miss) => ({ path: miss.target.path, line: miss.target.line })),
      });
    }
  },
});
