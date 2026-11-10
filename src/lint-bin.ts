#!/usr/bin/env node
// `cicd-lint [paths...] [options]` is shorthand for `ci-cd-optimizer lint [paths...] [options]`.
import { run } from "./cli/index.js";
import { readStream } from "./cli/io.js";

const args = process.argv.slice(2);
const code = await run(args[0] === "--version" || args[0] === "-v" ? args : ["lint", ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
  stderr: (text) => process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
  stdin: () => readStream(process.stdin),
});
process.exitCode = code;
