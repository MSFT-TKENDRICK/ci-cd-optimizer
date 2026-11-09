import type { ProjectModel } from "../../project.js";
import { hasTrigger } from "../../parsers/workflow.js";
import { defineRule, expandedJobSteps, jobCommands } from "../helpers.js";
import { usesAction } from "../caching/shared.js";
import { hasOption, nestedInvocations, nixJobs, optionArgs, positionalArgs } from "./shared.js";
import type { NixInvocation, NixJob } from "./shared.js";

const BUILD_TRIGGERS = ["push", "pull_request", "pull_request_target", "merge_group"];

/** Actions that commit or open a pull request with the updated lock, making the job an updater rather than a build. */
const PUBLISHING_ACTIONS = [
  "peter-evans/create-pull-request",
  "determinatesystems/update-flake-lock",
  "stefanzweifel/git-auto-commit-action",
  "endbug/add-and-commit",
];
const PUBLISHING_COMMAND = /\bgh\s+pr\s+create\b|\bgit\s+push\b|\bhub\s+pull-request\b/;
const EVENT_EQUALS = /github\.event_name\s*==\s*['"]([\w-]+)['"]/g;

interface LockUpdate {
  /** The command as shown in the message, e.g. `nix flake update` or `nix flake lock --update-input nixpkgs`. */
  shown: string;
  /** Inputs named for update; empty means every input. */
  inputs: string[];
}

/** Flake inputs declared anywhere in the project, mapped to their URL. */
function declaredInputs(project: ProjectModel): Map<string, string> {
  const inputs = new Map<string, string>();
  for (const flake of project.nix.flakes) {
    for (const [name, input] of flake.info?.inputs ?? []) inputs.set(name, input.url ?? inputs.get(name) ?? "");
  }
  return inputs;
}

function optionValues(nix: NixInvocation, name: string): string[] {
  const words = optionArgs(nix);
  const values: string[] = [];
  words.forEach((word, index) => {
    if (word === name && words[index + 1] !== undefined) values.push(words[index + 1] ?? "");
    else if (word.startsWith(`${name}=`)) values.push(word.slice(name.length + 1));
  });
  return values;
}

function lockUpdate(nix: NixInvocation, inputs: Map<string, string>): LockUpdate | undefined {
  if (nix.binary !== "nix") return undefined;
  const prefix = nix.subcommand ? `nix ${nix.subcommand}` : "nix";
  if (hasOption(nix, "--recreate-lock-file")) return { shown: `${prefix} --recreate-lock-file`, inputs: [] };
  const named = optionValues(nix, "--update-input");
  if (named.length > 0) return { shown: `${prefix} ${named.map((name) => `--update-input ${name}`).join(" ")}`, inputs: named };
  if (nix.subcommand !== "flake update") return undefined;
  // Nix >= 2.19 takes input names as positionals; older versions took a flake reference (path/URL) there.
  const names = positionalArgs(nix).filter((word) => inputs.has(word) || /^[A-Za-z_][\w'-]*$/.test(word));
  return { shown: names.length > 0 ? `nix flake update ${names.join(" ")}` : "nix flake update", inputs: names };
}

/** Local `path:` inputs must be re-locked whenever the referenced directory changes; refreshing only those is legitimate. */
function onlyLocalInputs(update: LockUpdate, inputs: Map<string, string>): boolean {
  return update.inputs.length > 0 && update.inputs.every((name) => /^(?:path:|\.{1,2}\/|\/)/.test(inputs.get(name) ?? ""));
}

/** True when an `if:` limits execution to events other than push/pull_request/merge_group. */
function limitedToUpdateEvents(condition: string | undefined): boolean {
  const events = [...(condition ?? "").matchAll(EVENT_EQUALS)].map((match) => match[1] ?? "");
  return events.length > 0 && events.every((event) => !BUILD_TRIGGERS.includes(event)) && !/!=|\|\|/.test(condition ?? "");
}

function publishesLock(project: ProjectModel, { workflow, job }: NixJob): boolean {
  if (expandedJobSteps(project, workflow, job).some(({ step }) => usesAction(step, ...PUBLISHING_ACTIONS))) return true;
  return jobCommands(project, workflow, job).some(({ command }) => PUBLISHING_COMMAND.test(command) || /--commit-lock-file\b/.test(command));
}

function updaterSnippet(inputs: string[]): string {
  return [
    "# .github/workflows/update-flake-lock.yml",
    "on:",
    "  schedule:",
    '    - cron: "0 4 * * 1"',
    "  workflow_dispatch:",
    "permissions:",
    "  contents: write",
    "  pull-requests: write",
    "jobs:",
    "  update-flake-lock:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v5",
    "      - uses: cachix/install-nix-action@v31",
    "      - uses: DeterminateSystems/update-flake-lock@v29",
    ...(inputs.length > 0 ? ["        with:", `          inputs: ${inputs.join(" ")}`] : []),
  ].join("\n");
}

export default defineRule({
  meta: {
    id: "nix/flake-update-in-build-job",
    ruleset: "nix",
    description: "A push/pull_request CI job runs `nix flake update` (or `--update-input`/`--recreate-lock-file`) before building.",
    rationale:
      "flake.lock records the exact revision and NAR hash of every flake input; it is the only thing that makes a Nix build of a given commit reproducible. Re-locking inside a build job (`nix flake update`, `nix flake lock --update-input`, `--recreate-lock-file`) resolves inputs such as `github:NixOS/nixpkgs/nixos-unstable` to whatever their branch points at during that run. The job then builds and tests a dependency set nobody committed or reviewed: a green check no longer means the commit builds, an unrelated upstream change can turn every open pull request red, two reruns of the same commit can disagree, and most derivations change hash, so the binary cache misses. Because the updated lock is discarded at the end of the job, the result cannot be reproduced locally either. Updates belong in a separate scheduled job that commits the new lock through a pull request, where it gets its own CI run and review.",
    kind: "practice",
    defaultSeverity: "error",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake-update",
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-flake-lock",
      "https://github.com/DeterminateSystems/update-flake-lock",
    ],
    impact: "high",
    example: {
      bad: "on: [push, pull_request]\njobs:\n  build:\n    steps:\n      - uses: cachix/install-nix-action@v31\n      - run: nix flake update\n      - run: nix build",
      good: "on: [push, pull_request]\njobs:\n  build:\n    steps:\n      - uses: cachix/install-nix-action@v31\n      - run: nix build --no-update-lock-file\n# plus a scheduled workflow running DeterminateSystems/update-flake-lock",
    },
  },
  check({ project, report }) {
    const inputs = declaredInputs(project);
    for (const nixJob of nixJobs(project)) {
      const { workflow, job } = nixJob;
      const triggers = BUILD_TRIGGERS.filter((event) => hasTrigger(workflow, event));
      if (triggers.length === 0 || limitedToUpdateEvents(job.if) || publishesLock(project, nixJob)) continue;
      for (const entry of nixJob.commands) {
        if (!entry.nix || limitedToUpdateEvents(entry.step.if) || limitedToUpdateEvents(entry.owner.if)) continue;
        nestedInvocations(entry.nix).forEach((nix, depth) => {
          const update = lockUpdate(nix, inputs);
          if (!update || onlyLocalInputs(update, inputs)) return;
          const what = update.inputs.length > 0 ? `input${update.inputs.length > 1 ? "s" : ""} ${update.inputs.map((name) => `\`${name}\``).join(", ")}` : "every flake input";
          report({
            path: entry.path,
            line: nix.line,
            key: `${entry.path}:${entry.line}:${depth}:${job.id}:flake-update`,
            message: `\`${update.shown}\` in job \`${job.id}\` (triggered by ${triggers.join("/")}) re-resolves ${what} to the newest revision, so CI builds dependencies that are not in the committed flake.lock and the updated lock is thrown away.`,
            suggestion: `Remove the update from the build job and build exactly what is committed; \`--no-update-lock-file\` makes the job fail instead of silently re-locking:\nnix build --no-update-lock-file\nMove updates to a scheduled workflow that opens a pull request with the new lock:\n${updaterSnippet(update.inputs)}`,
            confidence: "high",
          });
        });
      }
    }
  },
});
