import type { ProjectModel } from "../../project.js";
import { defineRule, jobCommands, stepLine } from "../helpers.js";
import { packageScript, toolInvocation, toolWords, workingDirectory } from "./shared.js";

const TOOLS = new Set(["jest", "vitest", "ng", "karma", "tsc", "mocha"]);

function flagOn(args: string[], ...names: string[]): boolean {
  return args.some((arg) => {
    const [name, value] = arg.split("=", 2);
    return names.includes(name ?? "") && (value === undefined || value === "true");
  });
}

function flagOff(args: string[], name: string, ...extra: string[]): boolean {
  return args.some((arg, index) => arg === `${name}=false` || extra.includes(arg) || (arg === name && args[index + 1] === "false"));
}

function karmaSingleRun(project: ProjectModel): boolean {
  return [...project.files.values()].some((file) => /(^|\/)karma\.conf[\w.-]*\.[cm]?[jt]s$/i.test(file.path) && /singleRun\s*:\s*true/.test(file.content));
}

function angularNoWatch(project: ProjectModel): boolean {
  return [...project.files.values()].some(
    (file) => /(^|\/)angular\.json$/i.test(file.path) && /"watch"\s*:\s*false|@angular\/build:unit-test/.test(file.content),
  );
}

/** Describes the watch-mode invocation in a command, if any. */
function watchMode(command: string, project: ProjectModel): string | undefined {
  const words = toolInvocation(command, TOOLS);
  if (!words) return undefined;
  const [tool = "", sub = "", ...rest] = words;
  const args = [sub, ...rest];
  switch (tool) {
    case "jest":
      return flagOn(args, "--watch", "--watchAll") ? "jest --watch" : undefined;
    case "vitest":
      if (sub === "watch" || sub === "dev") return `vitest ${sub}`;
      return flagOn(args, "--watch", "-w") ? "vitest --watch" : undefined;
    case "tsc":
    case "mocha":
      return flagOn(args, "--watch", "-w") ? `${tool} --watch` : undefined;
    case "ng":
      if (sub !== "test" && sub !== "t") return undefined;
      if (flagOff(args, "--watch", "--no-watch")) return undefined;
      if (flagOn(args, "--watch")) return "ng test --watch";
      return karmaSingleRun(project) || angularNoWatch(project) ? undefined : "ng test";
    case "karma":
      if (sub !== "start") return undefined;
      if (flagOn(args, "--single-run", "--singleRun") || flagOff(args, "--watch", "--no-watch", "--no-auto-watch")) return undefined;
      if (flagOff(args, "--single-run", "--no-single-run")) return "karma start --no-single-run";
      return karmaSingleRun(project) ? undefined : "karma start";
  }
  return undefined;
}

function scriptName(command: string): string | undefined {
  const [manager = "", ...args] = toolWords(command);
  if (!["npm", "yarn", "pnpm", "bun"].includes(manager)) return undefined;
  const positional = args.filter((word) => !word.startsWith("-"));
  if (positional[0] === "run" || positional[0] === "run-script") return positional[1];
  if (positional[0] === "test" || positional[0] === "t") return "test";
  return manager === "yarn" || manager === "pnpm" ? positional[0] : undefined;
}

export default defineRule({
  meta: {
    id: "testing/watch-mode-in-ci",
    ruleset: "testing",
    description: "Test runners and compilers in CI should run once instead of in watch mode.",
    rationale:
      "A watcher never exits on its own: `jest --watch`, `vitest watch`, `karma start` or `ng test` without single-run keeps the job alive until the job timeout (six hours by default), burning runner minutes and blocking the merge signal.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://jestjs.io/docs/cli#--watch",
      "https://vitest.dev/guide/cli.html#vitest-run",
      "https://karma-runner.github.io/latest/config/configuration-file.html#singlerun",
      "https://angular.dev/cli/test",
    ],
    impact: "high",
    example: {
      bad: "- run: npx ng test",
      good: "- run: npx ng test --watch=false --browsers=ChromeHeadless",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        for (const entry of jobCommands(project, workflow, job)) {
          let found = watchMode(entry.command, project);
          let via = "";
          if (!found && !/--watch[= ]false|--no-watch|--single-?run(?!=false)|--singleRun|--run\b|--ci\b/.test(entry.command)) {
            const name = scriptName(entry.command);
            const dir = name === undefined ? undefined : workingDirectory(workflow, job, entry.step);
            const script = name === undefined || dir === undefined ? undefined : packageScript(project, dir, name);
            found = script?.split(/&&|\|\||;/).map((part) => watchMode(part.trim(), project)).find(Boolean);
            if (found) via = ` (via the \`${name ?? ""}\` package script)`;
          }
          if (!found) continue;
          report({
            path: workflow.path,
            line: entry.direct ? entry.line : stepLine(entry.owner),
            key: `${entry.step.key}:${found}`,
            message: `\`${found}\` runs in watch mode${via} and will not exit until the job times out.`,
            suggestion:
              "Run once: `vitest run`, jest without `--watch`/`--watchAll`, `ng test --watch=false`, `karma start --single-run`, or tsc/mocha without `--watch`.",
          });
        }
      }
    }
  },
});
