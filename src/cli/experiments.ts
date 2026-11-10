import { appendFile, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { readFileAt } from "../github/git.js";
import type { GitHubClient, RepoRef } from "../github/client.js";
import { collectMeasurements, verifyCiMeasurements } from "../experiments/collect.js";
import { HILL_CLIMB_CONFIG_PATH, parseHillClimbConfig, type HillClimbConfig } from "../experiments/config.js";
import { evaluateCorpus, loadCorpus, loadEngine, parseCase } from "../experiments/corpus.js";
import { decide, renderDecision } from "../experiments/decide.js";
import { evaluateBranches } from "../experiments/evaluate.js";
import { applyDecision, createExperiment, groupExperiments, listExperimentPullRequests, resumeExperiment, type ExperimentState } from "../experiments/github.js";
import { armBranch, manifestPath, parseExperimentRef, parseManifest, trunkBranch, type ExperimentManifest } from "../experiments/manifest.js";
import { parseMeasurements } from "../experiments/measurements.js";
import { generatorContext, knownExperimentNames, validateProposal } from "../experiments/propose.js";
import { metricsFor, type ExperimentMeasurements } from "../experiments/score.js";
import { ENGINE_API_VERSION, lint } from "../lint/api.js";
import { loadDirectory } from "../lint/inventory.js";
import { allRules } from "../lint/rules/index.js";
import type { SourceFile } from "../lint/types.js";
import { githubClient, repoFrom, resolvePath, shellExec, UsageError, writeText, type CliIO } from "./io.js";
import { loadLintConfig } from "./lint.js";
import { ciPlanCommand, readCiEnvironment, searchBudgetOption } from "./ci-plan.js";

export const EXPERIMENTS_HELP = `Usage: ci-cd-optimizer experiments <command> [options]

Hill-climbing experiments on experiments/<name>/<arm> branches (see docs/experiments.md).

Commands:
  plan                      Exactly optimize a declared bounded CI environment (no publication)
  list                      Running experiments as JSON
  capacity                  Open experiment count and configured concurrency budget as JSON
  context                   Markdown briefing for the experiment generator agent
  create                    Validate a proposal and create its trunk branch, PR, and arm runs
  resume                    Recover interrupted trunk PR publication at an inspected commit
  collect                   Gather CI evidence for running experiments into measurement files
  evaluate                  Build each arm in a worktree and score it on the benchmark corpus
  decide                    Grade measurements and (with --apply) promote, reject, or request runs

Common options:
      --repo <owner/name>   Repository (default: $GITHUB_REPOSITORY)
      --config <file>       Hill-climb configuration (default: ${HILL_CLIMB_CONFIG_PATH})

create:    --manifest <file> | --agent-output <file>   [--cases <file.json>] [--base <branch>] [--arm-workflow <file>] [--dry-run]
resume:    --experiment <name> --expected-head <SHA> [--base <branch>] [--dry-run]
collect:   [--experiment <name>] --output-dir <dir> | --output <file>
evaluate:  --measurements <file|dir> [--repo-dir <dir>]  |  --engine <module> [--corpus <dir>]
decide:    --measurements <file|dir> [--agent-output <file>] [--apply]
context:   [--dir <dir>] [--telemetry <file>] [--model <ci-environment.json>] [--search-budget <policies>] [--output <file>]
plan:      --model <ci-environment.json> [--search-budget <policies>] [--output <file>]
           Exit 0: model optimum; 4: proved model infeasible; 5: budget exhausted (no partial result).
`;

const COMMON = {
  repo: { type: "string" },
  config: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} as const;

function workflowDispatchClient(io: CliIO, fallback: GitHubClient): GitHubClient {
  const token = io.env.CICD_OPTIMIZER_DISPATCH_TOKEN;
  return token ? githubClient({ ...io, env: { ...io.env, GITHUB_TOKEN: token } }) : fallback;
}

async function readText(io: CliIO, path: string): Promise<string> {
  try {
    return await readFile(resolvePath(io, path), "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read ${path}: ${(error as Error).message}`);
  }
}

async function loadHillClimbConfig(io: CliIO, explicit: string | undefined): Promise<HillClimbConfig> {
  const path = resolvePath(io, explicit ?? HILL_CLIMB_CONFIG_PATH);
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && !explicit) return undefined;
    throw new UsageError(`Cannot read ${path}: ${error.message}`);
  });
  const parsed = parseHillClimbConfig(text);
  if (parsed.problems.length > 0) throw new UsageError(`Invalid ${path}:\n${parsed.problems.map((p) => `  ${p.path || "(root)"}: ${p.message}`).join("\n")}`);
  return parsed.config;
}

