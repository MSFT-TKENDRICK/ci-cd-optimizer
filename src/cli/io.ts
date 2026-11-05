import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { GitHubClient, RepoRef } from "../github/client.js";
import { parseRepo, restClient } from "../github/rest.js";
import type { Exec } from "../experiments/evaluate.js";
import type { KnowledgeStore } from "../knowledge/types.js";

export type { Exec, ExecResult } from "../experiments/evaluate.js";

export interface CliIO {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Injected in tests; defaults to a fetch client authenticated with GITHUB_TOKEN / GH_TOKEN. */
  github?: () => GitHubClient;
  exec?: Exec;
  now?: () => Date;
  /** Initialized, caller-owned knowledge store for embedded clients/tests. */
  knowledgeStore?: () => Promise<KnowledgeStore>;
}

/** Wrong arguments or configuration (exit code 2, like ESLint). */
export class UsageError extends Error {
  override name = "UsageError";
}

export function githubClient(io: CliIO): GitHubClient {
  if (io.github) return io.github();
  const token = io.env.GITHUB_TOKEN ?? io.env.GH_TOKEN;
  return restClient({ ...(token ? { token } : {}), ...(io.env.GITHUB_API_URL ? { baseUrl: io.env.GITHUB_API_URL } : {}) });
}

/** A client authenticated as a Copilot-licensed user (COPILOT_ASSIGN_TOKEN) for assigning issues to the coding agent. */
export function copilotClient(io: CliIO): GitHubClient | undefined {
  const token = io.env.COPILOT_ASSIGN_TOKEN;
  if (!token) return undefined;
  return githubClient({ ...io, env: { ...io.env, GITHUB_TOKEN: token, GH_TOKEN: token } });
}

export function repoFrom(value: string | undefined, io: CliIO): RepoRef {
  try {
    return parseRepo(value ?? io.env.GITHUB_REPOSITORY);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

export const resolvePath = (io: CliIO, path: string) => (isAbsolute(path) ? path : resolve(io.cwd, path));

export async function writeText(io: CliIO, path: string | undefined, text: string): Promise<void> {
  if (!path || path === "-") {
    io.stdout(text);
    return;
  }
  const target = resolvePath(io, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text.endsWith("\n") ? text : `${text}\n`, "utf8");
}

const MAX_OUTPUT = 64 * 1024;

/** Runs a shell command, capturing combined output (truncated to the tail) instead of streaming it. */
export const shellExec: Exec = (command, options) =>
  new Promise((resolveResult) => {
    const child = spawn(command, { cwd: options.cwd, shell: true, env: { ...process.env, CI: "true" } });
    let output = "";
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => resolveResult({ code: 127, output: `${output}${error.message}` }));
    child.on("close", (code) => resolveResult({ code: code ?? 1, output }));
  });
