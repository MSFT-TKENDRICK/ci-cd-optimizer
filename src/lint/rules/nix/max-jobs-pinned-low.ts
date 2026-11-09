import { fix, lineStart, lineText } from "../../fix.js";
import type { SourceFile, TextEdit } from "../../types.js";
import { defineRule } from "../helpers.js";
import {
  NIX_CONF_INPUTS,
  cliConf,
  confValues,
  envConf,
  installerConf,
  nestedInvocations,
  nixJobs,
  runnerLabels,
  isGitHubHosted,
  shellConfWrites,
  type NixConfSetting,
} from "./shared.js";

const MAX_JOBS_KEYS = new Set(["max-jobs", "build-max-jobs"]);
const CONF_VALUE = /(?<=\b(?:build-)?max-jobs\s*=\s*)\d+\b/g;
const CLI_VALUE = /(?<=--max-jobs(?:=|\s+)|--option\s+(?:build-)?max-jobs\s+|(?:^|\s)-j\s+)\d+\b/g;
const CLI_ATTACHED = /(?<=^|\s)-j\d+\b/g;

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

/** Replaces the only match of `pattern` on `line`; no edit when the line has zero or several matches. */
function replaceOnly(file: SourceFile, line: number, pattern: RegExp, replacement: string): TextEdit | undefined {
  const text = lineText(file.content, line);
  const matches = [...text.matchAll(pattern)];
  const match = matches[0];
  if (matches.length !== 1 || match?.index === undefined) return undefined;
  const start = lineStart(file.content, line) + match.index;
  return { path: file.path, start, end: start + match[0].length, text: replacement };
}

function cliEdit(file: SourceFile, line: number): TextEdit | undefined {
  const text = lineText(file.content, line);
  const spaced = [...text.matchAll(CLI_VALUE)].length;
  const attached = [...text.matchAll(CLI_ATTACHED)].length;
  if (spaced + attached !== 1) return undefined;
  return spaced === 1 ? replaceOnly(file, line, CLI_VALUE, "auto") : replaceOnly(file, line, CLI_ATTACHED, "-j auto");
}

export default defineRule({
  meta: {
    id: "nix/max-jobs-pinned-low",
    ruleset: "nix",
    description: "Nix's `max-jobs` is pinned to a very small number on a GitHub-hosted runner.",
    rationale:
      "`max-jobs` is the number of derivations Nix builds locally at the same time; `cores` is separate and only sets `NIX_BUILD_CORES`, which a builder may use for its own internal parallelism (nixpkgs passes it to make only when `enableParallelBuilding` is set). Nix's built-in default for `max-jobs` is 1, which is why installers such as cachix/install-nix-action write `max-jobs = auto` (one job per CPU). Overriding it back to 1 (or another tiny number) through the installer's nix.conf input, `NIX_CONFIG`, `--max-jobs`/`-j` or `--option max-jobs` makes every independent derivation in the build graph wait for the previous one, so single-threaded steps such as configure scripts, linking, test runs and the many derivations that never enable parallel building leave the runner's other vCPUs idle. Substitution from binary caches is governed by `max-substitution-jobs` and is unaffected, so the cost is paid exactly on the cache misses a CI build exists to build. Jobs that distribute builds (`builders`) or tune `cores` are treated as deliberate and skipped.",
    kind: "practice",
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
    fixable: true,
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
      if (!isGitHubHosted(job)) continue;

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
      // Remote builders or explicit `cores` tuning mean the parallelism split was chosen deliberately.
      const conf = [...model.conf, ...settings.map((candidate) => candidate.setting)];
      if (confValues(conf, "builders", true).some((setting) => setting.value.trim() !== "")) continue;
      if (confValues(conf, "cores").length > 0 || confValues(conf, "build-cores").length > 0) continue;
      const candidates = settings.filter((candidate) => MAX_JOBS_KEYS.has(candidate.setting.key));

      // A higher or `auto` value set anywhere in the job may override a low nix.conf value; stay quiet when unsure.
      const raised = candidates.some((candidate) => lowJobs(candidate.setting.value, max) === undefined && candidate.setting.value.trim() !== "0");
      const labels = runnerLabels(job).join(", ");
      const installsWithAuto = model.installers.some((step) => step.uses?.action.name === "cachix/install-nix-action");
      for (const candidate of candidates) {
        const { setting } = candidate;
        const jobs = lowJobs(setting.value, max);
        if (jobs === undefined) continue;
        if (setting.source !== "cli" && raised) continue;
        const file = project.files.get(setting.path);
        let line = setting.line;
        let edit: TextEdit | undefined;
        if (file && setting.source === "cli") {
          edit = cliEdit(file, line);
        } else if (file && candidate.envAnchor !== undefined) {
          const found = envLine(file, candidate.envAnchor, setting.value.trim());
          if (found !== undefined) {
            line = found;
            edit = replaceOnly(file, line, CONF_VALUE, "auto");
          }
        } else if (file) {
          edit = replaceOnly(file, line, CONF_VALUE, "auto");
        }
        const dedupe = `${setting.path}:${line}:${setting.key}:${setting.value}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const written = setting.source === "cli" ? `\`${setting.key} ${setting.value}\`` : `\`${setting.key} = ${setting.value}\``;
        const suggestion =
          setting.source === "cli"
            ? installsWithAuto
              ? "Drop the flag: cachix/install-nix-action already writes `max-jobs = auto` to nix.conf. Or set it explicitly:\n  --max-jobs auto"
              : "Let Nix run one build job per CPU:\n  --max-jobs auto"
            : "Let Nix run one build job per CPU:\n  max-jobs = auto";
        const repair = edit ? fix("Set max-jobs to auto", edit) : undefined;
        report({
          path: setting.path,
          line,
          key: `${job.key}.max-jobs.${setting.path}:${line}`,
          message: `${written} in ${candidate.origin} limits Nix to ${jobs === 1 ? "one local build at a time" : `${jobs} concurrent local builds`} on GitHub-hosted \`${labels}\`, so independent derivations ${jobs === 1 ? "are built one after another" : "queue for a build slot"} instead of using every runner CPU.`,
          suggestion,
          ...(repair ? { fix: repair } : {}),
        });
      }
    }
  },
});
