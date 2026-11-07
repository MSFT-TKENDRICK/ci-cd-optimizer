import { parseArgs } from "node:util";
import { allRules } from "../lint/rules/index.js";
import { renderRulesMarkdown } from "../lint/docs.js";
import { VERSION } from "../version.js";
import { experimentsCommand, EXPERIMENTS_HELP } from "./experiments.js";
import { UsageError, writeText, type CliIO } from "./io.js";
import { lintCommand, LINT_HELP } from "./lint.js";
import { recipesCommand, RECIPES_HELP } from "./recipes.js";
import { scanCommand, SCAN_HELP } from "./scan.js";
import { telemetryCommand, TELEMETRY_HELP } from "./telemetry.js";
import { knowledgeCommand, KNOWLEDGE_HELP } from "./knowledge.js";
import { maintenanceCommand, MAINTENANCE_HELP } from "./maintenance.js";
import { executionCommand, EXECUTION_HELP } from "./execution.js";
import { reviewCommand, REVIEW_HELP } from "./review.js";

export const HELP = `ci-cd-optimizer ${VERSION} - a CI/CD performance linter and optimizer for GitHub repositories

Usage: ci-cd-optimizer <command> [options]

Commands:
  lint [dir]            Lint workflows, Dockerfiles, and package manifests (default command)
  rules                 List rules (--format json|markdown)
  scan                  Scan a repository via the API like the App: SARIF, finding issues, autofix PRs
  telemetry             Report on a completed workflow run (Gantt, critical path) and raise duration alerts
  experiments <cmd>     Hill-climbing experiments: list, context, create, collect, evaluate, decide
  recipes <cmd>         Reusable fixes from promoted experiments: publish, apply, status, rollout
  knowledge <cmd>       Authorized mitigation history: applications, runs, inspect, refresh, evaluate
  maintenance <cmd>     Operator-only knowledge retention and erasure (preview by default)
  execution <cmd>       Opt-in task capture and authorized runtime report import/inspection
  review <cmd>          Project review program: validate, run, intake, scheduled (docs/review-program)
  help [command]        Show help
  version               Print the version

Exit codes: 0 success, 1 findings at or above --fail-on (or a failed operation), 2 usage or configuration error.
`;

const RULES_HELP = `Usage: ci-cd-optimizer rules [--format text|json|markdown] [--output <file>]`;

async function rulesCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: { format: { type: "string", short: "f", default: "text" }, output: { type: "string", short: "o" }, help: { type: "boolean", short: "h", default: false } } });
  if (values.help) {
    io.stdout(RULES_HELP);
    return 0;
  }
  let text: string;
  if (values.format === "markdown") text = renderRulesMarkdown(allRules);
  else if (values.format === "json") text = JSON.stringify(allRules.map((rule) => rule.meta), null, 2);
  else if (values.format === "text") {
    const width = Math.max(...allRules.map((rule) => rule.meta.id.length));
    text = allRules.map((rule) => `${rule.meta.id.padEnd(width)}  ${rule.meta.defaultSeverity.padEnd(5)}  ${rule.meta.fixable ? "fix" : "   "}  ${rule.meta.description}`).join("\n");
  } else throw new UsageError(`Unknown format "${values.format}". Use text, json, or markdown.`);
  await writeText(io, values.output, text);
  return 0;
}

const COMMANDS: Record<string, { run: (args: string[], io: CliIO) => Promise<number>; help: string }> = {
  lint: { run: lintCommand, help: LINT_HELP },
  rules: { run: rulesCommand, help: RULES_HELP },
  experiments: { run: experimentsCommand, help: EXPERIMENTS_HELP },
  recipes: { run: recipesCommand, help: RECIPES_HELP },
  scan: { run: scanCommand, help: SCAN_HELP },
  telemetry: { run: telemetryCommand, help: TELEMETRY_HELP },
  knowledge: { run: knowledgeCommand, help: KNOWLEDGE_HELP },
  maintenance: { run: maintenanceCommand, help: MAINTENANCE_HELP },
  execution: { run: executionCommand, help: EXECUTION_HELP },
  review: { run: reviewCommand, help: REVIEW_HELP },
};

/** Parses argv (without the node and script entries) and returns the exit code. Never calls process.exit. */
export async function run(argv: string[], io: CliIO): Promise<number> {
  const [first, ...rest] = argv;
  try {
    if (first === "version" || first === "--version" || first === "-v") {
      io.stdout(VERSION);
      return 0;
    }
    if (first === "help" || first === "--help" || first === "-h") {
      const topic = rest[0] ? COMMANDS[rest[0]] : undefined;
      io.stdout(topic?.help ?? HELP);
      return 0;
    }
    const command = first ? COMMANDS[first] : undefined;
    if (command) return await command.run(rest, io);
    // `ci-cd-optimizer [dir] [options]` lints like ESLint; anything else that looks like a command is a typo.
    if (first && !first.startsWith("-") && /^[a-z]+$/.test(first) && !(await isDirectory(io, first))) {
      throw new UsageError(`Unknown command "${first}". Commands: ${Object.keys(COMMANDS).join(", ")}, help, version.`);
    }
    return await lintCommand(argv, io);
  } catch (error) {
    if (error instanceof UsageError || isArgError(error)) {
      io.stderr(`ci-cd-optimizer: ${(error as Error).message}`);
      return 2;
    }
    io.stderr(`ci-cd-optimizer: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return 1;
  }
}

function isArgError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}

async function isDirectory(io: CliIO, path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  return stat(resolve(io.cwd, path)).then((info) => info.isDirectory(), () => false);
}