async function loadManifest(client: GitHubClient, repo: RepoRef, name: string, config: HillClimbConfig, ref = trunkBranch(name)): Promise<ExperimentManifest> {
  const text = await readFileAt(client, repo, manifestPath(name), ref);
  if (text === undefined) throw new Error(`${manifestPath(name)} was not found at ${ref}`);
  const parsed = parseManifest(text, { config });
  if (!parsed.manifest) throw new Error(`${manifestPath(name)} is invalid: ${parsed.problems.map((p) => `${p.path}: ${p.message}`).join("; ")}`);
  return parsed.manifest;
}

interface RunningExperiment {
  state: ExperimentState;
  manifest?: ExperimentManifest;
  error?: string;
}

async function runningExperiments(client: GitHubClient, repo: RepoRef, config: HillClimbConfig, only?: string): Promise<RunningExperiment[]> {
  const states = groupExperiments(await listExperimentPullRequests(client, repo, "open")).filter((state) => state.trunk?.state === "open" && (!only || state.name === only));
  if (only && states.length === 0) throw new UsageError(`No open experiment named "${only}".`);
  const result: RunningExperiment[] = [];
  for (const state of states) {
    try {
      result.push({ state, manifest: await loadManifest(client, repo, state.name, config, state.trunk?.headSha) });
    } catch (error) {
      result.push({ state, error: (error as Error).message });
    }
  }
  return result;
}

/** Agent output from gh-aw (`$GH_AW_AGENT_OUTPUT`): `{ items: [{ type, ...inputs }] }`. */
async function agentItems(io: CliIO, path: string, type: string): Promise<Array<Record<string, unknown>>> {
  let data: unknown;
  try {
    data = JSON.parse(await readText(io, path));
  } catch (error) {
    throw new UsageError(`${path} is not valid agent output: ${(error as Error).message}`);
  }
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && (item as { type?: unknown }).type === type);
}

/** Inputs arrive as JSON strings, YAML strings, or already-parsed values depending on the agent. */
function structured(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return parse(value);
  }
}

async function measurementFiles(io: CliIO, path: string): Promise<string[]> {
  const target = resolvePath(io, path);
  const info = await stat(target).catch(() => undefined);
  if (!info) throw new UsageError(`${path} does not exist.`);
  if (!info.isDirectory()) return [target];
  return (await readdir(target)).filter((name) => name.endsWith(".json")).sort().map((name) => join(target, name));
}

const CASE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_CASES = 10;
const MAX_CASE_FILES = 50;
const MAX_CASE_BYTES = 200_000;

