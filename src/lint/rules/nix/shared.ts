import { hasTrigger, type JobModel, type StepModel, type WorkflowModel } from "../../parsers/workflow.js";
import { NIX_INSTALLER_ACTIONS, type ProjectModel } from "../../project.js";
import { usesAction } from "../caching/shared.js";
import type { SourceFile } from "../../types.js";
import { commandTokens, shellTokens, shellWords } from "../../parsers/shell.js";
import { actionVersion, commandsOf, expandedJobSteps, jobCommands, jobRunsOnLabels, stepLine, steps, type ExpandedStep, type JobCommand } from "../helpers.js";

export { NIX_INSTALLER_ACTIONS };
export { commandTokens, shellTokens, shellWords } from "../../parsers/shell.js";
export type { ShellToken } from "../../parsers/shell.js";

/** Nix command-line programs (classic and new CLI). */
export const NIX_BINARIES = new Set([
  "nix",
  "nix-build",
  "nix-shell",
  "nix-store",
  "nix-env",
  "nix-instantiate",
  "nix-channel",
  "nix-collect-garbage",
  "nix-copy-closure",
  "nix-prefetch-url",
  "nixos-rebuild",
]);

/** Top-level `nix` subcommands. Used to find the subcommand past global options whose values may be split words. */
const NIX_SUBCOMMANDS = new Set([
  "build",
  "bundle",
  "config",
  "copy",
  "daemon",
  "derivation",
  "develop",
  "doctor",
  "edit",
  "env",
  "eval",
  "flake",
  "fmt",
  "hash",
  "help",
  "key",
  "log",
  "nar",
  "path-info",
  "print-dev-env",
  "profile",
  "realisation",
  "registry",
  "repl",
  "run",
  "search",
  "shell",
  "show-config",
  "show-derivation",
  "store",
  "upgrade-nix",
  "why-depends",
]);

/** `nix <group> <command>` groups whose second word is part of the subcommand. */
const NIX_GROUPS = new Set(["flake", "profile", "store", "registry", "derivation", "hash", "key", "nar", "realisation", "config"]);

/** Installer inputs that carry raw nix.conf text, keyed by lowercased action name. */
export const NIX_CONF_INPUTS: Record<string, string[]> = {
  "cachix/install-nix-action": ["extra_nix_config"],
  "determinatesystems/nix-installer-action": ["extra-conf"],
  "determinatesystems/determinate-nix-action": ["extra-conf"],
  "nixbuild/nix-quick-install-action": ["nix_conf"],
};

/** Actions that pull from and/or push to a Nix binary cache (substituter) or persist the store. */
export const NIX_CACHE_ACTIONS = [
  "cachix/cachix-action",
  "determinatesystems/flakehub-cache-action",
  "determinatesystems/magic-nix-cache-action",
  "nix-community/cache-nix-action",
  "nix-community/cache-nix-action/restore",
  "nix-community/cache-nix-action/save",
  "ryanccn/attic-action",
];

export interface NixConfSetting {
  /** Setting name as written, e.g. `extra-substituters` or `max-jobs`. */
  key: string;
  value: string;
  line: number;
  path: string;
  /** Where the setting came from: an installer input, `NIX_CONFIG`, a CLI flag, or a shell write to `nix.conf`. */
  source: "installer" | "env" | "cli" | "shell";
  implicitStep?: StepModel;
}

export interface NixInvocation {
  /** Program name, e.g. `nix`, `nix-build`, `nix-shell`. */
  binary: string;
  /** For `nix`: `build`, `develop`, `flake check`, `profile install`, ... Empty for classic tools. */
  subcommand: string;
  /** Remaining words (options and installables), excluding the wrapped command. */
  args: string[];
  /** For `nix develop/shell -c ...` and `nix-shell --run ...`: the wrapped command, if any. */
  inner?: string;
  command: string;
  line: number;
}

/** Parses nix.conf text (`key = value`, `#` comments). `include` lines are ignored. */
export function parseNixConf(text: string, path: string, firstLine: number, source: NixConfSetting["source"] = "installer"): NixConfSetting[] {
  const settings: NixConfSetting[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const content = raw.replace(/#.*$/, "").trim();
    const match = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(content);
    if (match?.[1]) settings.push({ key: match[1], value: (match[2] ?? "").trim(), line: firstLine + index, path, source });
  });
  return settings;
}

/** nix.conf settings an installer step applies through its config input. */
export function installerConf(step: StepModel, path: string): NixConfSetting[] {
  const inputs = NIX_CONF_INPUTS[step.uses?.action.name ?? ""] ?? [];
  return inputs.flatMap((name) => {
    const entry = step.with.get(name);
    if (!entry || typeof entry.value !== "string") return [];
    // Block scalars start on the line after the key.
    const firstLine = entry.value.includes("\n") ? entry.line + 1 : entry.line;
    return parseNixConf(entry.value, path, firstLine);
  });
}

/** Settings from a `NIX_CONFIG` environment value (newline-separated nix.conf text), all reported at `line`. */
export function envConf(env: Record<string, unknown>, path: string, line: number): NixConfSetting[] {
  const value = env.NIX_CONFIG;
  return typeof value === "string" ? parseNixConf(value, path, line, "env").map((setting) => ({ ...setting, line })) : [];
}

