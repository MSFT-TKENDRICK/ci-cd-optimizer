import { appendFile } from "node:fs/promises";
import { actionInvocation } from "./cli/action.js";
import { run } from "./cli/index.js";
import { UsageError } from "./cli/io.js";

const write = (stream: NodeJS.WriteStream) => (text: string) => stream.write(text.endsWith("\n") ? text : `${text}\n`);

let code: number;
try {
  const { argv, cwd, env } = actionInvocation(process.argv.slice(2), process.env, process.cwd());
  code = await run(argv, { cwd, env, stdout: write(process.stdout), stderr: write(process.stderr) });
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(`::error::${error.message}\n`);
  code = 2;
}
if (process.env.GITHUB_OUTPUT && process.argv.length <= 2) await appendFile(process.env.GITHUB_OUTPUT, `exit-code=${code}\n`);
process.exitCode = code;
