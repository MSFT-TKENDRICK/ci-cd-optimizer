import { BigNumber } from "bignumber.js";
import { CiPolicy, Dafny } from "../formal/generated/kernel.js";
import { PROOF_BUILD } from "../formal/generated/manifest.js";
import { canonicalJson, exactKeys, integer, object, parseStrictJson, sha256, string, type Json } from "../formal/json.js";

export const CI_ENVIRONMENT_SCHEMA = "cicd-optimizer/ci-environment-v1";
export const CI_PLAN_SCHEMA = "cicd-optimizer/ci-plan-v1";
export const CI_MODEL_MAX_BYTES = 64_000;

function safeNumber(value: BigNumber, label: string): number {
  if (!BigNumber.isBigNumber(value) || !value.isInteger()) throw new Error(`Invalid generated ${label}.`);
  const number = value.toNumber();
  if (!Number.isSafeInteger(number) || Object.is(number, -0) || number < 0 || !value.eq(number)) throw new Error(`Generated ${label} exceeds the safe integer range.`);
  return number;
}

export const CI_MODEL_LIMITS = Object.freeze({
  maxJobs: safeNumber(CiPolicy.__default.MaxJobs, "job bound"),
  maxModes: safeNumber(CiPolicy.__default.MaxModes, "mode bound"),
  maxHorizonTicks: safeNumber(CiPolicy.__default.MaxHorizon, "horizon bound"),
  maxDurationTicks: safeNumber(CiPolicy.__default.MaxDuration, "duration bound"),
  maxRunnerUnits: safeNumber(CiPolicy.__default.MaxCapacity, "capacity bound"),
  maxModeCostUnits: safeNumber(CiPolicy.__default.MaxModeCost, "cost bound"),
  maxSearchBudget: safeNumber(CiPolicy.__default.MaxSearchBudget, "search bound"),
  defaultSearchBudget: safeNumber(CiPolicy.__default.DefaultSearchBudget, "default search budget"),
  maxTimeUnitSeconds: 86_400,
});

export const CI_MODEL_ASSUMPTIONS = Object.freeze([
  "The jobs, dependencies and interchangeable execution modes describe the intended workload by declaration. No workflow-to-model mapping or arbitrary-code semantic equivalence is verified.",
  "Each selected mode has the declared deterministic positive integer duration, fixed nonnegative execution cost and positive pooled runner demand. Setup, cache effects and other relevant work must already be included in those declarations; telemetry is not authenticated here.",
  "All jobs execute once, nonpreemptively, at integer ticks within the declared horizon. All are initially available except for listed finish-to-start dependencies. The constant fungible runner pool is dedicated to this model, with no external queueing or unmodeled contention.",
  "Cost is the sum of selected mode costs. Resource use occupies half-open [start,finish) intervals. The objective is lexicographic makespan, then cost, then input-order mixed-radix policy identifier.",
  "Optimality and infeasibility concern every admissible schedule in this bounded model, not omitted modes, fractional starts, other horizons, dynamic jobs, heterogeneous runner affinities, retries, or arbitrary real CI behavior. Search-budget exhaustion proves neither optimality nor infeasibility.",
  "Git source binding identifies the committed model input only. It does not prove correspondence to a workflow, correctness of duration profiles, evidence authenticity, future speedup, or statistical significance.",
  "An optimal plan is a candidate for validation, not permission to promote. Existing measured-evidence and correctness gates remain mandatory for experimental promotion.",
] as const);

export interface CiExecutionMode {
  id: string;
  durationTicks: number;
  costUnits: number;
  runnerDemand: number;
}

export interface CiModelJob {
  id: string;
  needs: string[];
  modes: CiExecutionMode[];
}

export interface CiEnvironmentModel {
  schema: typeof CI_ENVIRONMENT_SCHEMA;
  timeUnitSeconds: number;
  horizonTicks: number;
  runnerCapacity: number;
  maxCostUnits: number;
  /** Jobs must be in explicit topological order; job and mode array order breaks exact ties. */
  jobs: CiModelJob[];
}

export interface CiPlanOptions { searchBudget?: number }

export interface PlannedCiJob {
  job: string;
  mode: string;
  startTick: number;
  finishTick: number;
  runnerDemand: number;
  costUnits: number;
}