function unquote(text: string): string {
  return text.replace(/^(['"])([\s\S]*)\1$/, "$2");
}

/** Recognises a Nix CLI invocation (after `sudo`/`env`/`VAR=` prefixes). Arguments are quote-aware and end at a pipe or redirection. */
export function nixInvocation(command: string, line: number): NixInvocation | undefined {
  const tokens = commandTokens(command);
  if (tokens.some((token) => /[$`]/.test(token.value) && !/^'[^']*'$/.test(token.raw))) return undefined;
  const binary = (tokens[0]?.value ?? "").split("/").pop() ?? "";
  if (!NIX_BINARIES.has(binary)) return undefined;
  let rest = tokens.slice(1);
  let subcommand = "";
  if (binary === "nix") {
    let index = -1;
    for (let position = 0; position < rest.length; position += 1) {
      const word = rest[position]?.value ?? "";
      if (word.startsWith("-")) position += word.includes("=") ? 0 : (OPTION_ARITY[word] ?? 0);
      else if (NIX_SUBCOMMANDS.has(word)) {
        index = position;
        break;
      }
    }
    if (index >= 0) {
      const first = rest[index]?.value ?? "";
      const second = rest[index + 1]?.value;
      const grouped = NIX_GROUPS.has(first) && second !== undefined && !second.startsWith("-");
      subcommand = grouped ? `${first} ${second}` : first;
      rest = [...rest.slice(0, index), ...rest.slice(index + (grouped ? 2 : 1))];
    }
  }
  let inner: string | undefined;
  const commandFlag = (names: string[]): number => {
    const invocation: NixInvocation = { binary, subcommand, args: [], command, line };
    for (let index = 0; index < rest.length; index += 1) {
      const word = rest[index]?.value ?? "";
      if (word === "--") break;
      if (names.includes(word)) return index;
      if (word.startsWith("-") && !word.includes("=")) index += optionArity(invocation, word);
    }
    return -1;
  };
  if (subcommand === "develop" || subcommand === "shell") {
    // `-c/--command` consumes every remaining word.
    const flag = commandFlag(["-c", "--command"]);
    if (flag >= 0) {
      const wrapped = rest.slice(flag + 1);
      inner = wrapped.length === 1 ? (wrapped[0]?.value ?? "") : wrapped.map((token) => token.raw).join(" ");
      rest = rest.slice(0, flag);
    }
  }
  if (binary === "nix-shell") {
    // `--run/--command` takes exactly one argument.
    const flag = commandFlag(["--run", "--command"]);
    if (flag >= 0) {
      inner = rest[flag + 1]?.value ?? "";
      rest = [...rest.slice(0, flag), ...rest.slice(flag + 2)];
    }
  }
  return { binary, subcommand, args: rest.map((token) => token.value), ...(inner !== undefined ? { inner } : {}), command, line };
}

/** Value of a CLI option (`--opt value` or `--opt=value`); `true` for a bare flag; undefined when absent. */
export function cliOption(invocation: NixInvocation, ...names: string[]): string | true | undefined {
  for (let index = 0; index < invocation.args.length; index += 1) {
    const word = invocation.args[index] ?? "";
    for (const name of names) {
      if (word === name) {
        const next = invocation.args[index + 1];
        return next !== undefined && !next.startsWith("-") ? unquote(next) : true;
      }
      if (word.startsWith(`${name}=`)) return unquote(word.slice(name.length + 1));
    }
  }
  return undefined;
}

export function hasFlag(invocation: NixInvocation, ...names: string[]): boolean {
  return hasOption(invocation, ...names);
}

/** Words before `--`; Nix still parses option flags after an installable. */
export function optionArgs(invocation: NixInvocation): string[] {
  const end = invocation.args.indexOf("--");
  return end < 0 ? invocation.args : invocation.args.slice(0, end);
}

/** `hasFlag` restricted to the words before `--`. */
export function hasOption(invocation: NixInvocation, ...names: string[]): boolean {
  const words = optionArgs(invocation);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (names.includes(word) || names.some((name) => word.startsWith(`${name}=`))) return true;
    if (word.startsWith("-") && !word.includes("=")) index += optionArity(invocation, word);
  }
  return false;
}

/** Number of values common Nix options consume (options not listed are treated as flags). */
const OPTION_ARITY: Record<string, number> = {
  "--option": 2,
  "--extra-option": 2,
  "--override-input": 2,
  "--override-flake": 2,
  "--arg": 2,
  "--argstr": 2,
  "--arg-from-file": 2,
  "--arg-from-stdin": 1,
  "--expr": 1,
  "--file": 1,
  "-f": 1,
  "--set-env-var": 2,
  "--redirect": 2,
  "--max-jobs": 1,
  "-j": 1,
  "--cores": 1,
  "--update-input": 1,
  "--flake": 1,
  "--inputs-from": 1,
  "--reference-lock-file": 1,
  "--output-lock-file": 1,
  "-I": 1,
  "--include": 1,
  "--log-format": 1,
  "-o": 1,
  "--out-link": 1,
  "--profile": 1,
  "--system": 1,
  "--store": 1,
  "--eval-store": 1,
  "--builders": 1,
  "--substituters": 1,
  "--extra-substituters": 1,
  "--trusted-public-keys": 1,
  "--extra-trusted-public-keys": 1,
  "--keep-env-var": 1,
  "-k": 1,
  "--unset-env-var": 1,
  "-u": 1,
  "--phase": 1,
  "--priority": 1,
  "-A": 1,
  "--attr": 1,
  "--to": 1,
  "--from": 1,
  "--timeout": 1,
  "--max-silent-time": 1,
  "--template": 1,
  "-t": 1,
};

/** Number of values the option `word` consumes on the command line (0 for flags and unknown options). */
export function optionArity(invocation: NixInvocation, word: string): number {
  if (invocation.binary !== "nix" && (word === "--expr" || word === "-E")) return 0;
  return OPTION_ARITY[word] ?? 0;
}

/**
 * Positional words of an invocation (installables, flake references, attribute names, package names), skipping
 * options and the values they consume. For the new CLI `--expr`/`--file`/`-f` consume a value too; for classic tools
 * `-E/--expr` is a flag that turns the positionals into expressions. Words after `--` are the program's own arguments
 * and are not returned.
 */
export function positionalArgs(invocation: NixInvocation): string[] {
  const found: string[] = [];
  for (let index = 0; index < invocation.args.length; index += 1) {
    const word = invocation.args[index] ?? "";
    if (word === "--") break;
    if (word.startsWith("-") && word.length > 1) index += word.includes("=") ? 0 : optionArity(invocation, word);
    else found.push(word);
  }
  return found;
}

/**
 * The invocation followed by the Nix commands it wraps: `nix develop -c nix flake check` yields the `develop` and the
 * `flake check` invocations. Wrapped commands that are not a single Nix program (e.g. `bash -c '...'`) end the chain.
 */
export function nestedInvocations(invocation: NixInvocation): NixInvocation[] {
  const chain = [invocation];
  let current = invocation;
  while (current.inner !== undefined && chain.length < 4) {
    const next = nixInvocation(current.inner, current.line);
    if (!next) break;
    chain.push(next);
    current = next;
  }
  return chain;
}

/** Value-taking CLI flags that set a nix.conf setting (every setting is also exposed as `--<name> <value>`). */
const SETTING_FLAGS: Record<string, string> = {
  "--max-jobs": "max-jobs",
  "-j": "max-jobs",
  "--cores": "cores",
  "--builders": "builders",
  "--substituters": "substituters",
  "--extra-substituters": "extra-substituters",
  "--trusted-public-keys": "trusted-public-keys",
  "--extra-trusted-public-keys": "extra-trusted-public-keys",
};

/** Boolean settings' generated `--<name>` / `--no-<name>` flags, plus `--relaxed-sandbox`. */
const BOOLEAN_FLAGS: Record<string, [string, string]> = {
  "--accept-flake-config": ["accept-flake-config", "true"],
  "--no-accept-flake-config": ["accept-flake-config", "false"],
  "--sandbox": ["sandbox", "true"],
  "--no-sandbox": ["sandbox", "false"],
  "--relaxed-sandbox": ["sandbox", "relaxed"],
};

/**
 * nix.conf settings passed on the command line: `--option <key> <value>`, `--extra-option <key> <value>`, setting
 * flags such as `--max-jobs 4` / `-j 4`, and boolean flags such as `--no-sandbox` or `--accept-flake-config`.
 */
export function cliConf(invocation: NixInvocation, path: string): NixConfSetting[] {
  const settings: NixConfSetting[] = [];
  const push = (key: string, value: string): void => {
    settings.push({ key, value: unquote(value), line: invocation.line, path, source: "cli" });
  };
  const words = optionArgs(invocation);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    const next = words[index + 1];
    if (word === "--option" || word === "--extra-option") {
      const value = words[index + 2];
      if (next && value !== undefined) push(word === "--extra-option" && !next.startsWith("extra-") ? `extra-${next}` : next, value);
      index += 2;
      continue;
    }
    const boolean = BOOLEAN_FLAGS[word];
    if (boolean) {
      push(boolean[0], boolean[1]);
      continue;
    }
    const setting = SETTING_FLAGS[word];
    if (setting && next !== undefined && !next.startsWith("-")) {
      push(setting, next);
      index += 1;
      continue;
    }
    const assigned = /^(--[a-z-]+)=(.*)$/.exec(word);
    const assignedSetting = assigned?.[1] ? SETTING_FLAGS[assigned[1]] : undefined;
    if (assignedSetting) push(assignedSetting, assigned?.[2] ?? "");
    else if (/^-j\d+$/.test(word)) push("max-jobs", word.slice(2));
    else if (word.startsWith("-") && !word.includes("=")) index += optionArity(invocation, word);
  }
  return settings;
}

const NIX_CONF_WRITE = /(?:>>?|\btee\b[^|>]*?)\s*["']?[^\s"']*\bnix\.conf\b/;

/**
 * Settings appended to a nix.conf by a shell command such as `echo "sandbox = false" | sudo tee -a /etc/nix/nix.conf`
 * or `printf 'max-jobs = 2\n' >> ~/.config/nix/nix.conf`. Only `echo`/`printf` with literal text is understood.
 */
export function shellConfWrites(command: string, path: string, line: number): NixConfSetting[] {
  if (!NIX_CONF_WRITE.test(command)) return [];
  const tokens = shellTokens(command);
  let end = 0;
  for (const token of tokens) {
    const start = command.indexOf(token.raw, end);
    if (start < 0) return [];
    end = start + token.raw.length;
  }
  const sink = /^(?:>>?|\|\s*(?:sudo\s+)?tee(?:\s+-a)?)\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(command.slice(end).trim());
  const target = sink?.[1] ?? sink?.[2] ?? sink?.[3];
  if (!target || !/^(?:\/etc\/nix|(?:~|\$HOME|\$\{HOME\})\/\.config\/nix)\/nix\.conf$/.test(target)) return [];
  if ((target.startsWith("~") && (sink?.[1] !== undefined || sink?.[2] !== undefined)) ||
      (target.startsWith("$") && sink?.[2] !== undefined)) return [];
  const words = shellWords(command);
  if (words[0] !== "echo" && words[0] !== "printf") return [];
  let text: string;
  if (words[0] === "printf") {
    if (words[1] === "%s\\n") text = words.slice(2).join("\n");
    else if (words.length === 2 && !words[1]?.includes("%")) text = (words[1] ?? "").replace(/\\n/g, "\n");
    else return [];
  } else {
    const args = words.slice(1);
    if (/^-[neE]+$/.test(args[0] ?? "")) return [];
    text = args.join(" ");
    if (text.includes("\\")) return [];
  }
  if (/[$`]/.test(text)) return [];
  return parseNixConf(text, path, line, "shell").map((setting) => ({ ...setting, line }));
}

const HOSTED_LABEL = /^(?:ubuntu-(?:latest|\d{2}\.\d{2})(?:-arm)?|macos-(?:latest|\d+)(?:-intel|-large|-xlarge)?|windows-(?:latest|\d{4})(?:-arm)?)$/i;

function matrixLabels(job: JobModel, label: string): string[] {
  const key = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(label)?.[1];
  if (!key) return [label];
  const matrix = job.matrix ?? {};
  const listed = matrix[key];
  const included = Array.isArray(matrix.include)
    ? matrix.include.flatMap((entry: unknown) => (entry && typeof entry === "object" && key in entry ? [(entry as Record<string, unknown>)[key]] : []))
    : [];
  const values = [...(Array.isArray(listed) ? (listed as unknown[]) : listed === undefined ? [] : [listed]), ...included];
  return values.length > 0 && values.every((value) => typeof value === "string") ? (values as string[]) : [label];
}

/** `runs-on` labels with `${{ matrix.<key> }}` resolved to the matrix values (and `include` entries) when they are literal. */
export function runnerLabels(job: JobModel): string[] {
  return jobRunsOnLabels(job).flatMap((label) => matrixLabels(job, label));
}

/**
 * True when every `runs-on` label (matrix values resolved) names a standard GitHub-hosted image such as
 * `ubuntu-24.04` or `macos-latest`. Self-hosted, custom-label and unresolvable expressions return false.
 */
export function isGitHubHosted(job: JobModel): boolean {
  const labels = runnerLabels(job);
  return labels.length > 0 && labels.every((label) => HOSTED_LABEL.test(label));
}

export type NixCommand = JobCommand & { nix?: NixInvocation };

/** Nix-related view of a job: installers, cache actions, and Nix commands (composite actions expanded). */
export interface NixJob {
  workflow: WorkflowModel;
  job: JobModel;
  installers: StepModel[];
  entries: ExpandedStep[];
  caches: StepModel[];
  /** Every run command of the job, annotated with its Nix invocation when it is one. */
  commands: NixCommand[];
  /** True when the workflow, job, or a step runs commands through `nix develop`/`nix-shell` via `shell:`. */
  nixShell: boolean;
  /**
   * Observed settings, NOT the effective job configuration. Step env and CLI settings are command-local.
   * Use effectiveNixConf when a diagnostic depends on the configuration of a particular invocation.
   */
  conf: NixConfSetting[];
  /** The workflow source, for `# vX` comments on SHA-pinned actions. */
  file?: SourceFile;
}

const NIX_SHELL = /\bnix(\s+develop|-shell)\b/;

export function nixJob(project: ProjectModel, workflow: WorkflowModel, job: JobModel): NixJob {
  const entries = expandedJobSteps(project, workflow, job);
  const installers = entries.map((entry) => entry.step).filter((step) => NIX_INSTALLER_ACTIONS.has(step.uses?.action.name ?? ""));
  const caches = entries.map((entry) => entry.step).filter((step) => usesAction(step, ...NIX_CACHE_ACTIONS));
  const commands: NixCommand[] = jobCommands(project, workflow, job).map((entry) => {
    const nix = nixInvocation(entry.command, entry.line);
    return nix ? { ...entry, nix } : entry;
  });
  const nixShell =
    NIX_SHELL.test(workflow.shell ?? "") || NIX_SHELL.test(job.shell ?? "") || job.steps.some((step) => NIX_SHELL.test(step.shell ?? ""));
  const conf = [
    ...envConf(workflow.env, workflow.path, workflow.triggersLine),
    ...envConf(job.env, workflow.path, job.line),
    ...installers.flatMap((step) => installerConf(step, workflow.path)),
    ...job.steps.flatMap((step) => envConf(step.env, workflow.path, step.line)),
    ...commands.flatMap((entry) => (entry.nix ? cliConf(entry.nix, entry.path) : shellConfWrites(entry.command, entry.path, entry.line))),
  ];
  const file = project.files.get(workflow.path);
  return { workflow, job, installers, entries, caches, commands, nixShell, conf, ...(file ? { file } : {}) };
}

/** Jobs that install or invoke Nix. */
export function* nixJobs(project: ProjectModel): Generator<NixJob> {
  for (const workflow of project.workflows) {
    for (const job of workflow.jobs) {
      const model = nixJob(project, workflow, job);
      if (model.installers.length > 0 || model.nixShell || model.commands.some((entry) => entry.nix)) yield model;
    }
  }
}

/** Every Nix invocation across workflows (composite actions expanded). */
export function* nixInvocations(project: ProjectModel): Generator<{ job: NixJob; entry: NixCommand; nix: NixInvocation }> {
  for (const job of nixJobs(project)) {
    for (const entry of job.commands) if (entry.nix) yield { job, entry, nix: entry.nix };
  }
}

/** Installer steps across all workflows. */
export function* installerSteps(project: ProjectModel): Generator<{ workflow: WorkflowModel; job: JobModel; step: StepModel }> {
  for (const entry of steps(project.workflows)) {
    if (NIX_INSTALLER_ACTIONS.has(entry.step.uses?.action.name ?? "")) yield entry;
  }
}

/** Settings named `key` (and `extra-key` when `extra` is true), in file order. */
export function confValues(conf: NixConfSetting[], key: string, extra = false): NixConfSetting[] {
  return conf.filter((setting) => setting.key === key || (extra && setting.key === `extra-${key}`));
}

export function isTruthyConf(value: string): boolean {
  return /^(true|1|yes)$/i.test(value.trim());
}

export function isFalsyConf(value: string): boolean {
  return /^(false|0|no)$/i.test(value.trim());
}

/** A Nix command in a workflow job or a composite action, reported once even when an action is used by many jobs. */
export interface NixCommandSite {
  path: string;
  line: number;
  nix: NixInvocation;
  step: StepModel;
  /** The workflow (or composite action) that owns the job context. */
  workflow: WorkflowModel;
  /** The workflow job running the command; undefined for composite actions that no workflow job uses. */
  job?: NixJob;
}

/** Every Nix invocation in workflows (composite actions expanded) and in composite actions themselves, deduplicated. */
export function* nixCommandSites(project: ProjectModel): Generator<NixCommandSite> {
  const seen = new Set<string>();
  for (const { job, entry, nix } of nixInvocations(project)) {
    const key = `${entry.path}:${entry.line}:${entry.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    yield { path: entry.path, line: entry.line, nix, step: entry.step, workflow: job.workflow, job };
  }
  for (const action of project.actions) {
    for (const job of action.jobs) {
      for (const step of job.steps) {
        for (const { command, line } of commandsOf(step)) {
          const nix = nixInvocation(command, line);
          const key = `${action.path}:${line}:${command}`;
          if (!nix || seen.has(key)) continue;
          seen.add(key);
          yield { path: action.path, line, nix, step, workflow: action };
        }
      }
    }
  }
}

/** The value of `name` a step sees: step env, else job env, else workflow env. */
export function envValue(workflow: WorkflowModel, job: JobModel | undefined, step: StepModel | undefined, name: string): unknown {
  for (const env of [step?.env, job?.env, workflow.env]) {
    if (env && name in env) return env[name];
  }
  return undefined;
}

const PR_HEAD_REF = /pull_request\.head\.|\bhead_ref\b|refs\/pull\//;

/**
 * The trigger under which a job evaluates code from an unreviewed pull request: `pull_request` (the PR's merge commit),
 * or `pull_request_target` when the job checks out the PR head (checkout `ref`/`repository`, `gh pr checkout`, or a
 * `git fetch/checkout` of the head ref). `merge_group` runs reviewed code and is not returned.
 */
export function untrustedPrTrigger(project: ProjectModel, workflow: WorkflowModel, job: JobModel): "pull_request" | "pull_request_target" | undefined {
  if (hasTrigger(workflow, "pull_request")) return "pull_request";
  if (!hasTrigger(workflow, "pull_request_target")) return undefined;
  const checksOutHead = job.steps.some((step) => {
    if (!usesAction(step, "actions/checkout")) return false;
    return ["ref", "repository"].some((input) => PR_HEAD_REF.test(String(step.with.get(input)?.value ?? "")));
  });
  const fetchesHead = jobCommands(project, workflow, job).some(
    ({ command }) => /\bgh\s+pr\s+checkout\b/.test(command) || (/\bgit\s+(?:fetch|checkout|switch)\b/.test(command) && PR_HEAD_REF.test(command)),
  );
  return checksOutHead || fetchesHead ? "pull_request_target" : undefined;
}

/** How a job came to accept `nixConfig` from flakes it evaluates. */
export interface FlakeConfigTrust {
  path: string;
  line: number;
  /** `implicit` is nix-quick-install-action, which appends `accept-flake-config = true` after its `nix_conf` input. */
  via: NixConfSetting["source"] | "implicit";
  /** The deciding setting; undefined for implicit trust. */
  setting?: NixConfSetting;
  /** The quick-install step, for implicit trust. */
  step?: StepModel;
}

export const QUICK_INSTALL = "nixbuild/nix-quick-install-action";

/**
 * True when a nix-quick-install-action step appends `accept-flake-config = true` to nix.conf after its `nix_conf`
 * input: inspected release families v25–v35 do so for Nix newer than 2.13; v20–v24 do not.
 * Uncommented SHA pins, other releases and moving refs remain unknown, not false.
 */
export function quickInstallTrusts(step: StepModel, file?: SourceFile): boolean | undefined {
  if (!usesAction(step, QUICK_INSTALL)) return false;
  const release = actionVersion(step, file);
  if (!release || release.major < 20 || release.major > 35) return undefined;
  if (release.major < 25) return false;
  const version = step.with.get("nix_version");
  if (!version) return true;
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(version.value).trim());
  if (!match) return undefined;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  return major > 2 || (major === 2 && (minor > 13 || (minor === 13 && patch > 0)));
}

/**
 * True when a job's `if:` keeps it from running for `trigger`, or keeps fork pull requests out
 * (`head.repo.full_name == github.repository`, `!head.repo.fork`, `head.repo.fork == false`). A condition with `||`
 * is not trusted to exclude anything except through the fork checks.
 */
export function excludesUntrustedPr(job: Pick<JobModel, "if">, trigger: string): boolean {
  const condition = job.if ?? "";
  if (condition.includes("||") || /!\s*\(|==\s*false\s*\)?\s*==/.test(condition)) return false;
  if (/github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository\b/.test(condition)) return true;
  if (/(?:!\s*github\.event\.pull_request\.head\.repo\.fork\b|github\.event\.pull_request\.head\.repo\.fork\s*==\s*false\b)/.test(condition)) return true;
  if (new RegExp(`github\\.event_name\\s*!=\\s*['"]${trigger}['"]`).test(condition)) return true;
  const equals = [...condition.matchAll(/github\.event_name\s*==\s*['"]([\w-]+)['"]/g)].map((match) => match[1]);
  return equals.length > 0 && !equals.includes(trigger);
}

export function stepIsSkipped(entry: ExpandedStep): boolean {
  return [entry.step.if, entry.owner.if].some((condition) => /^\s*(?:\$\{\{\s*)?false(?:\s*\}\})?\s*$/.test(condition ?? ""));
}

/**
 * Where a job accepts flake `nixConfig` for the flake commands it runs. Per command, the effective value follows Nix
 * precedence: CLI flags (`--accept-flake-config`, `--option accept-flake-config ...`) override `NIX_CONFIG` (the
 * step's, else the job's, else the workflow's), which overrides nix.conf (installer inputs, shell writes, and
 * nix-quick-install-action's implicit `accept-flake-config = true`). Classic `nix-build`/`nix-shell` do not read flake
 * configuration and are ignored; a `shell: nix develop ...` counts as a flake command for each `run:` step.
 */
/** Settings visible at one command, following installer/write order and file < environment < CLI precedence. */
export function effectiveNixConf(model: NixJob, site: NixCommand, nix: NixInvocation): NixConfSetting[] | undefined {
  const { workflow, job } = model;
  // develop/shell can replace the child's environment. Outer CLI settings are not a child configuration proof.
  if (site.nix && site.nix.command !== nix.command) return undefined;
  const allTokens = shellTokens(site.command);
  const prefixTokens = allTokens.slice(0, allTokens.length - commandTokens(site.command).length);
  const assignments = prefixAssignments(site.command);
  if (prefixTokens.some((token) => ["sudo", "su", "doas"].includes(token.value)) ||
      (prefixTokens.some((token) => token.value === "env") &&
        prefixTokens.some((token) => token.value.startsWith("-") && token.value !== "--"))) return undefined;
  if (["NIX_CONF_DIR", "NIX_USER_CONF_FILES", "XDG_CONFIG_HOME", "HOME"].some((key) =>
    assignments.has(key) || envValue(workflow, job, site.step, key) !== undefined || site.owner.env[key] !== undefined,
  )) return undefined;
  const settings: NixConfSetting[] = [];
  let installers = 0;
  let env = envValue(workflow, job, undefined, "NIX_CONFIG");
  let envPath = workflow.path;
  let envLine = job.env.NIX_CONFIG !== undefined ? job.line : workflow.triggersLine;
  for (const entry of model.entries) {
    const same = entry.step === site.step && entry.owner === site.owner;
    if (same) break;
    if (stepIsSkipped(entry)) continue;
    if (NIX_INSTALLER_ACTIONS.has(entry.step.uses?.action.name ?? "") && ++installers > 1) return undefined;
    if (quickInstallTrusts(entry.step, entry.direct ? model.file : undefined) === undefined) return undefined;
    const conf = installerConf(entry.step, entry.path);
    if ((entry.step.if || entry.owner.if) && (conf.length > 0 || quickInstallTrusts(entry.step, entry.direct ? model.file : undefined))) return undefined;
    if ((NIX_CONF_INPUTS[entry.step.uses?.action.name ?? ""] ?? [])
      .some((key) => /[$`]|^\s*!?include\s/m.test(String(entry.step.with.get(key)?.value ?? "")))) return undefined;
    if (conf.some((setting) => /[$`]/.test(setting.value))) return undefined;
    settings.push(...conf);
    if (quickInstallTrusts(entry.step, entry.direct ? model.file : undefined)) {
      settings.push({ key: "accept-flake-config", value: "true", path: entry.path, line: stepLine(entry.step), source: "installer", implicitStep: entry.step });
    }
    for (const command of model.commands.filter((item) => item.step === entry.step && item.owner === entry.owner)) {
      if (["source", ".", "eval"].includes(shellWords(command.command)[0] ?? "")) return undefined;
      if (shellTokens(command.command).length === 0 && /\b(?:NIX_CONFIG|NIX_CONF_DIR|NIX_USER_CONF_FILES|XDG_CONFIG_HOME|HOME)\b/.test(command.command)) return undefined;
      const written = shellConfWrites(command.command, command.path, command.line);
      if (NIX_CONF_WRITE.test(command.command) && (!/>>|\btee\s+-a\b/.test(command.command) || written.length === 0)) return undefined;
      if (written.length > 0 && (entry.step.if || entry.owner.if ||
          /(?:^|[\n;])\s*(?:if|then|elif|else|case|for|while|until)\b|\|\|/.test(entry.step.run?.value ?? "") ||
          written.some((setting) => /[$`]/.test(setting.value)))) return undefined;
      settings.push(...written);
      if (/\bGITHUB_ENV\b/.test(command.command)) {
        // External/multi-line environment-file writes can change both settings and config search paths.
        return undefined;
      }
    }
  }
  for (const [scope, path, line] of [
    [site.owner.env, workflow.path, site.owner.line],
    [site.step.env, site.path, site.step.line],
  ] as const) {
    if (scope.NIX_CONFIG !== undefined) {
      env = scope.NIX_CONFIG;
      envPath = path;
      envLine = line;
    }
  }
  for (const command of model.commands) {
    if (command === site || (command.step === site.step && command.owner === site.owner && site.command === "")) break;
    if (command.step !== site.step || command.owner !== site.owner) continue;
    if (["source", ".", "eval"].includes(shellWords(command.command)[0] ?? "")) return undefined;
    const written = shellConfWrites(command.command, command.path, command.line);
    if (NIX_CONF_WRITE.test(command.command) && (!/>>|\btee\s+-a\b/.test(command.command) || written.length === 0)) return undefined;
    if (/\|\||^\s*(?:if|then|elif|else|case|for|while|until)\b/.test(command.command) && /NIX_CONFIG|nix\.conf/.test(site.step.run?.value ?? "")) return undefined;
    settings.push(...written);
    const tokens = shellTokens(command.command);
    if (tokens.length === 0 && /\b(?:NIX_CONFIG|NIX_CONF_DIR|NIX_USER_CONF_FILES|XDG_CONFIG_HOME|HOME)\b/.test(command.command)) return undefined;
    if (["export", "unset"].includes(tokens[0]?.value ?? "") && tokens.slice(1).some((token) =>
      /^(?:NIX_CONF_DIR|NIX_USER_CONF_FILES|XDG_CONFIG_HOME|HOME)(?:=|$)/.test(token.value),
    )) return undefined;
    if (tokens[0]?.value === "export") {
      for (const token of tokens.slice(1)) {
        if (!token.value.startsWith("NIX_CONFIG=")) continue;
        env = token.value.slice("NIX_CONFIG=".length);
        envPath = site.path;
        envLine = command.line;
      }
    }
    if (tokens[0]?.value === "unset" && tokens.some((token) => token.value === "NIX_CONFIG")) return undefined;
  }
  const prefix = assignments.get("NIX_CONFIG");
  if (prefix !== undefined) {
    env = prefix;
    envPath = site.path;
    envLine = site.line;
  }
  if (env !== undefined && (typeof env !== "string" || /[$`]|^\s*!?include\s/m.test(env))) return undefined;
  settings.push(...envConf({ NIX_CONFIG: env }, envPath, envLine), ...cliConf(nix, site.path));
  if (settings.some((setting) => /[$`]/.test(setting.value))) return undefined;
  return settings;
}

const FLAKE_COMMANDS = new Set(["build", "develop", "run", "shell", "eval", "edit", "search", "repl", "print-dev-env", "fmt", "bundle", "flake check", "flake show", "flake metadata", "flake lock", "flake update", "flake archive", "profile install", "profile add"]);

export function flakeConfigTrust(model: NixJob, includeSite: (site: NixCommand) => boolean = () => true): FlakeConfigTrust[] {
  const { workflow, job } = model;
  const sites = [...model.commands];
  for (const entry of model.entries) {
    const shell = entry.step.shell ?? (entry.direct ? job.shell ?? workflow.shell : undefined);
    if (!entry.step.run || !shell) continue;
    const nix = nixInvocation(shell, entry.step.run.line);
    if (nix) sites.push({ ...entry, command: "", line: entry.step.run.line, nix });
  }
  const found = new Map<string, FlakeConfigTrust>();
  for (const site of sites) {
    if (!includeSite(site) || stepIsSkipped(site)) continue;
    if (!site.nix) continue;
    for (const nix of nestedInvocations(site.nix)) {
      if (nix.binary !== "nix" || !FLAKE_COMMANDS.has(nix.subcommand) || hasOption(nix, "--expr", "--file", "-f")) continue;
      const settings = effectiveNixConf(model, site, nix);
      if (!settings) continue;
      const setting = confValues(settings, "accept-flake-config").at(-1);
      if (!setting || !isTruthyConf(setting.value)) continue;
      const decision: FlakeConfigTrust = setting.implicitStep
        ? { path: setting.path, line: setting.line, via: "implicit", step: setting.implicitStep }
        : { path: setting.path, line: setting.line, via: setting.source, setting };
      found.set(`${decision.path}:${decision.line}:${decision.via}`, decision);
    }
  }
  return [...found.values()];
}

/** Branch names that move: nixpkgs channel branches (`nixos-unstable`, `nixos-24.11`, `nixpkgs-unstable`), release and staging branches, `master`/`main`. */
const FLOATING_BRANCH = /^(?:master|main|nixos-[\w.-]+|nixpkgs-[\w.-]+|release-[\w.-]+|staging(?:-[\w.-]+)?)$/;

/** Why a Nix source moves over time. `indirect` sources depend on the flake registry, which a job can pin. */
export interface FloatingSource {
  reason: string;
  indirect: boolean;
}

/**
 * Explains why a nixpkgs flake reference follows a moving branch: the indirect `nixpkgs` registry entry (the global
 * registry maps it to `github:NixOS/nixpkgs/nixpkgs-unstable`), `nixpkgs/<branch>`, or `github:NixOS/nixpkgs[/<branch>]`.
 * Undefined for commits, `rev=`/`narHash=` pins, tags, other flakes, and expressions it cannot read (`$VAR`).
 */
export function floatingFlakeRef(ref: string): FloatingSource | undefined {
  const text = unquote(ref.trim())
    .replace(/^flake:/, "")
    .replace(/#.*$/, "");
  if (!text || text.includes("$")) return undefined;
  const [base = "", query = ""] = text.split("?", 2);
  const params = new URLSearchParams(query);
  if (params.has("rev") || params.has("narHash")) return undefined;
  if (/^(?:tarball\+)?https?:\/\//.test(base)) return floatingNixSource(base.replace(/^tarball\+/, ""));
  const indirect = /^nixpkgs(?:\/([^/]+))?$/.exec(base);
  const github = /^github:nixos\/nixpkgs(?:\/([^/]+))?$/i.exec(base);
  const match = indirect ?? github;
  if (!match) return undefined;
  const branch = match[1] ?? params.get("ref") ?? undefined;
  if (branch === undefined) {
    return indirect
      ? { reason: "the flake registry's `nixpkgs` entry, which the global registry points at the nixpkgs-unstable branch", indirect: true }
      : { reason: "the default branch of github:NixOS/nixpkgs", indirect: false };
  }
  if (!FLOATING_BRANCH.test(branch)) return undefined;
  return { reason: `the ${branch} branch of nixpkgs${indirect ? " (via the flake registry)" : ""}`, indirect: Boolean(indirect) };
}

/**
 * Explains why a Nix expression source (a `-I`/`NIX_PATH` value, a `nix-channel --add` URL, a `nix-env -f` argument)
 * follows a moving target: `channel:<name>`, a nixos.org channel URL, a GitHub branch tarball
 * (`.../archive/nixos-unstable.tar.gz`), or a `flake:` reference to a moving nixpkgs branch. Undefined for commit
 * tarballs, local paths, other URLs and expressions it cannot read.
 */
export function floatingNixSource(value: string): FloatingSource | undefined {
  const text = unquote(value.trim());
  if (!text || text.includes("$")) return undefined;
  const channel = /^channel:([\w.-]+)$/.exec(text);
  if (channel?.[1]) return { reason: `the ${channel[1]} channel`, indirect: false };
  if (text.startsWith("flake:")) return floatingFlakeRef(text);
  const channelUrl = /^https?:\/\/(?:nixos\.org\/channels|channels\.nixos\.org)\/([\w.-]+)/.exec(text);
  if (channelUrl?.[1]) return { reason: `the ${channelUrl[1]} channel`, indirect: false };
  const archive = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:archive|tarball)\/(?:refs\/heads\/)?([\w.-]+?)(?:\.tar\.gz|\.zip)?$/.exec(text);
  if (archive?.[1] && archive[2] && FLOATING_BRANCH.test(archive[2])) {
    return { reason: `the ${archive[2]} branch of ${archive[1]}`, indirect: false };
  }
  return undefined;
}

/**
 * The value of the `name=` entry in a Nix search path (`NIX_PATH`, the `nix-path` setting, an `-I` argument). Entries
 * are separated by `:` (URLs keep their `://`) or whitespace; the first matching entry wins, as in lookup order.
 */
export function nixPathEntry(nixPath: string, name: string): string | undefined {
  for (const entry of nixPath.trim().split(/\s+|:(?=[\w.-]+=|\/(?!\/))/)) {
    if (entry.startsWith(`${name}=`)) return entry.slice(name.length + 1);
  }
  return undefined;
}

/** Where `<nixpkgs>` comes from for a classic command. */
export interface NixpkgsSource {
  /** The `nixpkgs=` value, e.g. `channel:nixos-unstable` or `flake:nixpkgs`. */
  value: string;
  /** Human-readable origin, e.g. "`-I nixpkgs=`" or "the job's `NIX_PATH`". */
  origin: string;
  path: string;
  line: number;
}

const DETERMINATE_INSTALLERS = ["determinatesystems/nix-installer-action", "determinatesystems/determinate-nix-action"];
const PREFIX_COMMANDS = new Set(["sudo", "time", "env", "exec", "command", "nice", "nohup"]);

/** Commands preceding this invocation in its job/composite context. */
export function siteCommands(project: ProjectModel, site: NixCommandSite): Array<{ command: string; line: number; path: string }> {
  if (site.job) {
    const position = site.job.commands.findIndex((entry) => entry.nix === site.nix && entry.step === site.step);
    return site.job.commands.slice(0, Math.max(0, position));
  }
  const action = project.actions.find((candidate) => candidate.path === site.path);
  const commands = (action?.jobs ?? []).flatMap((job) => job.steps.flatMap((step) => commandsOf(step).map((entry) => ({ ...entry, path: site.path }))));
  const position = commands.findIndex((entry) => entry.line === site.line && entry.command === site.nix.command);
  return commands.slice(0, Math.max(0, position));
}

/** `NAME=value` words written before the program on a command line (`NIX_PATH=... nix-shell`, `env NIX_PATH=... nix-shell`). */
function prefixAssignments(command: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const token of shellTokens(command)) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(token.value);
    if (assignment?.[1]) found.set(assignment[1], assignment[2] ?? "");
    else if (!PREFIX_COMMANDS.has(token.value) && !token.value.startsWith("-")) break;
  }
  return found;
}

/**
 * What `<nixpkgs>` resolves to for the classic command `chain[depth]` at `site` (`nix-shell -p`, `nix-env -f '<nixpkgs>'`),
 * following Nix's lookup order: the first `-I` entry, then `NIX_PATH` (a command prefix, else step, job, workflow env,
 * else cachix/install-nix-action's `nix_path` input, which exports it), then the `nix-path`/`extra-nix-path` settings,
 * then a Determinate installer's `extra-nix-path = nixpkgs=flake:nixpkgs`. Undefined when that cannot be read
 * statically: a non-`nixpkgs=` `-I` entry, `--nix-path`, a `NIX_PATH` value without a `nixpkgs` entry, `NIX_PATH`
 * exported or channels managed by another command, or a command nested in `nix develop`/`nix-shell`, whose environment
 * may set `NIX_PATH`. Without any of these the lookup falls back to channels, which these installers do not create.
 */
export function nixpkgsSearchPath(project: ProjectModel, site: NixCommandSite, chain: NixInvocation[], depth: number): NixpkgsSource | undefined {
  const nix = chain[depth];
  if (!nix) return undefined;
  const includes: string[] = [];
  nix.args.forEach((word, index) => {
    if (word === "-I" || word === "--include") includes.push(nix.args[index + 1] ?? "");
    else if (word.startsWith("--include=")) includes.push(word.slice("--include=".length));
    else if (/^-I./.test(word)) includes.push(word.slice(2));
  });
  for (const entry of includes) {
    // A bare directory entry may contain a `nixpkgs` subdirectory; other `name=` entries do not affect `<nixpkgs>`.
    if (!entry.includes("=")) return undefined;
    if (entry.startsWith("nixpkgs=")) {
      const value = entry.slice("nixpkgs=".length);
      return value ? { value, origin: "`-I nixpkgs=`", path: site.path, line: nix.line } : undefined;
    }
  }
  if (hasFlag(nix, "--nix-path", "--extra-nix-path") || cliConf(nix, site.path).some((setting) => /^(extra-)?nix-path$/.test(setting.key))) {
    return undefined;
  }
  if (chain.slice(0, depth).some((outer) => outer.subcommand === "develop" || outer.binary === "nix-shell")) return undefined;
  const fromPath = (nixPath: unknown, origin: string, path: string, line: number): NixpkgsSource | undefined => {
    if (typeof nixPath !== "string") return undefined;
    const value = nixPathEntry(nixPath, "nixpkgs");
    return value ? { value, origin, path, line } : undefined;
  };
  for (const outer of chain.slice(0, depth + 1).reverse()) {
    const prefix = prefixAssignments(outer.command).get("NIX_PATH");
    if (prefix !== undefined) return fromPath(prefix, "the `NIX_PATH=` command prefix", site.path, nix.line);
  }
  const { workflow, step } = site;
  const job = site.job?.job;
  for (const [env, label, line] of [
    [step.env, "the step's `NIX_PATH`", step.line],
    [job?.env, "the job's `NIX_PATH`", job?.line ?? 0],
    [workflow.env, "the workflow's `NIX_PATH`", workflow.triggersLine],
  ] as const) {
    if (env && "NIX_PATH" in env) {
      const path = env === step.env ? site.path : workflow.path;
      return fromPath(env.NIX_PATH, label, path, line);
    }
  }
  const others = siteCommands(project, site).filter((entry) => !(entry.line === nix.line && entry.command === chain[0]?.command));
  if (others.some(({ command }) => /\bNIX_PATH\b|\bnix-channel\b/.test(command))) return undefined;
  const selected = site.job?.commands.find((candidate) => candidate.nix === chain[0] && candidate.step === site.step);
  const position = selected ? site.job?.entries.findIndex((entry) => entry.step === selected.step && entry.owner === selected.owner) : undefined;
  const prior = site.job?.entries.slice(0, Math.max(0, position ?? 0)) ?? [];
  if (prior.some(({ step, owner }) => (step.if || owner.if) && NIX_INSTALLER_ACTIONS.has(step.uses?.action.name ?? ""))) return undefined;
  const installers = prior.filter(({ step }) => NIX_INSTALLER_ACTIONS.has(step.uses?.action.name ?? "")).map(({ step }) => step).reverse();
  for (const installer of installers) {
    const input = usesAction(installer, "cachix/install-nix-action") ? installer.with.get("nix_path") : undefined;
    if (input && String(input.value).trim()) return fromPath(String(input.value), "install-nix-action's `nix_path` input", workflow.path, input.line);
  }
  const entry = selected;
  const conf = site.job && entry ? effectiveNixConf(site.job, entry, nix) : undefined;
  if (conf === undefined) return undefined;
  const nixPath = confValues(conf, "nix-path").at(-1) ?? confValues(conf, "extra-nix-path").at(-1);
  if (nixPath) return fromPath(nixPath.value, `the \`${nixPath.key}\` setting`, nixPath.path, nixPath.line);
  const determinate = installers.find((installer) => usesAction(installer, ...DETERMINATE_INSTALLERS));
  if (determinate) {
    return { value: "flake:nixpkgs", origin: "the Determinate installer's `extra-nix-path = nixpkgs=flake:nixpkgs`", path: workflow.path, line: stepLine(determinate) };
  }
  return undefined;
}

/** Options that make an invocation resolve flake references without the global registry. */
const REGISTRY_OPTIONS = ["--inputs-from", "--override-flake", "--override-input", "--flake-registry", "--no-use-registries", "--no-registries"];

/** True when the invocation redirects registry lookups, or its installables are attributes of `--file`/`--expr`. */
export function bypassesRegistry(nix: NixInvocation): boolean {
  return (
    hasFlag(nix, ...REGISTRY_OPTIONS, "--file", "-f", "--expr") ||
    cliConf(nix, "").some((setting) => setting.key === "flake-registry" || (setting.key === "use-registries" && isFalsyConf(setting.value)))
  );
}

/**
 * True when indirect flake references at `site` resolve through the default global registry: a workflow job on a
 * GitHub-hosted runner or with a Nix installer, that neither runs `nix registry add/pin` nor sets `flake-registry`.
 * Self-hosted machines often pin `nixpkgs` in their system registry, so they are not assumed.
 */
export function usesGlobalRegistry(project: ProjectModel, site: NixCommandSite): boolean {
  const model = site.job;
  if (!model || !(isGitHubHosted(model.job) || model.installers.length > 0)) return false;
  const entry = model.commands.find((candidate) => candidate.nix === site.nix && candidate.step === site.step);
  const conf = entry ? effectiveNixConf(model, entry, site.nix) : undefined;
  if (!conf || conf.some((setting) => setting.key === "flake-registry" || setting.key === "use-registries")) return false;
  return !siteCommands(project, site).some(({ command }) => {
    const nix = nixInvocation(command, 0);
    return nix ? nestedInvocations(nix).some((entry) => /^registry (add|pin)$/.test(entry.subcommand)) : false;
  });
}