/** Validates agent-supplied benchmark cases and maps them to corpus paths on the new trunk. */
export async function caseFiles(io: CliIO, raw: unknown, config: HillClimbConfig): Promise<SourceFile[]> {
  const cases = structured(raw);
  if (cases === undefined || cases === null || cases === "") return [];
  if (!Array.isArray(cases)) throw new Error("cases: expected a list of { id, case, files }");
  if (cases.length > MAX_CASES) throw new Error(`cases: at most ${MAX_CASES} new cases per experiment`);
  const files: SourceFile[] = [];
  let bytes = 0;
  for (const [index, entry] of cases.entries()) {
    const item = (entry ?? {}) as { id?: unknown; case?: unknown; files?: unknown };
    const id = String(item.id ?? "");
    if (!CASE_ID.test(id)) throw new Error(`cases[${index}].id must be lowercase kebab-case`);
    const exists = await stat(resolvePath(io, join(config.evaluation.corpus, id))).then(() => true, () => false);
    if (exists) throw new Error(`cases[${index}]: corpus case "${id}" already exists; existing cases are immutable`);
    const caseText = typeof item.case === "string" ? item.case : JSON.stringify(item.case ?? {});
    const contents = (item.files ?? {}) as Record<string, unknown>;
    if (typeof contents !== "object" || Array.isArray(contents)) throw new Error(`cases[${index}].files must map paths to contents`);
    const entries = Object.entries(contents);
    if (entries.length === 0 || entries.length > MAX_CASE_FILES) throw new Error(`cases[${index}].files must contain 1-${MAX_CASE_FILES} files`);
    const sources: SourceFile[] = [];
    for (const [path, content] of entries) {
      if (typeof content !== "string") throw new Error(`cases[${index}].files["${path}"] must be text`);
      if (path.startsWith("/") || path.split("/").some((segment) => segment === ".." || segment === "") || path.includes("\\")) {
        throw new Error(`cases[${index}].files: invalid path "${path}"`);
      }
      bytes += content.length;
      sources.push({ path, content });
    }
    parseCase(id, caseText, sources);
    const base = `${config.evaluation.corpus}/${id}`;
    files.push({ path: `${base}/case.yml`, content: caseText }, ...sources.map((file) => ({ path: `${base}/files/${file.path}`, content: file.content })));
  }
  if (bytes > MAX_CASE_BYTES) throw new Error(`cases: ${bytes} bytes exceeds the ${MAX_CASE_BYTES}-byte budget`);
  return files;
}

async function listCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: { ...COMMON } });
  const config = await loadHillClimbConfig(io, values.config);
  const repo = repoFrom(values.repo, io);
  const running = await runningExperiments(githubClient(io), repo, config);
  const summary = running.map(({ state, manifest, error }) => ({
    name: state.name,
    ...(manifest ? { kind: manifest.kind, status: manifest.status, title: manifest.title, needsCorpus: metricsFor(manifest, config).some((m) => m.source === "corpus") } : {}),
    ...(error ? { error } : {}),
    trunk: state.trunk ? { number: state.trunk.number, headSha: state.trunk.headSha } : null,
    arms: state.arms.map((arm) => ({ arm: arm.arm, number: arm.number, headSha: arm.headSha, state: arm.state })),
  }));
  io.stdout(JSON.stringify(summary, null, 2));
  return 0;
}

async function capacityCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: { ...COMMON } });
  const config = await loadHillClimbConfig(io, values.config);
  const states = groupExperiments(await listExperimentPullRequests(githubClient(io), repoFrom(values.repo, io)));
  const running = states.filter((state) => state.trunk?.state === "open").length;
  const limit = config.selection.maxConcurrent;
  io.stdout(JSON.stringify({ running, limit, available: Math.max(0, limit - running) }));
  return 0;
}

async function contextCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: { ...COMMON, dir: { type: "string" }, telemetry: { type: "string" }, model: { type: "string" }, "search-budget": { type: "string" }, output: { type: "string", short: "o" } } });
  if (values["search-budget"] !== undefined && !values.model) throw new UsageError("context --search-budget requires --model.");
  const ciModel = values.model ? await readCiEnvironment(io, values.model) : undefined;
  const ciSearchBudget = searchBudgetOption(values["search-budget"]);
  const config = await loadHillClimbConfig(io, values.config);
  const repo = repoFrom(values.repo, io);
  const client = githubClient(io);
  const root = resolvePath(io, values.dir ?? ".");
  const { config: lintConfig } = await loadLintConfig(io, root, undefined);
  const input = await loadDirectory(root, lintConfig);
  const diagnostics = lint({ input, config: lintConfig, presets: ["all"] }).diagnostics;
  const history = await listExperimentPullRequests(client, repo, "all");
  const running = groupExperiments(history.filter((pull) => pull.state === "open"));
  const telemetry = values.telemetry ? await readText(io, values.telemetry) : undefined;
  const text = generatorContext({
    config,
    diagnostics,
    ...(telemetry ? { telemetry } : {}),
    ...(ciModel ? { ciModel, ciSearchBudget } : {}),
    running,
    history,
    rules: allRules.map((rule) => ({ id: rule.meta.id, description: rule.meta.description })),
  });
  await writeText(io, values.output, text);
  return 0;
}

