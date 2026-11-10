import { lineText } from "../../fix.js";
import type { SourceFile } from "../../types.js";
import { defineRule } from "../helpers.js";
import {
  NIX_CONF_INPUTS,
  cliConf,
  confValues,
  envConf,
  effectiveNixConf,
  hasOption,
  installerConf,
  nestedInvocations,
  nixJobs,
  runnerLabels,
  isGitHubHosted,
  shellConfWrites,
  type NixConfSetting,
} from "./shared.js";

const MAX_JOBS_KEYS = new Set(["max-jobs", "build-max-jobs"]);

interface Candidate {
  setting: NixConfSetting;
  /** Human description of where the value is set. */
  origin: string;
  /** For `NIX_CONFIG` values: the YAML block (by its first line) that holds the env value, or 0 for workflow-level env. */
  envAnchor?: number;
}

function lowJobs(value: string, max: number): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const jobs = Number(value.trim());
  return jobs >= 1 && jobs <= max ? jobs : undefined;
}

function blockLines(content: string, anchor: number): number[] {
  const lines = content.split(/\r?\n/);
  if (anchor <= 0) return lines.map((_, index) => index + 1);
  const indent = /^\s*/.exec(lines[anchor - 1] ?? "")?.[0].length ?? 0;
  const block: number[] = [];
  for (let index = anchor; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    if (text.trim() !== "" && (/^\s*/.exec(text)?.[0].length ?? 0) <= indent) break;
    block.push(index + 1);
  }
  return block;
}

/** The single line inside the env block that holds `max-jobs = <value>`, if it can be found unambiguously. */
function envLine(file: SourceFile, anchor: number, value: string): number | undefined {
  const pattern = new RegExp(`\\b(?:build-)?max-jobs\\s*=\\s*${value}\\b`);
  const matches = blockLines(file.content, anchor).filter((line) => pattern.test(lineText(file.content, line)));
  return matches.length === 1 ? matches[0] : undefined;
}

export default defineRule({
  meta: {
    id: "nix/max-jobs-pinned-low",
    ruleset: "nix",
    description: "Nix's `max-jobs` is pinned to a very small number on a GitHub-hosted runner.",
    rationale:
      "max-jobs limits concurrent local derivation builds; cores separately controls the parallelism a builder may use. A low explicit limit may leave capacity unused when independent uncached derivations are single-threaded. It can also be necessary to avoid memory exhaustion or oversubscription. This detector follows observed configuration precedence at build commands, but does not measure resource use, dependency parallelism or remote-daemon policy. Tune only after measuring representative builds.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: { max: 1 },
    validateOptions: (options) =>
      Object.entries(options)
        .filter(([key, value]) => key === "max" && (typeof value !== "number" || !Number.isInteger(value) || value < 1))
        .map(([key]) => `${key} must be a positive integer`),
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-max-jobs",
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-cores",
      "https://nix.dev/manual/nix/2.24/command-ref/opt-common#opt-max-jobs",
      "https://github.com/cachix/install-nix-action",
    ],
    impact: "medium",
    fixable: false,
    example: {
      bad: "- uses: cachix/install-nix-action@v31\n  with:\n    extra_nix_config: |\n      max-jobs = 1\n- run: nix build -j 1 .#default",
      good: "- uses: cachix/install-nix-action@v31\n  with:\n    extra_nix_config: |\n      max-jobs = auto\n- run: nix build .#default",
    },
  },
  check({ project, options, report }) {
    const max = options.max;
    const seen = new Set<string>();
    for (const model of nixJobs(project)) {
      const { workflow, job } = model;
      if (!isGitHubHosted(job) || runnerLabels(job).some((label) => label === "ubuntu-slim")) continue;

      const settings: Candidate[] = [
        ...envConf(workflow.env, workflow.path, workflow.triggersLine).map((setting) => ({ setting, origin: "the workflow's `NIX_CONFIG`", envAnchor: 0 })),
        ...envConf(job.env, workflow.path, job.line).map((setting) => ({ setting, origin: "the job's `NIX_CONFIG`", envAnchor: job.line })),
        ...model.installers.flatMap((step) => {
          const name = step.uses?.action.name ?? "";
          const input = NIX_CONF_INPUTS[name]?.[0] ?? "nix.conf";
          return installerConf(step, workflow.path).map((setting) => ({ setting, origin: `the \`${input}\` input of ${step.uses?.action.name ?? "the installer"}` }));
        }),
        ...job.steps.flatMap((step) => envConf(step.env, workflow.path, step.line).map((setting) => ({ setting, origin: "the step's `NIX_CONFIG`", envAnchor: step.line }))),
        ...model.commands.flatMap((entry): Candidate[] =>
          entry.nix
            ? nestedInvocations(entry.nix).flatMap((member) =>
                cliConf(member, entry.path).map((setting) => ({ setting, origin: `the \`${[member.binary, member.subcommand].filter(Boolean).join(" ")}\` command line` })),
              )
            : shellConfWrites(entry.command, entry.path, entry.line).map((setting) => ({ setting, origin: "a shell write to nix.conf" })),
        ),
      ];
      const effective = new Set<string>();
      const identity = (setting: NixConfSetting): string => `${setting.path}:${setting.line}:${setting.source}:${setting.key}:${setting.value}`;
      for (const entry of model.commands) {
        if (!entry.nix) continue;
        for (const invocation of nestedInvocations(entry.nix)) {
          if (hasOption(invocation, "--dry-run", "--no-build") || (invocation.binary !== "nix-build" && !["build", "flake check", "develop", "run", "shell"].includes(invocation.subcommand))) continue;
          const current = effectiveNixConf(model, entry, invocation);
          if (!current || confValues(current, "builders", true).some((setting) => setting.value.trim() !== "") ||
              confValues(current, "cores", true).length > 0 || confValues(current, "build-cores", true).length > 0) continue;
          const last = current.filter((setting) => MAX_JOBS_KEYS.has(setting.key)).at(-1);
          if (last) effective.add(identity(last));
        }
      }
      const candidates = settings.filter((candidate) => MAX_JOBS_KEYS.has(candidate.setting.key) && effective.has(identity(candidate.setting)));
      const labels = runnerLabels(job).join(", ");
      for (const candidate of candidates) {
        const { setting } = candidate;
        const jobs = lowJobs(setting.value, max);
        if (jobs === undefined) continue;
        const file = project.files.get(setting.path);
        let line = setting.line;
        if (file && candidate.envAnchor !== undefined) {
          const found = envLine(file, candidate.envAnchor, setting.value.trim());
          if (found !== undefined) line = found;
        }
        const dedupe = `${setting.path}:${line}:${setting.key}:${setting.value}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const written = setting.source === "cli" ? `\`${setting.key} ${setting.value}\`` : `\`${setting.key} = ${setting.value}\``;
        const suggestion =
          setting.source === "cli"
            ? "Consider an explicit per-invocation limit:\n  --max-jobs auto"
            : "Consider an explicit effective configuration:\n  max-jobs = auto";
        report({
          path: setting.path,
          line,
          key: `${job.key}.max-jobs.${setting.path}:${line}`,
          message: `${written} in ${candidate.origin} limits Nix to ${jobs === 1 ? "one local build at a time" : `${jobs} concurrent local builds`} for an inspected command on GitHub-hosted \`${labels}\`. Independent uncached derivations may queue; individual builders may already use every CPU or require this memory limit.`,
          suggestion: `${suggestion}\nMeasure CPU and memory use first: a low limit may prevent out-of-memory failures, and individual builders can already use multiple cores. This is not an automatic fix or a guaranteed speedup.`,
        });
      }
    }
  },
});
