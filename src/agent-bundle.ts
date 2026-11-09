#!/usr/bin/env node
// Entry point for the self-contained plugin server (npm run bundle:agents writes
// plugins/ci-cd-optimizer/server/cicd-agents.mjs). `mcp`, `acp`, and `lint` match the cicd-mcp, cicd-acp, and
// cicd-lint bins, so the plugin, ACP clients, and skill CLI fallbacks need Node.js 22+ but no npm install or build.
// `lint` imports the lint command directly, not the full CLI, so the bundle stays free of App-only dependencies.
// See docs/agents.md.
import { runAcp, runMcp } from "./agents/main.js";
import { readStream, UsageError, type CliIO } from "./cli/io.js";
import { lintCommand } from "./cli/lint.js";
import { VERSION } from "./version.js";

const line = (stream: NodeJS.WriteStream) => (text: string) => stream.write(text.endsWith("\n") ? text : `${text}\n`);

async function runLint(argv: string[]): Promise<number> {
  const io: CliIO = { cwd: process.cwd(), env: process.env, stdout: line(process.stdout), stderr: line(process.stderr), stdin: () => readStream(process.stdin) };
  if (argv[0] === "--version" || argv[0] === "-v") {
    io.stdout(VERSION);
    return 0;
  }
  try {
    return await lintCommand(argv, io);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (error instanceof UsageError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"))) {
      io.stderr(`cicd-lint: ${(error as Error).message}`);
      return 2;
    }
    io.stderr(`cicd-lint: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return 1;
  }
}

const [command, ...argv] = process.argv.slice(2);
if (command === "--version" || command === "-v") process.stdout.write(`${VERSION}\n`);
else if (command === "mcp") await runMcp(argv);
else if (command === "acp") await runAcp(argv);
else if (command === "lint") process.exitCode = await runLint(argv);
else {
  process.stderr.write("Usage: cicd-agents.mjs <mcp|acp|lint> [options]   (--help for each; --version)\n");
  process.exitCode = 2;
}