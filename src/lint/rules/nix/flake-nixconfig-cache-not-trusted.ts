import { posix } from "node:path";
import type { FlakeConfigEntry } from "../../parsers/nix.js";
import type { StepModel } from "../../parsers/workflow.js";
import { usesAction } from "../caching/shared.js";
import { defineRule, type ExpandedStep } from "../helpers.js";
import { commandDirectory } from "../toolchains/shared.js";
import { SAMPLE_DIR, flakePath } from "./flake.js";
import {
  NIX_CONF_INPUTS,
  NIX_INSTALLER_ACTIONS,
  confValues,
  effectiveNixConf,
  hasOption,
  isGitHubHosted,
  isTruthyConf,
  nestedInvocations,
  nixInvocation,
  nixJobs,
  positionalArgs,
  stepIsSkipped,
  type NixCommand,
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
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return url.trim();
  }
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

function jobView(model: NixJob, site: NixCommand, nix: NixInvocation): JobView | undefined {
  const { workflow, job } = model;
  if (!isGitHubHosted(job) || stepIsSkipped(site)) return undefined;
  const position = model.entries.findIndex((entry) => entry.step === site.step && entry.owner === site.owner);
  if (position < 0) return undefined;
  const steps = model.entries.slice(0, position).filter((entry) => !stepIsSkipped(entry));
  const installers = steps.filter((entry) => NIX_INSTALLER_ACTIONS.has(entry.step.uses?.action.name ?? ""));
  const installer = installers.at(-1);
  if (!installer) return undefined;
  const conf = effectiveNixConf(model, site, nix);
  if (!conf) return undefined;
  const substituters = new Set<string>();
  for (const setting of confValues(conf, "substituters", true)) {
    if (setting.key === "substituters") substituters.clear();
    for (const value of words([setting.value])) substituters.add(normalizeUrl(value));
  }
  const trusted = isTruthyConf(confValues(conf, "accept-flake-config").at(-1)?.value ?? "false");

  const cachixNames = new Set<string>();
  let anyCachix = false;
  const addCachix = (name: string): void => {
    if (name.includes("$")) anyCachix = true;
    else if (name) cachixNames.add(name.toLowerCase());
  };
  let flakehub = false;
  const text: string[] = [];
  for (const { step, owner } of steps) {
    if ((step.if || owner.if) && usesAction(step, "cachix/cachix-action", "determinatesystems/flakehub-cache-action", "determinatesystems/magic-nix-cache-action")) return undefined;
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

  for (const entry of model.commands) {
    if (entry === site || (entry.step === site.step && entry.owner === site.owner && site.command === "")) break;
    const index = model.entries.findIndex((candidate) => candidate.step === entry.step && candidate.owner === entry.owner);
    if (index > position) break;
    if (stepIsSkipped(entry)) continue;
    for (const match of entry.command.matchAll(/\bcachix\s+use\s+(?:-\S+\s+)*([^\s;&|]+)/g)) addCachix(match[1] ?? "");
    text.push(entry.command);
  }
  const cwd = site.command === "" ? stepCwd(site, model) : commandDirectory(model, site);
  if (cwd === undefined) return undefined;
  const targets = flakeTargets(nix, cwd).map((dir) => ({ dir, path: site.path, line: site.line, display: display(nix) }));
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
    description: "A flake names an additional binary cache without recognized configuration at a CI command building it.",
    rationale:
      "Flake-provided substituters need appropriate acceptance and trust, or equivalent configuration outside the flake. This rule compares visible preceding installer/actions, per-command configuration and local flake targets on recognized hosted runners. External trust decisions, daemon policy and other cache sources may still provide reuse. A complete inventory is required, but it does not reveal runtime state or prove cache misses. Prefer explicitly reviewed cache URLs/keys to broadly accepting pull-request-controlled flake settings.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: ["complete-inventory"],
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
    const views = [...nixJobs(project)].flatMap((model) => {
      const sites = [...model.commands];
      for (const entry of model.entries) {
        const shell = entry.step.shell ?? (entry.direct ? model.job.shell ?? model.workflow.shell : undefined);
        const nix = entry.step.run && shell ? nixInvocation(shell, entry.step.run.line) : undefined;
        if (nix) sites.push({ ...entry, command: "", line: nix.line, nix });
      }
      return sites.flatMap((site) => site.nix ? nestedInvocations(site.nix).flatMap((nix) => jobView(model, site, nix) ?? []) : []);
    });

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
      const jobCount = new Set(misses.map((miss) => `${miss.view.model.workflow.path}:${miss.view.model.job.id}`)).size;
      const more = jobCount > 1 ? ` (and ${jobCount - 1} more job${jobCount > 2 ? "s" : ""})` : "";
      const listed = first.urls
        .filter((url) => url.key === firstUrl.key)
        .map((url) => code(url.raw))
        .join(", ");
      const message = `\`nixConfig.${firstUrl.key}\` adds ${listed}, but job \`${view.model.job.id}\` (\`${view.model.workflow.path}\`) runs \`${target.display}\` on this flake without recognized preceding acceptance or equivalent substituter configuration${more}. The setting may be ignored; external configuration and daemon policy are not established by this inspection.`;

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
        "Review the cache operator and public key independently. Prefer explicit settings to `accept-flake-config = true`, which accepts eligible flake-provided settings, potentially from an edited pull request. Effective permissions and daemon behavior still depend on the installation and Nix version.",
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
