import { commandsOf, defineRule, expandedJobSteps } from "../helpers.js";
import type { ProjectModel } from "../../project.js";
import type { JobModel, StepModel } from "../../parsers/workflow.js";
import type { ReportDescriptor } from "../../types.js";
import { attrsetOf, callArgument, enclosingOpen, lintableNixFiles } from "./expr.js";
import {
  NIX_CONF_INPUTS,
  cliConf,
  envConf,
  effectiveNixConf,
  hasOption,
  installerConf,
  nestedInvocations,
  nixInvocation,
  nixJobs,
  runnerLabels,
  shellConfWrites,
  type NixConfSetting,
  type NixInvocation,
} from "./shared.js";

/** `sandbox` and its deprecated aliases. */
const SANDBOX_KEYS = new Set(["sandbox", "build-use-sandbox", "build-use-chroot"]);

export type WeakSandbox = "false" | "relaxed";

/** The weakened mode a `sandbox` value selects. Nix accepts exactly `true`, `relaxed` and `false`. */
export function sandboxMode(value: string): WeakSandbox | undefined {
  const text = value
    .trim()
    .replace(/;$/, "")
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim();
  return text === "false" || text === "relaxed" ? text : undefined;
}

/** A `sandbox` setting found in CI, with a description of where it is set and the replacement for that place. */
interface Found {
  setting: NixConfSetting;
  mode: WeakSandbox;
  /** How the setting is written, when not `key = value` (a command-line flag). */
  written?: string;
  where: string;
  fix: string;
}