async function createCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      ...COMMON,
      manifest: { type: "string" },
      "agent-output": { type: "string" },
      cases: { type: "string" },
      base: { type: "string" },
      "arm-workflow": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.manifest === !values["agent-output"]) throw new UsageError("create needs exactly one of --manifest or --agent-output.");
  const config = await loadHillClimbConfig(io, values.config);
  const repo = repoFrom(values.repo, io);
  const client = githubClient(io);
  const proposals: Array<{ manifest: string; cases?: unknown }> = values.manifest
    ? [{ manifest: await readText(io, values.manifest), ...(values.cases ? { cases: await readText(io, values.cases) } : {}) }]
    : (await agentItems(io, values["agent-output"] as string, "create_experiment")).map((item) => ({ manifest: String(item.manifest ?? ""), cases: item.cases }));
  if (proposals.length === 0) {
    io.stderr("No create_experiment proposals found.");
    return 0;
  }
  if (proposals.length > 1) throw new UsageError("create accepts only one proposal per invocation; recheck capacity before another proposal.");
  const history = await listExperimentPullRequests(client, repo, "all");
  const running = groupExperiments(history.filter((pull) => pull.state === "open"));
  const knownNames = knownExperimentNames(history);
  const base = values.base ?? io.env.GITHUB_REF_NAME ?? "main";
  let failed = false;
  for (const proposal of proposals) {
    const result = validateProposal(proposal.manifest, { config, running, knownNames, ...(io.now ? { now: io.now() } : {}) });
    let files: SourceFile[] = [];
    try {
      files = await caseFiles(io, proposal.cases, config);
    } catch (error) {
      result.errors.push((error as Error).message);
    }
    if (!result.manifest || result.errors.length > 0) {
      failed = true;
      io.stderr(`Proposal${result.manifest ? ` "${result.manifest.name}"` : ""} refused:\n${result.errors.map((error) => `  - ${error}`).join("\n")}`);
      continue;
    }
    const manifest = result.manifest;
    if (values["dry-run"]) {
      io.stdout(JSON.stringify({ name: manifest.name, rubric: result.rubric, arms: manifest.arms.map((arm) => arm.name), cases: files.length }, null, 2));
      continue;
    }
    const created = await createExperiment(client, repo, { manifest, baseBranch: base, config, files });
    knownNames.push(manifest.name);
    io.stdout(`Created ${created.trunk} (#${created.pullRequest}) at ${created.sha.slice(0, 7)}`);
    if (values["arm-workflow"]) {
      const dispatcher = workflowDispatchClient(io, client);
      for (const arm of manifest.arms) {
        await dispatcher.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          ...repo,
          workflow_id: values["arm-workflow"],
          ref: base,
          inputs: { experiment: manifest.name, arm: arm.name },
        });
        io.stdout(`Dispatched ${values["arm-workflow"]} for ${armBranch(manifest.name, arm.name)}`);
      }
    }
  }
  return failed ? 1 : 0;
}

