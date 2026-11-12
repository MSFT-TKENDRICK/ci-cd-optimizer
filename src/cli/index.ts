import { parseArgs } from "node:util";
import { allRules } from "../lint/rules/index.js";
import { ruleAssurance } from "../lint/assurance.js";
import { renderRulesMarkdown } from "../lint/docs.js";
import { VERSION } from "../version.js";
import { UsageError, writeText, type CliIO } from "./io.js";
import { lintCommand, LINT_HELP, ruleListText } from "./lint.js";

export const HELP = `ci-cd-optimizer ${VERSION} - a CI/CD performance linter and optimizer for GitHub repositories

Usage: ci-cd-optimizer <command> [options]

Commands:
  lint [paths...]       Lint workflows, Dockerfiles, and package manifests (default command; also \`cicd-lint\`)
  rules                 List rules (--format json|markdown)
  scan                  Scan a repository via the API like the App: SARIF, finding issues, autofix PRs
  telemetry             Report on a completed workflow run (Gantt, critical path) and raise duration alerts
  doctor                Diagnose workflow failures; attempt safe local repairs (--report-only to observe)
  experiments <cmd>     Conditional CI model planning and measured experiments: plan, context, create, collect, evaluate, decide
  recipes <cmd>         Reusable fixes from promoted experiments: publish, apply, status, rollout
  knowledge <cmd>       Authorized mitigation history: applications, runs, inspect, refresh, evaluate
  maintenance <cmd>     Operator-only knowledge retention and erasure (preview by default)
  execution <cmd>       Opt-in task capture and authorized runtime report import/inspection
  review <cmd>          Project review program: validate, run, intake, scheduled (docs/review-program)
  formal <cmd>          Input-bound cache-key, finite-selection and CI model planning certificates (docs/formal-verification)
  ssdf                 Report repository-visible evidence against NIST SP 800-218 SSDF v1.1
  help [command]        Show help
  version               Print the version

Exit codes: 0 success, 1 findings at or above --fail-on (or a failed operation), 2 usage or configuration error.
Planning also uses 4 for proved model infeasibility and 5 for exhausted search; formal check uses 3 for model-only validity.
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
  else if (values.format === "json") text = JSON.stringify(allRules.map((rule) => ({ ...rule.meta, assurance: ruleAssurance(rule.meta.id) })), null, 2);
  else if (values.format === "text") text = ruleListText(allRules);
  else throw new UsageError(`Unknown format "${values.format}". Use text, json, or markdown.`);
  await writeText(io, values.output, text);
  return 0;
}

type Command = { run: (args: string[], io: CliIO) => Promise<number>; help: string };

const COMMANDS: Record<string, () => Promise<Command>> = {
  lint: async () => ({ run: lintCommand, help: LINT_HELP }),
  rules: async () => ({ run: rulesCommand, help: RULES_HELP }),
  experiments: async () => { const m = await import("./experiments.js"); return { run: m.experimentsCommand, help: m.EXPERIMENTS_HELP }; },
  recipes: async () => { const m = await import("./recipes.js"); return { run: m.recipesCommand, help: m.RECIPES_HELP }; },
  scan: async () => { const m = await import("./scan.js"); return { run: m.scanCommand, help: m.SCAN_HELP }; },
  telemetry: async () => { const m = await import("./telemetry.js"); return { run: m.telemetryCommand, help: m.TELEMETRY_HELP }; },
  knowledge: async () => { const m = await import("./knowledge.js"); return { run: m.knowledgeCommand, help: m.KNOWLEDGE_HELP }; },
  maintenance: async () => { const m = await import("./maintenance.js"); return { run: m.maintenanceCommand, help: m.MAINTENANCE_HELP }; },
  execution: async () => { const m = await import("./execution.js"); return { run: m.executionCommand, help: m.EXECUTION_HELP }; },
  review: async () => { const m = await import("./review.js"); return { run: m.reviewCommand, help: m.REVIEW_HELP }; },
  formal: async () => { const m = await import("./formal.js"); return { run: m.formalCommand, help: m.FORMAL_HELP }; },
  ssdf: async () => { const m = await import("./ssdf.js"); return { run: m.ssdfCommand, help: m.SSDF_HELP }; },
  doctor: async () => { const m = await import("./doctor.js"); return { run: m.doctorCommand, help: m.DOCTOR_HELP }; },
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
      const topic = rest[0] && Object.hasOwn(COMMANDS, rest[0]) ? await COMMANDS[rest[0]]?.() : undefined;
      io.stdout(topic?.help ?? HELP);
      return 0;
    }
    const command = first && Object.hasOwn(COMMANDS, first) ? await COMMANDS[first]?.() : undefined;
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
