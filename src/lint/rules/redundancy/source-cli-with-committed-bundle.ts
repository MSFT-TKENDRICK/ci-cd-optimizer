import type { ProjectModel } from "../../project.js";
import { field, stringValue } from "../../parsers/yaml.js";
import type { JobModel, StepModel, WorkflowModel } from "../../parsers/workflow.js";
import { commandWords } from "../caching/shared.js";
import { commandsOf, defineRule } from "../helpers.js";
import { INSTALL_COMMAND } from "./shared.js";

/** Programs that may read installed dependencies, so their presence keeps the install necessary. */
const DEPENDENCY_CONSUMERS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "bunx", "node", "tsx", "ts-node", "deno", "tsc", "vitest", "jest", "eslint"]);
const OPAQUE_CONSUMER = /(^|[\s;&|(])(npx|npm|node|tsx|ts-node|pnpm|yarn|bunx?)\s/;
const SOURCE_RUNNER = /^(?:tsx|ts-node)\s/;
const RUN_FLAGS = new Set(["--silent", "-s", "--if-present"]);

interface Bundle {
  path: string;
  main: string;
}

interface Invocation {
  line: number;
  command: string;
  script: string;
  body: string;
  args: string[];
}

function committedBundle(project: ProjectModel): Bundle | undefined {
  const action = project.actions.find((entry) => entry.path === "action.yml" || entry.path === "action.yaml");
  if (!action) return undefined;
  const runs = field(action.source, action.source.doc.contents, "runs")?.value ?? null;
  if (!runs) return undefined;
  const using = stringValue(field(action.source, runs, "using")?.value ?? null);
  const main = stringValue(field(action.source, runs, "main")?.value ?? null);
  if (!using || !/^node\d+$/.test(using) || !main) return undefined;
  return { path: action.path, main: main.replace(/^\.\//, "") };
}

/** Parses `npm run [--silent] <script> [-- args]` into the script and its forwarded arguments. */
function npmRun(words: string[]): { script: string; args: string[] } | undefined {
  if (words[0] !== "npm" || (words[1] !== "run" && words[1] !== "run-script")) return undefined;
  let index = 2;
  while (RUN_FLAGS.has(words[index] ?? "")) index += 1;
  const script = words[index];
  if (!script || script.startsWith("-")) return undefined;
  const rest = words.slice(index + 1);
  if (rest.length > 0 && rest[0] !== "--") return undefined;
  return { script, args: rest.slice(1) };
}

function sourceCli(words: string[], scripts: Record<string, unknown>): { script: string; body: string; args: string[] } | undefined {
  const run = npmRun(words);
  if (!run) return undefined;
  const body = scripts[run.script];
  if (typeof body !== "string" || !SOURCE_RUNNER.test(body)) return undefined;
  return { ...run, body };
}

function invocations(job: JobModel, scripts: Record<string, unknown>): Invocation[] {
  if (job.workingDirectory) return [];
  return job.steps.flatMap((step) =>
    step.workingDirectory
      ? []
      : commandsOf(step).flatMap(({ command, line }) => {
          const match = sourceCli(commandWords(command), scripts);
          return match ? [{ line, command: command.trim(), ...match }] : [];
        }),
  );
}

/** True when every command and action in the job works without installed dependencies, apart from installs and source-CLI calls. */
function dependencyFree(steps: StepModel[], scripts: Record<string, unknown>): boolean {
  for (const step of steps) {
    if (step.uses?.action?.name === "actions/github-script") return false;
    const script = step.run?.value;
    if (!script) continue;
    const commands = commandsOf(step);
    if (commands.length === 0 && OPAQUE_CONSUMER.test(script)) return false;
    for (const { command } of commands) {
      const words = commandWords(command);
      if (INSTALL_COMMAND.test(words.join(" ")) || sourceCli(words, scripts)) continue;
      if (words.length === 0 ? OPAQUE_CONSUMER.test(command) : DEPENDENCY_CONSUMERS.has(words[0] ?? "") || command.includes("node_modules")) return false;
    }
  }
  return true;
}

function installs(steps: StepModel[]): boolean {
  return steps.some((step) => commandsOf(step).some(({ command }) => INSTALL_COMMAND.test(commandWords(command).join(" "))));
}

function message(workflow: WorkflowModel, job: JobModel, invocation: Invocation, bundle: Bundle): string {
  const command = invocation.command.length > 120 ? `${invocation.command.slice(0, 117)}...` : invocation.command;
  return `Job \`${job.id}\` in ${workflow.path} installs dependencies only to run \`${command}\` from source (\`${invocation.body}\`), although \`${bundle.path}\` ships the bundled entry point \`${bundle.main}\`.`;
}

export default defineRule({
  meta: {
    id: "redundancy/source-cli-with-committed-bundle",
    ruleset: "redundancy",
    description: "Jobs that install dependencies only to run a TypeScript CLI from source could run the committed action bundle instead.",
    rationale:
      "A JavaScript action commits a self-contained bundle so it runs without installing anything. A job that installs the full dependency tree just to start the same CLI through tsx or ts-node pays for the install and the on-the-fly compilation on every run, although the bundle in the repository already contains that code. When a generated-output check keeps the bundle in sync with the source, running it with `node` gives the same behaviour without the install.",
    kind: "insight",
    defaultSeverity: "info",
    presets: ["insights"],
    requires: [],
    defaultOptions: {},
    references: ["https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-javascript-action"],
    impact: "low",
    example: {
      bad: "# action.yml: runs: { using: node24, main: dist/index.js }\n# package.json: \"cli\": \"tsx src/bin.ts\"\nsteps:\n  - uses: actions/checkout@v4\n  - uses: actions/setup-node@v4\n  - run: npm ci\n  - run: npm run --silent cli -- report --pr 1",
      good: "steps:\n  - uses: actions/checkout@v4\n  - uses: actions/setup-node@v4\n  - run: node dist/index.js report --pr 1",
    },
  },
  check({ project, report }) {
    const scripts = project.rootManifest?.json.scripts;
    if (!scripts || typeof scripts !== "object") return;
    const bundle = committedBundle(project);
    if (!bundle) return;
    const table = scripts as Record<string, unknown>;
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        if (job.uses) continue;
        const [first] = invocations(job, table);
        if (!first) continue;
        const steps = project.expandedSteps(job);
        if (!installs(steps) || !dependencyFree(steps, table)) continue;
        const args = first.args.join(" ");
        report({
          path: workflow.path,
          line: first.line,
          key: `${job.key}.source-cli-bundle.${first.script}`,
          message: message(workflow, job, first, bundle),
          suggestion: `If \`${bundle.main}\` routes the same command and a generated-output check keeps it current, drop the dependency install and run \`node ${bundle.main}${args ? ` ${args}` : ""}\` after setting up Node.`,
          confidence: "medium",
        });
      }
    }
  },
});