async function resumeCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args, strict: true,
    options: { ...COMMON, experiment: { type: "string" }, "expected-head": { type: "string" }, base: { type: "string" }, "dry-run": { type: "boolean", default: false } },
  });
  if (!values.experiment || !parseExperimentRef(trunkBranch(values.experiment)) ||
    !values["expected-head"] || !/^[a-f0-9]{40}$/i.test(values["expected-head"])) {
    throw new UsageError("resume needs --experiment <name> and --expected-head <40-character SHA>.");
  }
  const result = await resumeExperiment(githubClient(io), repoFrom(values.repo, io), {
    name: values.experiment, expectedSha: values["expected-head"], config: await loadHillClimbConfig(io, values.config),
    ...(values.base ? { baseBranch: values.base } : {}), ...(io.now ? { now: io.now() } : {}), dryRun: values["dry-run"],
  });
  io.stdout(JSON.stringify(result, null, 2));
  io.stderr(values["dry-run"] ? "Recovery preview only; no changes made." : "Publication confirmed. No arm runs were dispatched; inspect existing PRs and runs before dispatching missing arms.");
  return 0;
}

async function collectCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: { ...COMMON, experiment: { type: "string" }, output: { type: "string", short: "o" }, "output-dir": { type: "string" } } });
  if (!values.output === !values["output-dir"]) throw new UsageError("collect needs exactly one of --output or --output-dir.");
  if (values.output && !values.experiment) throw new UsageError("--output needs --experiment; use --output-dir for every running experiment.");
  const config = await loadHillClimbConfig(io, values.config);
  const repo = repoFrom(values.repo, io);
  const client = githubClient(io);
  const now = io.now?.() ?? new Date();
  for (const { state, manifest, error } of await runningExperiments(client, repo, config, values.experiment)) {
    if (!manifest) {
      io.stderr(`Skipping ${state.name}: ${error ?? "no manifest"}`);
      continue;
    }
    if (manifest.status !== "running") continue;
    const measurements: ExperimentMeasurements = {
      ...(await collectMeasurements(client, repo, { manifest, state, config, now })),
      needsCorpus: metricsFor(manifest, config).some((metric) => metric.source === "corpus"),
    };
    const target = values.output ?? join(values["output-dir"] as string, `${manifest.name}.json`);
    await writeText(io, target, JSON.stringify(measurements, null, 2));
    io.stderr(`Collected ${manifest.name}: control + ${measurements.arms.length} arm(s) -> ${target}`);
  }
  return 0;
}

async function evaluateCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: { ...COMMON, measurements: { type: "string" }, "repo-dir": { type: "string" }, engine: { type: "string" }, corpus: { type: "string" }, output: { type: "string", short: "o" } },
  });
  const config = await loadHillClimbConfig(io, values.config);
  if (values.engine) {
    const engine = await loadEngine(resolvePath(io, values.engine), ENGINE_API_VERSION);
    const cases = await loadCorpus(resolvePath(io, values.corpus ?? config.evaluation.corpus));
    const report = evaluateCorpus(engine, cases, { timingRuns: config.evaluation.timingRuns });
    await writeText(io, values.output, JSON.stringify(report, null, 2));
    return report.totals.errors > 0 ? 1 : 0;
  }
  if (!values.measurements) throw new UsageError("evaluate needs --measurements (worktree mode) or --engine (single build).");
  const files = await measurementFiles(io, values.measurements);
  for (const file of files) {
    const measurements = parseMeasurements(await readFile(file, "utf8"));
    if (measurements.needsCorpus === false) continue;
    const result = await evaluateBranches({
      root: resolvePath(io, values["repo-dir"] ?? "."),
      measurements,
      config,
      engineVersion: ENGINE_API_VERSION,
      exec: io.exec ?? shellExec,
      log: (message) => io.stderr(message),
    });
    await writeText(io, values.output && files.length === 1 ? values.output : file, JSON.stringify(result.measurements, null, 2));
  }
  return 0;
}

interface Judgment {
  experiment: string;
  arm: string;
  score: number;
  rationale: string;
}

