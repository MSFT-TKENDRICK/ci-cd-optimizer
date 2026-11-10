import type { ProjectModel } from "../../project.js";
import { hasTrigger } from "../../parsers/workflow.js";
import { defineRule } from "../helpers.js";
import { commandDirectory, entryIndex } from "../toolchains/shared.js";
import { usesAction } from "../caching/shared.js";
import { hasOption, nestedInvocations, nixJobs, optionArgs, positionalArgs } from "./shared.js";
import { shellWords, stepIsSkipped, type NixCommand, type NixInvocation, type NixJob } from "./shared.js";

const BUILD_TRIGGERS = ["push", "pull_request", "pull_request_target", "merge_group"];

/** Actions that commit or open a pull request with the updated lock, making the job an updater rather than a build. */
const PUBLISHING_ACTIONS = [
  "peter-evans/create-pull-request",
  "determinatesystems/update-flake-lock",
  "stefanzweifel/git-auto-commit-action",
  "endbug/add-and-commit",
];
const PUBLISHING_COMMAND = /^(?:gh\s+pr\s+create|git\s+push|hub\s+pull-request)\b/;

interface LockUpdate {
  /** The command as shown in the message, e.g. `nix flake update` or `nix flake lock --update-input nixpkgs`. */
  shown: string;
  /** Inputs named for update; empty means every input. */
  inputs: string[];
}

/** Flake inputs declared anywhere in the project, mapped to their URL. */
function declaredInputs(project: ProjectModel, dir: string | undefined): Map<string, string> {
  const inputs = new Map<string, string>();
  if (dir === undefined) return inputs;
  for (const flake of project.nix.flakes) {
    if (flake.dir !== dir) continue;
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
  const expression = (condition ?? "").trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  if (expression === "false") return true;
  if (expression.includes("||")) return false;
  return expression.split("&&").some((atom) => {
    const event = /^\s*\(?\s*github\.event_name\s*==\s*['"]([\w-]+)['"]\s*\)?\s*$/.exec(atom)?.[1];
    return event !== undefined && !BUILD_TRIGGERS.includes(event);
  });
}

function publishesLock(model: NixJob, site: NixCommand): boolean {
  const position = entryIndex(model, site);
  const unconditional = (entry: NixCommand | NixJob["entries"][number]): boolean =>
    !stepIsSkipped(entry) && (!entry.step.if || entry.step.if === site.step.if) && (!entry.owner.if || entry.owner.if === site.owner.if);
  if (model.entries.slice(position + 1).some((entry) => unconditional(entry) && usesAction(entry.step, ...PUBLISHING_ACTIONS))) return true;
  return model.commands.slice(model.commands.indexOf(site) + 1).some((entry) =>
    unconditional(entry) && PUBLISHING_COMMAND.test(shellWords(entry.command).join(" ")),
  );
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
      "Updating a lock in ordinary push/PR CI can resolve mutable inputs differently from the committed lock. Pinned or unchanged inputs need not change, other steps may preserve the result, and neither a lock nor this detector proves reproducible builds. Separating reviewed dependency updates from frozen-lock build checks makes the tested source set clearer. Explicit local-input refreshes and recognized publication paths can be intentional.",
    kind: "practice",
    defaultSeverity: "warn",
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
    for (const nixJob of nixJobs(project)) {
      const { workflow, job } = nixJob;
      const triggers = BUILD_TRIGGERS.filter((event) => hasTrigger(workflow, event));
      if (triggers.length === 0 || limitedToUpdateEvents(job.if)) continue;
      for (const entry of nixJob.commands) {
        if (!entry.nix || limitedToUpdateEvents(entry.step.if) || limitedToUpdateEvents(entry.owner.if) || publishesLock(nixJob, entry)) continue;
        const inputs = declaredInputs(project, commandDirectory(nixJob, entry));
        nestedInvocations(entry.nix).forEach((nix, depth) => {
          const update = lockUpdate(nix, inputs);
          if (!update || hasOption(nix, "--commit-lock-file") ||
              (depth === 0 && !hasOption(nix, "--flake", "--override-input") && onlyLocalInputs(update, inputs))) return;
          const what = update.inputs.length > 0 ? `input${update.inputs.length > 1 ? "s" : ""} ${update.inputs.map((name) => `\`${name}\``).join(", ")}` : "the flake's inputs";
          report({
            path: entry.path,
            line: nix.line,
            key: `${entry.path}:${entry.line}:${depth}:${job.id}:flake-update`,
            message: `\`${update.shown}\` in job \`${job.id}\` (enabled for ${triggers.join("/")}) requests an update of ${what}. Mutable references may differ from the committed lock, and no recognized later publication of this update is visible. Confirm that testing updated dependencies is intentional.`,
            suggestion: `Remove the update from the build job and build exactly what is committed; \`--no-update-lock-file\` makes the job fail instead of silently re-locking:\nnix build --no-update-lock-file\nMove updates to a scheduled workflow that opens a pull request with the new lock:\n${updaterSnippet(update.inputs)}`,
            confidence: "medium",
          });
        });
      }
    }
  },
});
