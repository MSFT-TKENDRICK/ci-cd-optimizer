import { lineText } from "../../fix.js";
import type { StepModel } from "../../parsers/workflow.js";
import type { Location, SourceFile } from "../../types.js";
import { commandsOf, defineRule, expandedJobSteps } from "../helpers.js";
import { nixInvocation, optionArity, type NixInvocation } from "./shared.js";

/** Options that change what a build produces or prints, so merging invocations would change the step's behaviour. */
const OUTPUT_OPTIONS = new Set([
  "-o",
  "--out-link",
  "--json",
  "--print-out-paths",
  "--expr",
  "-f",
  "--file",
  "--rebuild",
  "--check",
  "--dry-run",
  "--stdin",
]);

/** A `result` / `result-N` out link mentioned by another command or action input. */
const RESULT_LINK = /(?<![\w./-])\.?\/?result(?:-[\w]+)?(?![\w-])/;

interface Build {
  path: string;
  line: number;
  command: string;
  installables: string[];
  /** Option words (each option with the values it consumes), sorted. */
  options: string[];
  noLink: boolean;
}

/** An eligible `nix build <installables>` command, or undefined when merging it would not be equivalent. */
function buildOf(command: string, nix: NixInvocation | undefined, path: string): Build | undefined {
  if (!nix || nix.binary !== "nix" || nix.subcommand !== "build" || nix.inner !== undefined) return undefined;
  // Pipes, redirections, background jobs and shell expansions make the command more than a plain build.
  if (/[|<>&`$*?]/.test(command)) return undefined;
  const installables: string[] = [];
  const options: string[] = [];
  for (let index = 0; index < nix.args.length; index += 1) {
    const word = nix.args[index] ?? "";
    if (word === "--") return undefined;
    if (word.startsWith("-") && word.length > 1) {
      const name = word.split("=")[0] ?? word;
      if (OUTPUT_OPTIONS.has(name) || /^-o./.test(word)) return undefined;
      const arity = word.includes("=") ? 0 : optionArity(nix, word);
      options.push(nix.args.slice(index, index + arity + 1).join(" "));
      index += arity;
    } else if (word.startsWith("/nix/store/")) return undefined;
    else installables.push(word);
  }
  if (installables.length === 0) return undefined;
  return { path, line: nix.line, command, installables, options: options.sort(), noLink: options.includes("--no-link") };
}

/** True when the step's own mapping sets `continue-on-error` or `timeout-minutes`, which the merged step could not keep per build. */
function hasPerStepPolicy(file: SourceFile | undefined, step: StepModel): boolean {
  if (!file) return false;
  const first = lineText(file.content, step.line);
  const column = /^(\s*(?:-\s+)?)/.exec(first)?.[1]?.length ?? 0;
  const policy = /^(?:continue-on-error|timeout-minutes)\s*:/;
  if (policy.test(first.slice(column))) return true;
  const total = file.content.split("\n").length;
  for (let line = step.line + 1; line <= total; line += 1) {
    const text = lineText(file.content, line);
    if (text.trim() === "" || text.trim().startsWith("#")) continue;
    const indent = /^\s*/.exec(text)?.[0].length ?? 0;
    if (indent < column) return false;
    if (indent === column && policy.test(text.slice(column))) return true;
  }
  return false;
}

interface Group {
  key: string;
  builds: Build[];
}

export default defineRule({
  meta: {
    id: "nix/separate-nix-build-invocations",
    ruleset: "nix",
    description: "Consecutive `nix build` commands in one job that could be a single `nix build` of all installables.",
    rationale:
      "Each `nix build` is a separate Nix process: it locks and evaluates the flake again (shared work such as importing nixpkgs is repeated, because the evaluation cache only records final attribute values), then realises that installable's closure before the shell moves on. The next invocation cannot start building until the previous closure is finished, so while the last few derivations of one installable build, cores that `max-jobs` would let Nix use for the next one stay idle. `nix build .#a .#b` evaluates both installables in one evaluator and hands the union of their closures to one scheduler, which builds independent derivations concurrently and shares common dependencies. Out links become `result`, `result-1`, ... in installable order.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: { minBuilds: 2 },
    validateOptions: (options) =>
      Object.entries(options)
        .filter(([key, value]) => key === "minBuilds" && (typeof value !== "number" || !Number.isInteger(value) || value < 2))
        .map(([key]) => `${key} must be an integer of at least 2`),
    references: [
      "https://nix.dev/manual/nix/2.24/command-ref/new-cli/nix3-build",
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-max-jobs",
      "https://nix.dev/manual/nix/2.24/command-ref/conf-file#conf-eval-cache",
    ],
    impact: "low",
    example: {
      bad: "- run: nix build .#server\n- run: nix build .#client\n- run: nix build .#docs",
      good: "- run: nix build .#server .#client .#docs",
    },
  },
  check({ project, options, report }) {
    const minBuilds = options.minBuilds;
    const reported = new Set<string>();
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        const expanded = expandedJobSteps(project, workflow, job);
        const groups: Group[] = [];
        let current: Group | undefined;
        const flush = (): void => {
          if (current) groups.push(current);
          current = undefined;
        };
        const others: string[] = [];
        for (const { step, owner, path } of expanded) {
          for (const value of step.with.values()) others.push(String(value.value ?? ""));
          if (!step.run) {
            flush();
            continue;
          }
          const file = project.files.get(path);
          const stepEligible = !hasPerStepPolicy(file, step) && !(step !== owner && hasPerStepPolicy(project.files.get(workflow.path), owner));
          const context = JSON.stringify([
            owner.if ?? "",
            step.if ?? "",
            step.env,
            step.shell ?? "",
            step.workingDirectory ?? "",
            owner === step ? "" : owner.key,
          ]);
          for (const { command, line } of commandsOf(step)) {
            const build = stepEligible ? buildOf(command, nixInvocation(command, line), path) : undefined;
            if (!build) {
              flush();
              others.push(command);
              continue;
            }
            const key = `${context}|${build.options.join(" ")}`;
            if (current?.key !== key) {
              flush();
              current = { key, builds: [] };
            }
            current.builds.push(build);
          }
        }
        flush();
        const resultUsed = others.some((text) => RESULT_LINK.test(text));
        for (const { builds } of groups) {
          const first = builds[0];
          if (!first || builds.length < minBuilds) continue;
          if (resultUsed && !builds.every((build) => build.noLink)) continue;
          const siteKey = `${first.path}:${first.line}:${first.command}`;
          if (reported.has(siteKey)) continue;
          reported.add(siteKey);
          const installables = [...new Set(builds.flatMap((build) => build.installables))];
          const merged = ["nix build", ...first.options, ...installables].join(" ");
          const lines = builds.map((build) => build.line).join(", ");
          const related: Location[] = builds.slice(1).map((build) => ({ path: build.path, line: build.line }));
          report({
            path: first.path,
            line: first.line,
            key: `${job.key}.separate-nix-builds.${first.line}`,
            message: `${builds.length} consecutive \`nix build\` commands in job \`${job.id}\` (lines ${lines}) each start a new Nix process that re-evaluates the flake and finishes one closure before the next begins; \`${merged}\` evaluates once and schedules all ${installables.length} installables together.`,
            suggestion: `Build the installables in one invocation (out links become result, result-1, ...; add --no-link if nothing reads them):\n- run: ${merged}`,
            confidence: "medium",
            related,
          });
        }
      }
    }
  },
});
