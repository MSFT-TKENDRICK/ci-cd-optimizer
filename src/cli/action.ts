import { isAbsolute, resolve } from "node:path";
import { UsageError } from "./io.js";

/**
 * Splits an action `args` input into argv. Whitespace (including newlines from YAML block scalars)
 * separates arguments; single quotes are literal; double quotes allow `\"` and `\\` escapes.
 */
export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inArg = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) current += input[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inArg = true;
    } else if (/\s/.test(ch)) {
      if (inArg) args.push(current);
      current = "";
      inArg = false;
    } else {
      current += ch;
      inArg = true;
    }
  }
  if (quote) throw new UsageError(`Unterminated ${quote} quote in args input.`);
  if (inArg) args.push(current);
  return args;
}

export interface ActionInvocation {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const input = (env: NodeJS.ProcessEnv, name: string) => (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();

/**
 * Maps a process invocation to CLI argv. Explicit argv (local `node dist-action/index.js lint .`) wins;
 * otherwise the action inputs `command`, `args`, `token`, and `working-directory` are used.
 */
export function actionInvocation(argv: string[], env: NodeJS.ProcessEnv, processCwd: string): ActionInvocation {
  if (argv.length > 0) return { argv, cwd: processCwd, env };
  const workspace = env.GITHUB_WORKSPACE || processCwd;
  const dir = input(env, "working-directory");
  const token = input(env, "token");
  return {
    argv: [input(env, "command") || "lint", ...splitArgs(env.INPUT_ARGS ?? "")],
    cwd: dir ? (isAbsolute(dir) ? dir : resolve(workspace, dir)) : workspace,
    env: token ? { ...env, GITHUB_TOKEN: token } : env,
  };
}