interface PlanBase {
  schema: typeof CI_PLAN_SCHEMA;
  modelSha256: string;
  proof: typeof PROOF_BUILD;
  assumptions: typeof CI_MODEL_ASSUMPTIONS;
  timeUnitSeconds: number;
  search: { budget: number; requiredPolicies: number; examinedPolicies: number; complete: boolean };
}

export type CiEnvironmentPlan = PlanBase & (
  | {
    status: "optimal";
    policyId: number;
    objective: { makespanTicks: number; costUnits: number };
    schedule: PlannedCiJob[];
    runnerUsageByTick: number[];
    nextStep: "validate-as-experiment";
  }
  | { status: "infeasible" }
  | { status: "budget-exhausted" }
);

function identifier(value: Json | undefined, label: string): string {
  const id = string(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`${label} must be a nonempty ASCII model identifier of at most 64 characters.`);
  return id;
}

function array(value: Json | undefined, label: string, maximum: number): Json[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be an array of at most ${maximum} entries.`);
  return value;
}

/** Strict input decoding: unsupported fields and semantics are errors, never silently ignored. */
export function parseCiEnvironmentModel(text: string): CiEnvironmentModel {
  if (Buffer.byteLength(text, "utf8") > CI_MODEL_MAX_BYTES) throw new Error(`CI environment exceeds the ${CI_MODEL_MAX_BYTES} byte input limit.`);
  const model = object(parseStrictJson(text), "CI environment");
  exactKeys(model, ["schema", "timeUnitSeconds", "horizonTicks", "runnerCapacity", "maxCostUnits", "jobs"], "CI environment");
  if (model.schema !== CI_ENVIRONMENT_SCHEMA) throw new Error(`Expected schema ${CI_ENVIRONMENT_SCHEMA}.`);
  const seenJobs = new Set<string>();
  const jobs = array(model.jobs, "jobs", CI_MODEL_LIMITS.maxJobs).map((value, jobIndex): CiModelJob => {
    const label = `jobs[${jobIndex}]`;
    const job = object(value, label);
    exactKeys(job, ["id", "needs", "modes"], label);
    const id = identifier(job.id, `${label}.id`);
    if (seenJobs.has(id)) throw new Error(`Duplicate job identifier: ${id}.`);
    const needs = array(job.needs, `${label}.needs`, CI_MODEL_LIMITS.maxJobs).map((entry) => identifier(entry, `${label}.needs`));
    if (new Set(needs).size !== needs.length) throw new Error(`Duplicate dependency in ${label}.needs.`);
    for (const dependency of needs) {
      if (!seenJobs.has(dependency)) throw new Error(`${label}.needs: ${dependency} must name an earlier job. Explicit topological order is required; cycles, self-dependencies and unknown jobs are invalid.`);
    }
    const seenModes = new Set<string>();
    const modes = array(job.modes, `${label}.modes`, CI_MODEL_LIMITS.maxModes).map((entry, modeIndex): CiExecutionMode => {
      const location = `${label}.modes[${modeIndex}]`;
      const mode = object(entry, location);
      exactKeys(mode, ["id", "durationTicks", "costUnits", "runnerDemand"], location);
      const modeId = identifier(mode.id, `${location}.id`);
      if (seenModes.has(modeId)) throw new Error(`Duplicate mode identifier in ${label}: ${modeId}.`);
      seenModes.add(modeId);
      return {
        id: modeId,
        durationTicks: integer(mode.durationTicks, `${location}.durationTicks`, 1, CI_MODEL_LIMITS.maxDurationTicks),
        costUnits: integer(mode.costUnits, `${location}.costUnits`, 0, CI_MODEL_LIMITS.maxModeCostUnits),
        runnerDemand: integer(mode.runnerDemand, `${location}.runnerDemand`, 1, CI_MODEL_LIMITS.maxRunnerUnits),
      };
    });
    if (!modes.length) throw new Error(`${label}.modes must contain at least one mode.`);
    seenJobs.add(id);
    return { id, needs, modes };
  });
  return {
    schema: CI_ENVIRONMENT_SCHEMA,
    timeUnitSeconds: integer(model.timeUnitSeconds, "timeUnitSeconds", 1, CI_MODEL_LIMITS.maxTimeUnitSeconds),
    horizonTicks: integer(model.horizonTicks, "horizonTicks", 1, CI_MODEL_LIMITS.maxHorizonTicks),
    runnerCapacity: integer(model.runnerCapacity, "runnerCapacity", 1, CI_MODEL_LIMITS.maxRunnerUnits),
    maxCostUnits: integer(model.maxCostUnits, "maxCostUnits", 0, CI_MODEL_LIMITS.maxJobs * CI_MODEL_LIMITS.maxModeCostUnits),
    jobs,
  };
}

/** The production planner executes the verified generated optimizer, not a handwritten search. */
export function planCiEnvironment(input: CiEnvironmentModel, options: CiPlanOptions = {}): CiEnvironmentPlan {
  const model = parseCiEnvironmentModel(canonicalJson(input));
  const request = object(parseStrictJson(canonicalJson(options)), "planning options");
  exactKeys(request, ["searchBudget"], "planning options");
  const budget = request.searchBudget === undefined ? CI_MODEL_LIMITS.defaultSearchBudget
    : integer(request.searchBudget, "searchBudget", 1, CI_MODEL_LIMITS.maxSearchBudget);
  const jobs = Dafny.Seq.of(...model.jobs.map((job) => CiPolicy.Job.create_Job(
    Dafny.Seq.of(...job.modes.map((mode) => CiPolicy.Mode.create_Mode(
      new BigNumber(mode.durationTicks), new BigNumber(mode.costUnits), new BigNumber(mode.runnerDemand),
    ))),
    Dafny.Seq.of(...job.needs.map((id) => new BigNumber(model.jobs.findIndex((entry) => entry.id === id)))),
  )));
  const environment = CiPolicy.Environment.create_Environment(
    jobs, new BigNumber(model.horizonTicks), new BigNumber(model.runnerCapacity), new BigNumber(model.maxCostUnits),
  );
  const result = CiPolicy.__default.Optimize(environment, new BigNumber(budget));
  if (result.is_Invalid) throw new Error("The generated optimizer rejected this environment or budget.");
  if (!result.is_Exhausted && !result.is_Infeasible && !result.is_Optimal) throw new Error("Unexpected generated optimizer result.");
  const requiredPolicies = safeNumber(result.is_Exhausted ? result.dtor_required : result.dtor_examined, "policy count");
  const base: PlanBase = {
    schema: CI_PLAN_SCHEMA,
    modelSha256: sha256(`${CI_ENVIRONMENT_SCHEMA}\0${canonicalJson(model)}`),
    proof: PROOF_BUILD,
    assumptions: CI_MODEL_ASSUMPTIONS,
    timeUnitSeconds: model.timeUnitSeconds,
    search: { budget, requiredPolicies, examinedPolicies: result.is_Exhausted ? 0 : requiredPolicies, complete: !result.is_Exhausted },
  };
  if (result.is_Exhausted) return { ...base, status: "budget-exhausted" };
  if (result.is_Infeasible) return { ...base, status: "infeasible" };
  if (result.dtor_policy.length !== model.jobs.length) throw new Error("Generated policy has the wrong number of jobs.");
  const schedule = model.jobs.map((job, index): PlannedCiJob => {
    const placement = result.dtor_policy[index];
    const modeIndex = safeNumber(placement.dtor_mode, "mode index");
    const mode = job.modes[modeIndex];
    if (!mode) throw new Error("Generated mode is outside the declared model.");
    return {
      job: job.id, mode: mode.id,
      startTick: safeNumber(placement.dtor_start, "start tick"),
      finishTick: safeNumber(CiPolicy.__default.Finish(jobs, result.dtor_policy, new BigNumber(index)), "finish tick"),
      runnerDemand: mode.runnerDemand, costUnits: mode.costUnits,
    };
  });
  return {
    ...base,
    status: "optimal",
    policyId: safeNumber(result.dtor_rank, "policy identifier"),
    objective: {
      makespanTicks: safeNumber(result.dtor_objective.dtor_makespan, "makespan"),
      costUnits: safeNumber(result.dtor_objective.dtor_cost, "cost"),
    },
    schedule,
    runnerUsageByTick: Array.from({ length: model.horizonTicks }, (_, tick) => safeNumber(
      CiPolicy.__default.Load(jobs, result.dtor_policy, new BigNumber(tick), new BigNumber(model.jobs.length)), "runner load",
    )),
    nextStep: "validate-as-experiment",
  };
}
