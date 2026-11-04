import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HillClimbConfig } from "./config.js";
import { evaluateCorpus, loadCorpus, loadEngine, type CorpusCase, type CorpusReport, type EngineModule } from "./corpus.js";
import { mergeMeasurement } from "./collect.js";
import type { BranchMeasurement, ExperimentMeasurements } from "./score.js";

export interface ExecResult {
  code: number;
  output: string;
}
export type Exec = (command: string, options: { cwd: string }) => Promise<ExecResult>;

export interface BranchEvaluation {
  arm: string;
  headSha?: string;
  testsPassed?: boolean;
  report?: CorpusReport;
  error?: string;
}

export interface EvaluateBranchesOptions {
  /** Git repository with the experiment branches fetched (for example `actions/checkout` with `fetch-depth: 0`). */
  root: string;
  measurements: ExperimentMeasurements;
  config: HillClimbConfig;
  engineVersion: number;
  exec: Exec;
  workdir?: string;
  loadEngine?: (modulePath: string, version: number) => Promise<EngineModule>;
  loadCorpus?: (directory: string) => Promise<CorpusCase[]>;
  log?: (message: string) => void;
}

const quote = (value: string) => `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
const tail = (text: string, lines = 20) => text.trim().split("\n").slice(-lines).join("\n");

/**
 * Builds the control and every arm in its own git worktree and scores each build on the corpus from the control.
 * Arm code is untrusted: run this only in a job with a read-only token, and apply decisions in a separate job.
 */
export async function evaluateBranches(options: EvaluateBranchesOptions): Promise<{ measurements: ExperimentMeasurements; evaluations: BranchEvaluation[] }> {
  const { root, config, exec } = options;
  const log = options.log ?? (() => undefined);
  const load = options.loadEngine ?? loadEngine;
  const workdir = options.workdir ?? (await mkdtemp(join(tmpdir(), "cicd-eval-")));
  const git = (args: string) => exec(`git ${args}`, { cwd: root });
  const evaluations: BranchEvaluation[] = [];
  let cases: CorpusCase[] | undefined;
  let corpusError: string | undefined;

  const branches: BranchMeasurement[] = [options.measurements.control, ...options.measurements.arms];
  for (const branch of branches) {
    const evaluation: BranchEvaluation = { arm: branch.arm, ...(branch.headSha ? { headSha: branch.headSha } : {}) };
    evaluations.push(evaluation);
    if (!branch.headSha) {
      evaluation.error = "no head commit to evaluate";
      continue;
    }
    const dir = join(workdir, branch.arm);
    try {
      if ((await git(`cat-file -e ${branch.headSha}^{commit}`)).code !== 0) {
        const fetched = await git(`fetch --no-tags origin ${branch.headSha}`);
        if (fetched.code !== 0) throw new Error(`git fetch failed:\n${tail(fetched.output)}`);
      }
      const added = await git(`worktree add --force --detach ${quote(dir)} ${branch.headSha}`);
      if (added.code !== 0) throw new Error(`git worktree add failed:\n${tail(added.output)}`);
      // The corpus always comes from the control so arms cannot grade themselves on an easier benchmark.
      if (branch.arm === "trunk") {
        try {
          cases = await (options.loadCorpus ?? loadCorpus)(join(dir, config.evaluation.corpus));
        } catch (error) {
          corpusError = `cannot load corpus: ${(error as Error).message}`;
        }
      }
      if (!cases) throw new Error(corpusError ?? "control was not evaluated");
      for (const [step, command] of [
        ["install", config.evaluation.install],
        ["build", config.evaluation.build],
      ] as const) {
        if (!command) continue;
        log(`[${branch.arm}] ${step}: ${command}`);
        const result = await exec(command, { cwd: dir });
        if (result.code !== 0) throw new Error(`${step} failed (exit ${result.code}):\n${tail(result.output)}`);
      }
      if (config.evaluation.test) {
        log(`[${branch.arm}] test: ${config.evaluation.test}`);
        const result = await exec(config.evaluation.test, { cwd: dir });
        evaluation.testsPassed = result.code === 0;
        if (!evaluation.testsPassed) log(`[${branch.arm}] tests failed:\n${tail(result.output)}`);
      } else {
        evaluation.testsPassed = true;
      }
      const engine = await load(join(dir, config.evaluation.engine), options.engineVersion);
      evaluation.report = evaluateCorpus(engine, cases, { timingRuns: config.evaluation.timingRuns });
      log(`[${branch.arm}] ${JSON.stringify(evaluation.report.metrics)}`);
    } catch (error) {
      evaluation.error = (error as Error).message;
      log(`[${branch.arm}] ${evaluation.error}`);
    } finally {
      await git(`worktree remove --force ${quote(dir)}`).catch(() => undefined);
    }
  }
  if (!options.workdir) await rm(workdir, { recursive: true, force: true }).catch(() => undefined);

  let measurements = options.measurements;
  for (const evaluation of evaluations) {
    measurements = mergeMeasurement(measurements, {
      arm: evaluation.arm,
      ...(evaluation.report ? { corpus: evaluation.report.metrics } : {}),
      ...(evaluation.testsPassed !== undefined ? { testsPassed: evaluation.testsPassed } : {}),
      ...(evaluation.error ? { error: evaluation.error } : {}),
    });
  }
  return { measurements, evaluations };
}