const NIX_CONFIG_KEY = /^(\s*)["']?NIX_CONFIG["']?\s*:/;

/**
 * `envConf` reports every `NIX_CONFIG` setting at its scope's anchor line; this finds the setting's own line inside the
 * first `NIX_CONFIG` value at or after `from` (falling back to the anchor).
 */
function settingLine(project: ProjectModel, setting: NixConfSetting, from: number): number {
  const content = project.files.get(setting.path)?.content;
  if (content === undefined || setting.source !== "env") return setting.line;
  const lines = content.split("\n").map((text) => text.replace(/\r$/, ""));
  const start = lines.findIndex((text, index) => index + 1 >= from && NIX_CONFIG_KEY.test(text));
  if (start < 0) return setting.line;
  const indent = NIX_CONFIG_KEY.exec(lines[start] ?? "")?.[1]?.length ?? 0;
  const key = new RegExp(`(?:^|[\\s"':|])${setting.key}\\s*=`);
  for (let index = start; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    if (index > start && text.trim() !== "" && text.length - text.trimStart().length <= indent) break;
    if (key.test(index === start ? text.replace(NIX_CONFIG_KEY, " ") : text)) return index + 1;
  }
  return setting.line;
}

/** The command with the flags that weaken the sandbox removed. */
export function withoutSandboxFlags(command: string): string {
  return command
    .replace(/\s+--(?:extra-)?option\s+(?:sandbox|build-use-sandbox|build-use-chroot)\s+["']?(?:false|relaxed)["']?(?=\s|$)/g, "")
    .replace(/\s+--(?:no|relaxed)-sandbox(?=\s|$)/g, "")
    .trim();
}

function describe(invocation: NixInvocation): string {
  return `\`${[invocation.binary, invocation.subcommand].filter(Boolean).join(" ")}\``;
}

/** How the setting is spelled on the command line, e.g. `--no-sandbox` or `--option sandbox false`. */
function cliFlag(invocation: NixInvocation, setting: NixConfSetting): string {
  const flag = setting.value === "false" ? "--no-sandbox" : "--relaxed-sandbox";
  return invocation.args.includes(flag) ? flag : `--option ${setting.key} ${setting.value}`;
}

function weak(settings: NixConfSetting[]): Array<{ setting: NixConfSetting; mode: WeakSandbox }> {
  return settings.flatMap((setting) => {
    const mode = SANDBOX_KEYS.has(setting.key) ? sandboxMode(setting.value) : undefined;
    return mode ? [{ setting, mode }] : [];
  });
}

function envFound(env: Record<string, unknown>, path: string, line: number, scope: string): Found[] {
  return weak(envConf(env, path, line)).map(({ setting, mode }) => ({
    setting,
    mode,
    where: `${scope} \`NIX_CONFIG\``,
    fix: "Delete the line from `NIX_CONFIG` (the default is `sandbox = true` on Linux), or state it explicitly:\nenv:\n  NIX_CONFIG: |\n    sandbox = true",
  }));
}

/** Weak `sandbox` settings a step applies: installer config, step `NIX_CONFIG`, command-line flags and nix.conf writes. */
function stepFound(step: StepModel, path: string): Found[] {
  const action = step.uses?.action.name ?? "";
  const input = (NIX_CONF_INPUTS[action] ?? []).find((name) => typeof step.with.get(name)?.value === "string");
  const installer = weak(installerConf(step, path)).map(({ setting, mode }) => ({
    setting,
    mode,
    where: `the \`${input ?? "nix.conf"}\` input of ${action}`,
    fix: `Delete \`${setting.key} = ${setting.value}\` from \`${input ?? "nix.conf"}\` (the installer keeps the Linux default, \`sandbox = true\`), or state it explicitly:\nwith:\n  ${input ?? "extra_nix_config"}: |\n    sandbox = true`,
  }));
  const commands = commandsOf(step).flatMap(({ command, line }) => {
    const nix = nixInvocation(command, line);
    if (!nix) {
      return weak(shellConfWrites(command, path, line)).map(({ setting, mode }) => ({
        setting,
        mode,
        where: "a shell write to nix.conf",
        fix: "Delete the command that appends the setting to nix.conf; the default is `sandbox = true` on Linux.",
      }));
    }
    return nestedInvocations(nix).flatMap((invocation) =>
      weak(cliConf(invocation, path)).map(({ setting, mode }) => ({
        setting,
        mode,
        written: cliFlag(invocation, setting),
        where: `the ${describe(invocation)} command line`,
        fix: `Drop the flag so the build runs sandboxed:\nrun: ${withoutSandboxFlags(command)}`,
      })),
    );
  });
  return [...installer, ...envFound(step.env, path, step.line, "step"), ...commands];
}

/**
 * macOS has a different default; container namespace support is unknown from the image name alone.
 */
function sandboxIrrelevant(job: JobModel): boolean {
  if (job.containerImage) return true;
  const labels = runnerLabels(job);
  return labels.some((label) => /^macos/i.test(label)) && !labels.some((label) => /ubuntu|linux|nixos/i.test(label));
}

function confReport(project: ProjectModel, found: Found, from: number, confidence: "high" | "medium"): ReportDescriptor {
  const { setting, mode, where } = found;
  const written = found.written ?? `${setting.key} = ${setting.value}`;
  const effect =
    mode === "false"
      ? "requests that the Nix build sandbox be disabled for an inspected build command"
      : "requests relaxed sandboxing for an inspected build command, allowing fixed-output and __noChroot derivations outside the sandbox";
  return {
    path: setting.path,
    line: settingLine(project, setting, from),
    message: `\`${written}\` (set by ${where}) ${effect}. If the builder or trusted daemon honors it, undeclared host dependencies become possible. This observation does not establish that outputs differ or that a daemon accepted the request.`,
    suggestion: `Review the builder's isolation requirements and effective daemon policy before changing this setting. ${found.fix}\nPreserve other NIX_CONFIG entries and check later CLI overrides. Fetch network resources with reviewed fixed-output fetchers; if a host path is unavoidable, consider a narrowly scoped extra-sandbox-paths setting. Sandboxing alone is not a reproducibility proof.`,
    confidence,
  };
}

function flakeReports(project: ProjectModel): ReportDescriptor[] {
  return project.nix.flakes.flatMap((flake) => {
    const path = flake.nix?.path;
    if (!path || !flake.info) return [];
    return [...flake.info.nixConfig].flatMap(([key, entry]) => {
      const mode = SANDBOX_KEYS.has(key) ? sandboxMode(entry.raw) : undefined;
      if (!mode) return [];
      return [
        {
          path,
          line: entry.line,
          message: `\`nixConfig.${key} = ${entry.raw.replace(/;$/, "")}\` in ${path} asks consumers to ${mode === "false" ? "turn the build sandbox off" : "run `__noChroot` and fixed-output derivations outside the build sandbox"}. It only takes effect when accepted and honored by the installation; no actual impurity or daemon privilege is established by this declaration.`,
          suggestion: `Remove \`${key}\` from \`nixConfig\` in ${path}. Fetch network resources with a fixed-output fetcher (e.g. \`pkgs.fetchurl { url = "..."; hash = "sha256-..."; }\`), which keeps network access inside the sandbox, and leave sandbox policy to the machine's nix.conf.`,
          confidence: "medium" as const,
        },
      ];
    });
  });
}

const NO_CHROOT = /(?<![\w'-])__noChroot\s*=\s*true\s*;/g;

function noChrootReports(project: ProjectModel): ReportDescriptor[] {
  return lintableNixFiles(project).flatMap((file) => {
    const derivations = new Set(file.idents.filter((ident) => /(?:^|\.)(?:mkDerivation|derivation)$/.test(ident.text))
      .flatMap((ident) => {
        const argument = callArgument(file, ident);
        const open = argument ? attrsetOf(file, argument) : undefined;
        return open === undefined ? [] : [open];
      }));
    return [...file.masked.matchAll(NO_CHROOT)].filter((match) => derivations.has(enclosingOpen(file.masked, match.index))).map((match) => ({
      path: file.path,
      line: file.lineOf(match.index),
      message: `\`__noChroot = true\` in ${file.path} asks Nix to build this derivation outside the sandbox. With the Linux default \`sandbox = true\` Nix refuses the build ("derivation '…' has '__noChroot' set, but that's not allowed when 'sandbox' is 'true'"), so it only builds where \`sandbox = relaxed\` or \`false\` is configured, and there the builder reads the host filesystem and network while the output keeps the same store path.`,
      suggestion:
        'Remove `__noChroot` and declare what the build reaches for: download network resources with a fixed-output fetcher (`pkgs.fetchurl { url = "..."; hash = "sha256-..."; }`, or set `outputHash`/`outputHashMode` on the derivation), and add host tools as `nativeBuildInputs`. If a host path is unavoidable, expose only that path on the builders (`extra-sandbox-paths = /path/it/needs`) instead of disabling isolation.',
      confidence: "medium" as const,
    }));
  });
}

export default defineRule({
  meta: {
    id: "nix/sandbox-disabled",
    ruleset: "nix",
    description: "The Nix build sandbox is turned off or relaxed in CI, in flake nixConfig, or by `__noChroot`.",
    rationale:
      "Nix sandboxing restricts access to undeclared host state. Disabling or relaxing it can make additional inputs available, but does not establish that a derivation uses them or produces different bytes. Input-addressed store paths identify declared inputs, not a proof of deterministic output. This rule follows observed configuration precedence at build commands and also reports explicit flake requests and recognizable derivation __noChroot attributes. Restricted daemon settings, remote builders, unsupported shell code and container namespace support cannot be established statically. macOS and container jobs are conservatively omitted rather than assuming Linux defaults apply. No isolation change is automatic.",
    kind: "policy",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-sandbox",
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-sandbox-paths",
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-accept-flake-config",
    ],
    impact: "high",
    example: {
      bad: "- uses: cachix/install-nix-action@v31\n  with:\n    extra_nix_config: |\n      sandbox = false\n- run: nix build .#app",
      good: "- uses: cachix/install-nix-action@v31\n- run: nix build .#app",
    },
  },
  check({ project, report }) {
    const seen = new Set<string>();
    const emit = (found: Found, from: number, confidence: "high" | "medium"): void => {
      const key = `${found.setting.path}:${found.setting.line}:${found.setting.key}:${found.setting.source}`;
      if (seen.has(key)) return;
      seen.add(key);
      report({ ...confReport(project, found, from, confidence), key: `${key}:sandbox-disabled` });
    };
    for (const model of nixJobs(project)) {
      const { workflow, job } = model;
      const expanded = expandedJobSteps(project, workflow, job);
      if (sandboxIrrelevant(job)) continue;
      const effective = new Set<string>();
      const identity = (setting: NixConfSetting): string => `${setting.path}:${setting.line}:${setting.source}:${setting.key}:${setting.value}`;
      for (const site of model.commands) {
        if (!site.nix) continue;
        for (const invocation of nestedInvocations(site.nix)) {
          if (hasOption(invocation, "--dry-run", "--no-build") || (invocation.binary !== "nix-build" && !["build", "flake check", "develop", "run", "shell"].includes(invocation.subcommand))) continue;
          const last = effectiveNixConf(model, site, invocation)?.filter((setting) => SANDBOX_KEYS.has(setting.key)).at(-1);
          if (last) effective.add(identity(last));
        }
      }
      for (const found of envFound(workflow.env, workflow.path, workflow.triggersLine, "workflow")) if (effective.has(identity(found.setting))) emit(found, 1, "medium");
      for (const found of envFound(job.env, workflow.path, job.line, "job")) if (effective.has(identity(found.setting))) emit(found, job.line, "medium");
      for (const entry of expanded) {
        for (const found of stepFound(entry.step, entry.path)) if (effective.has(identity(found.setting))) emit(found, entry.step.line, "medium");
      }
    }
    for (const found of [...flakeReports(project), ...noChrootReports(project)]) {
      report({ ...found, key: `${found.path}:${found.line}:sandbox-disabled` });
    }
  },
});
