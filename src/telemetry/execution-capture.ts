import { execFile, spawn } from "node:child_process";
import { lstat, open, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { executionCaches, executionProjectPath, executionTools, MAX_EXECUTION_BYTES, parseExecutionReport } from "../knowledge/execution.js";
import type { ExecutionReport } from "../knowledge/types.js";
import type { CliIO } from "../cli/io.js";

const exec = promisify(execFile);

export async function readExecutionJson(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error("Execution input must be a regular file");
    const buffer = Buffer.alloc(MAX_EXECUTION_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, size);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > MAX_EXECUTION_BYTES) throw new Error(`Execution input exceeds ${MAX_EXECUTION_BYTES} bytes`);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))) as unknown;
  } finally { await file.close(); }
}

/** Runs only when the user explicitly invokes capture on their runner; never called by the App or import path. */
export async function captureExecution(
  io: CliIO, options: { project: string; task: string; output: string; observations?: string },
  command: readonly string[],
): Promise<ExecutionReport> {
  if (!command[0]) throw new Error("Execution capture requires an executable after --");
  executionProjectPath(options.project);
  const root = await realpath(io.cwd);
  const output = resolve(root, options.output);
  if (!(await stat(dirname(output))).isDirectory()) throw new Error("Execution output parent must be an existing directory");
  try { await lstat(output); throw new Error("Execution output already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const env = { ...process.env, ...io.env };
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: root, env, maxBuffer: 4096 });
  if (await realpath(top.stdout.trim()) !== root) throw new Error("Run execution capture from the repository root");
  const directory = await realpath(resolve(root, options.project));
  const path = relative(root, directory);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Execution project resolves outside the repository");
  }
  const checkout = await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, env, maxBuffer: 4096 });
  const stamp = new Date().toISOString();
  const template = parseExecutionReport({
    version: 1, repository: { host: io.env.GITHUB_SERVER_URL, repositoryId: io.env.GITHUB_REPOSITORY_ID },
    runId: Number(io.env.GITHUB_RUN_ID), runAttempt: Number(io.env.GITHUB_RUN_ATTEMPT),
    headSha: io.env.GITHUB_SHA, checkoutSha: checkout.stdout.trim(), jobKey: io.env.GITHUB_JOB,
    projectPath: path ? path.split("\\").join("/") : ".", task: options.task,
    startedAt: stamp, completedAt: stamp, durationMs: 0, exitCode: 0, signal: null,
    tools: [{ name: "node", version: process.version, basis: "recorder-runtime" }], caches: [], coverage: "single-command",
  });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = await new Promise<{ exitCode: number | null; signal: string | null }>((resolveResult, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd: directory, env, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolveResult({ exitCode, signal }));
  });
  const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
  const completedAt = new Date().toISOString();
  let tools = template.tools;
  let caches = template.caches;
  if (options.observations) {
    const supplied = await readExecutionJson(resolve(root, options.observations));
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new Error("Runtime observations must be an object");
    const fields = supplied as { tools?: unknown; caches?: unknown };
    const additional = executionTools(fields.tools ?? []);
    if (additional.some((item) => item.name === "node" || item.basis !== "workflow-report")) {
      throw new Error("Additional tools must use workflow-report basis and must not override recorder Node");
    }
    tools = [...tools, ...additional];
    caches = executionCaches(fields.caches ?? []);
  }
  const report = parseExecutionReport({ ...template, ...result, startedAt, completedAt, durationMs, tools, caches });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return report;
}