function judgments(items: Array<Record<string, unknown>>): Judgment[] {
  return items.flatMap((item) => {
    const list = structured(item.judgments);
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry) => {
      const judgment = (entry ?? {}) as Record<string, unknown>;
      const score = Number(judgment.score);
      if (typeof judgment.experiment !== "string" || typeof judgment.arm !== "string" || !Number.isFinite(score)) return [];
      return [{ experiment: judgment.experiment, arm: judgment.arm, score: Math.max(0, Math.min(1, score)), rationale: String(judgment.rationale ?? "").slice(0, 2000) }];
    });
  });
}

async function decideCommand(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: { ...COMMON, measurements: { type: "string" }, "agent-output": { type: "string" }, apply: { type: "boolean", default: false } },
  });
  if (!values.measurements) throw new UsageError("decide needs --measurements <file|dir>.");
  const config = await loadHillClimbConfig(io, values.config);
  const repo = repoFrom(values.repo, io);
  const client = githubClient(io);
  const judged = values["agent-output"] ? judgments(await agentItems(io, values["agent-output"], "grade_experiments")) : [];
  const states = groupExperiments(await listExperimentPullRequests(client, repo, "open"));
  const now = io.now?.() ?? new Date();
  const reports: string[] = [];
  for (const file of await measurementFiles(io, values.measurements)) {
    let measurements = parseMeasurements(await readFile(file, "utf8"));
    const name = measurements.experiment;
    const state = states.find((candidate) => candidate.name === name);
    if (!state?.trunk) {
      io.stderr(`Skipping ${name}: no open trunk pull request.`);
      continue;
    }
    const manifest = await loadManifest(client, repo, name, config, state.trunk.headSha);
    for (const judgment of judged.filter((candidate) => candidate.experiment === name && candidate.arm !== "trunk")) {
      if (measurements.arms.some((arm) => arm.arm === judgment.arm)) {
        measurements = { ...measurements, arms: measurements.arms.map((arm) => (arm.arm === judgment.arm ? { ...arm, judge: { score: judgment.score, rationale: judgment.rationale } } : arm)) };
      }
    }
    const decision = decide(manifest, measurements, config, { now, trunkRef: trunkBranch(name), armRef: (arm) => armBranch(name, arm) });
    reports.push(renderDecision(manifest, decision));
    if (values.apply) {
      if (decision.action === "promote") await verifyCiMeasurements(client, repo, { manifest, measurements, config });
      const applied = await applyDecision(client, repo, { manifest, decision, state, config, measurements, dispatchClient: workflowDispatchClient(io, client) });
      io.stderr(`${name}: ${applied.action}${applied.merged ? ` (merged #${applied.merged})` : ""}${applied.closed.length ? `, closed ${applied.closed.map((n) => `#${n}`).join(", ")}` : ""}${applied.dispatched ? `, dispatched ${applied.dispatched} run(s)` : ""}${applied.notes.length ? `; ${applied.notes.join("; ")}` : ""}`);
    } else {
      io.stderr(`${name}: ${decision.action} (dry run; pass --apply to act)`);
    }
  }
  const summary = reports.join("\n\n---\n\n") || "No running experiments to grade.";
  io.stdout(summary);
  if (io.env.GITHUB_STEP_SUMMARY) await appendFile(io.env.GITHUB_STEP_SUMMARY, `${summary}\n`, "utf8").catch(() => undefined);
  return 0;
}

const COMMANDS: Record<string, (args: string[], io: CliIO) => Promise<number>> = {
  plan: ciPlanCommand,
  list: listCommand,
  capacity: capacityCommand,
  context: contextCommand,
  create: createCommand,
  resume: resumeCommand,
  collect: collectCommand,
  evaluate: evaluateCommand,
  decide: decideCommand,
};

export async function experimentsCommand(args: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || rest.includes("--help") || rest.includes("-h")) {
    io.stdout(EXPERIMENTS_HELP);
    return command && !COMMANDS[command] && command !== "--help" && command !== "-h" ? 2 : 0;
  }
  const handler = COMMANDS[command];
  if (!handler) throw new UsageError(`Unknown experiments command "${command}". Commands: ${Object.keys(COMMANDS).join(", ")}.`);
  return handler(rest, io);
}
