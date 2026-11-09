import { commandWords } from "../caching/shared.js";
import { commandsOf, defineRule } from "../helpers.js";
import { hash, stable, workingDirectory } from "./shared.js";

const TRIVIAL = new Set([
  "echo", "printf", "cd", "pushd", "popd", "ls", "pwd", "set", "export", "unset", "true", "false", ":", "exit", "sleep",
  "cat", "mkdir", "rm", "cp", "mv", "touch", "date", "env", "whoami", "uname", "df", "du", "wait", "source", ".", "test",
  "[", "[[", "git", "chmod", "tee", "printenv", "which", "id", "free", "nproc", "shift", "read",
]);

/** Scripts whose meaning depends on control flow or a changing directory cannot be compared line by line. */
const STATEFUL = /(?:^|[\s;&|(])(?:cd|pushd|popd|export|source|unset|if|then|else|elif|fi|case|esac|for|while|until|do|done|function|select)(?=[\s;&|)]|$)|\|\||\(\)\s*\{/m;

const RESETS = /GITHUB_ENV|GITHUB_PATH/;

const MIN_WORDS = 2;

export default defineRule({
  meta: {
    id: "redundancy/duplicate-command",
    ruleset: "redundancy",
    description: "A job should not run the same non-trivial shell command more than once.",
    rationale:
      "Repeating an install, build, or test command in one job repeats its cost on every run. It is usually left over from merging two step lists and makes it unclear which invocation the job actually depends on.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["strict"],
    requires: [],
    defaultOptions: {},
    references: ["https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsrun"],
    impact: "low",
    example: {
      bad: "steps:\n  - run: npm ci\n  - run: npm test\n  - run: npm ci",
      good: "steps:\n  - run: npm ci\n  - run: npm test",
    },
  },
  check({ project, report }) {
    for (const workflow of [...project.workflows, ...project.actions]) {
      for (const job of workflow.jobs) {
        if (job.uses) continue;
        const seen = new Map<string, { line: number; count: number }>();
        for (const step of job.steps) {
          // Actions and writes to GITHUB_ENV/GITHUB_PATH can change what a later identical command does.
          if (step.uses || (step.run && RESETS.test(step.run.value))) {
            seen.clear();
            continue;
          }
          if (!step.run || STATEFUL.test(step.run.value)) continue;
          const context = `${workingDirectory(workflow, job, step) ?? ""}\u0000${step.if ?? ""}\u0000${stable(step.env)}`;
          for (const { command, line } of commandsOf(step)) {
            const text = command.trim().replace(/\s+/g, " ");
            const words = commandWords(text);
            const program = words[0];
            if (program === undefined || TRIVIAL.has(program) || words.length < MIN_WORDS) continue;
            if (/[<>]/.test(text) || text.includes("$(") || text.includes("`")) continue;
            const key = `${text}\u0000${context}`;
            const first = seen.get(key);
            if (!first) {
              seen.set(key, { line, count: 1 });
              continue;
            }
            first.count += 1;
            report({
              path: workflow.path,
              line,
              key: `${job.key}.duplicate-command.${hash(key)}.${first.count}`,
              message: `\`${text}\` already ran earlier in job "${job.id}" (line ${first.line}).`,
              suggestion: "Remove the repeated command, or explain with a comment why the second run is required.",
              related: [{ path: workflow.path, line: first.line }],
            });
          }
        }
      }
    }
  },
});
