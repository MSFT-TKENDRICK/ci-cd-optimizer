import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HILL_CLIMB_CONFIG } from "../../src/experiments/config.js";
import { parseMeasurements } from "../../src/experiments/measurements.js";
import {
  CI_ENVIRONMENT_SCHEMA, CI_MODEL_LIMITS, CI_MODEL_MAX_BYTES, parseCiEnvironmentModel, planCiEnvironment,
  type CiEnvironmentModel, type CiExecutionMode, type CiModelJob, type PlannedCiJob,
} from "../../src/experiments/plan.js";
import { generatorContext } from "../../src/experiments/propose.js";
import { CiPolicy } from "../../src/formal/generated/kernel.js";
import { canonicalJson, object, parseStrictJson } from "../../src/formal/json.js";

const fixture = parseCiEnvironmentModel(readFileSync(new URL("./fixtures/ci-environment.json", import.meta.url), "utf8"));
const mode = (durationTicks: number, costUnits = 0, runnerDemand = 1, id = "default"): CiExecutionMode =>
  ({ id, durationTicks, costUnits, runnerDemand });
const job = (id: string, modes: CiExecutionMode[], needs: string[] = []): CiModelJob => ({ id, needs, modes });
const environment = (jobs: CiModelJob[], overrides: Partial<CiEnvironmentModel> = {}): CiEnvironmentModel => ({
  schema: CI_ENVIRONMENT_SCHEMA, timeUnitSeconds: 1, horizonTicks: 4, runnerCapacity: 1, maxCostUnits: 10, jobs, ...overrides,
});

afterEach(() => vi.restoreAllMocks());

// Independent small-model oracle: reverse DFS, including start=horizon (which feasibility must reject).
// It computes occupied slots directly and compares a lexicographic vector, not generated ranks or predicates.
function oracle(model: CiEnvironmentModel) {
  const placements: Array<{ mode: number; start: number }> = [];
  let best: { score: number[]; schedule: PlannedCiJob[]; usage: number[]; policyId: number } | undefined;
  const visit = (index: number): void => {
    const current = model.jobs[index];
    if (current) {
      for (let m = current.modes.length - 1; m >= 0; m -= 1) {
        for (let start = model.horizonTicks; start >= 0; start -= 1) {
          placements[index] = { mode: m, start };
          visit(index + 1);
        }
      }
      return;
    }
    const schedule = model.jobs.map((spec, i) => {
      const placement = placements[i];
      assert(placement);
      const selected = spec.modes[placement.mode];
      assert(selected);
      return {
        job: spec.id, mode: selected.id, startTick: placement.start,
        finishTick: placement.start + selected.durationTicks,
        runnerDemand: selected.runnerDemand, costUnits: selected.costUnits,
      };
    });
    const cost = schedule.reduce((sum, entry) => sum + entry.costUnits, 0);
    if (cost > model.maxCostUnits || schedule.some((entry) => entry.finishTick > model.horizonTicks)) return;
    for (const [j, spec] of model.jobs.entries()) {
      for (const dependency of spec.needs) {
        const predecessor = schedule.find((entry) => entry.job === dependency);
        const entry = schedule[j];
        assert(predecessor && entry);
        if (predecessor.finishTick > entry.startTick) return;
      }
    }
    const usage = Array.from({ length: model.horizonTicks }, (_, tick) => schedule
      .filter((entry) => entry.startTick <= tick && tick < entry.finishTick)
      .reduce((sum, entry) => sum + entry.runnerDemand, 0));
    if (usage.some((load) => load > model.runnerCapacity)) return;
    const score = [Math.max(0, ...schedule.map((entry) => entry.finishTick)), cost, ...placements.flatMap((entry) => [entry.mode, entry.start])];
    const different = best ? score.findIndex((value, i) => value !== best?.score[i]) : 0;
    if (best && (different === -1 || score[different]! >= best.score[different]!)) return;
    const policyId = placements.reduce((rank, entry, i) => rank * model.horizonTicks * model.jobs[i]!.modes.length +
      entry.mode * model.horizonTicks + entry.start, 0);
    best = { score, schedule, usage, policyId };
  };
  visit(0);
  return best;
}

function compareWithOracle(model: CiEnvironmentModel): void {
  const expected = oracle(model);
  const actual = planCiEnvironment(model);
  const count = model.jobs.reduce((product, spec) => product * spec.modes.length * model.horizonTicks, 1);
  assert.equal(actual.search.requiredPolicies, count);
  assert.equal(actual.search.examinedPolicies, count);
  assert.equal(actual.search.complete, true);
  if (!expected) {
    assert.equal(actual.status, "infeasible");
    assert(!Object.hasOwn(actual, "schedule"));
    return;
  }
  assert.equal(actual.status, "optimal");
  if (actual.status !== "optimal") throw new Error("Missing optimizer result.");
  assert.deepEqual(actual.objective, { makespanTicks: expected.score[0], costUnits: expected.score[1] });
  assert.deepEqual(actual.schedule, expected.schedule);
  assert.deepEqual(actual.runnerUsageByTick, expected.usage);
  assert.equal(actual.policyId, expected.policyId);
}

describe("production modeled CI planning", () => {
  it("executes the generated optimizer and defeats greedy budget allocation", () => {
    const generated = vi.spyOn(CiPolicy.__default, "Optimize");
    const result = planCiEnvironment(fixture);
    expect(generated).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "optimal", policyId: 130,
      objective: { makespanTicks: 3, costUnits: 3 },
      schedule: [
        { job: "prepare", mode: "slow", startTick: 0, finishTick: 2 },
        { job: "test", mode: "fast", startTick: 2, finishTick: 3 },
      ],
      search: { requiredPolicies: 256, examinedPolicies: 256, complete: true },
      nextStep: "validate-as-experiment",
    });
    // Choosing the first job's fast mode would consume the budget and force a seven-tick chain.
    compareWithOracle(fixture);
  });

  it("does not mistake an unlimited-runner critical path for an achievable schedule", () => {
    const model = environment([job("a", [mode(3)]), job("b", [mode(1)])]);
    expect(planCiEnvironment(model)).toMatchObject({
      status: "optimal", objective: { makespanTicks: 4, costUnits: 0 },
      schedule: [{ startTick: 0, finishTick: 3 }, { startTick: 3, finishTick: 4 }],
      runnerUsageByTick: [1, 1, 1, 1],
    });
    expect(planCiEnvironment({ ...model, runnerCapacity: 2 })).toMatchObject({ status: "optimal", objective: { makespanTicks: 3 } });
    compareWithOracle(model);
  });

  it("chooses a slower, lower-demand mode when it yields a faster complete schedule", () => {
    const model = environment([
      job("a", [mode(1, 5, 2, "fast-wide"), mode(3, 1, 1, "slow-narrow")]),
      job("b", [mode(3)]),
    ], { runnerCapacity: 2, maxCostUnits: 5 });
    expect(planCiEnvironment(model)).toMatchObject({
      status: "optimal", policyId: 16, objective: { makespanTicks: 3, costUnits: 1 },
      schedule: [{ mode: "slow-narrow", startTick: 0, finishTick: 3 }, { startTick: 0, finishTick: 3 }],
      runnerUsageByTick: [2, 2, 2, 0],
    });
    compareWithOracle(model);
  });

  it("enforces dependencies as well as capacity, and releases half-open intervals at finish", () => {
    const model = environment([
      job("a", [mode(2)]), job("b", [mode(2)]), job("join", [mode(1)], ["a", "b"]),
    ], { runnerCapacity: 2, horizonTicks: 5 });
    expect(planCiEnvironment(model)).toMatchObject({
      status: "optimal", objective: { makespanTicks: 3 },
      schedule: [{ startTick: 0 }, { startTick: 0 }, { startTick: 2, finishTick: 3 }],
      runnerUsageByTick: [2, 2, 1, 0, 0],
    });
    compareWithOracle(model);
  });

  it("minimizes cost after makespan, then uses stable input-order mode/start ties", () => {
    const model = environment([job("a", [mode(2, 3, 1, "first"), mode(2, 1, 1, "cheaper")])]);
    expect(planCiEnvironment(model)).toMatchObject({ status: "optimal", policyId: 4, objective: { makespanTicks: 2, costUnits: 1 }, schedule: [{ mode: "cheaper", startTick: 0 }] });
    const tied = environment([job("a", [mode(2, 1, 1, "zeta"), mode(2, 1, 1, "alpha")])]);
    expect(planCiEnvironment(tied)).toMatchObject({ status: "optimal", policyId: 0, schedule: [{ mode: "zeta" }] });
    expect(planCiEnvironment(tied)).toEqual(planCiEnvironment(structuredClone(tied)));
    compareWithOracle(model);
    compareWithOracle(tied);
  });

  it("handles the empty environment and all distinct sources of infeasibility", () => {
    expect(planCiEnvironment(environment([]), { searchBudget: 1 })).toMatchObject({
      status: "optimal", policyId: 0, objective: { makespanTicks: 0, costUnits: 0 }, schedule: [],
      runnerUsageByTick: [0, 0, 0, 0], search: { requiredPolicies: 1, examinedPolicies: 1, complete: true },
    });
    const impossible = [
      environment([job("a", [mode(5)])]),
      environment([job("a", [mode(1, 1)])], { maxCostUnits: 0 }),
      environment([job("a", [mode(1, 0, 2)])]),
      environment([job("a", [mode(1)]), job("b", [mode(1)])], { horizonTicks: 1 }),
      environment([job("a", [mode(1)]), job("b", [mode(1)], ["a"])], { horizonTicks: 1, runnerCapacity: 2 }),
    ];
    for (const model of impossible) {
      expect(planCiEnvironment(model)).toMatchObject({ status: "infeasible", search: { complete: true } });
      compareWithOracle(model);
    }
  });

  it("refuses insufficient budgets before any feasibility search, without a partial optimum", () => {
    const feasible = vi.spyOn(CiPolicy.__default, "Feasible");
    const result = planCiEnvironment(fixture, { searchBudget: 255 });
    expect(result).toMatchObject({ status: "budget-exhausted", search: { requiredPolicies: 256, examinedPolicies: 0, complete: false } });
    expect(feasible).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("policyId");
    expect(result).not.toHaveProperty("objective");
    expect(result).not.toHaveProperty("schedule");
    expect(planCiEnvironment(fixture, { searchBudget: 256 }).status).toBe("optimal");
    const largest = environment(Array.from({ length: 8 }, (_, i) =>
      job(`job-${i}`, Array.from({ length: 4 }, (_, j) => mode(32, 1_000_000, 8, `mode-${j}`)))),
    { horizonTicks: 16, runnerCapacity: 8, maxCostUnits: 8_000_000 });
    expect(planCiEnvironment(largest, { searchBudget: CI_MODEL_LIMITS.maxSearchBudget })).toMatchObject({
      status: "budget-exhausted", search: { requiredPolicies: 281_474_976_710_656, examinedPolicies: 0, complete: false },
    });
  });

  it.each([1, 2])("matches an independent exhaustive oracle with %i modes per job", (modeCount) => {
    let models = 0;
    for (const aDuration of [1, 2]) for (const bDuration of [1, 2]) {
      for (const aCost of [0, 1]) for (const bCost of [0, 1]) {
        for (const aDemand of [1, 2]) for (const bDemand of [1, 2]) {
          for (const horizonTicks of [1, 2, 3]) for (const runnerCapacity of [1, 2]) {
            for (const maxCostUnits of [0, 1, 2]) for (const dependent of [false, true]) {
              const a = [mode(aDuration, aCost, aDemand, "first")];
              const b = [mode(bDuration, bCost, bDemand, "first")];
              if (modeCount === 2) {
                a.push(mode(3 - aDuration, 1 - aCost, 3 - aDemand, "second"));
                b.push(mode(3 - bDuration, 1 - bCost, 3 - bDemand, "second"));
              }
              compareWithOracle(environment([job("a", a), job("b", b, dependent ? ["a"] : [])],
                { horizonTicks, runnerCapacity, maxCostUnits }));
              models += 1;
            }
          }
        }
      }
    }
    expect(models).toBe(2304);
  }, 90_000);
});

describe("modeled planning fails closed at its input boundary", () => {
  it("keeps the published schema's bounds aligned with the actual generated model", () => {
    const schema = object(parseStrictJson(readFileSync(new URL("../../formal/ci-environment.schema.json", import.meta.url), "utf8")), "schema");
    const properties = object(schema.properties, "properties");
    const definitions = object(schema.$defs, "definitions");
    const jobs = object(object(definitions.job, "job").properties, "job properties");
    const modes = object(object(definitions.mode, "mode").properties, "mode properties");
    expect(properties.schema).toEqual({ const: CI_ENVIRONMENT_SCHEMA });
    expect(properties.timeUnitSeconds).toMatchObject({ minimum: 1, maximum: CI_MODEL_LIMITS.maxTimeUnitSeconds });
    expect(properties.horizonTicks).toMatchObject({ minimum: 1, maximum: CI_MODEL_LIMITS.maxHorizonTicks });
    expect(properties.runnerCapacity).toMatchObject({ minimum: 1, maximum: CI_MODEL_LIMITS.maxRunnerUnits });
    expect(properties.maxCostUnits).toMatchObject({ minimum: 0, maximum: CI_MODEL_LIMITS.maxJobs * CI_MODEL_LIMITS.maxModeCostUnits });
    expect(properties.jobs).toMatchObject({ maxItems: CI_MODEL_LIMITS.maxJobs });
    expect(jobs.needs).toMatchObject({ maxItems: CI_MODEL_LIMITS.maxJobs, uniqueItems: true });
    expect(jobs.modes).toMatchObject({ minItems: 1, maxItems: CI_MODEL_LIMITS.maxModes });
    expect(modes.durationTicks).toMatchObject({ minimum: 1, maximum: CI_MODEL_LIMITS.maxDurationTicks });
    expect(modes.costUnits).toMatchObject({ minimum: 0, maximum: CI_MODEL_LIMITS.maxModeCostUnits });
    expect(modes.runnerDemand).toMatchObject({ minimum: 1, maximum: CI_MODEL_LIMITS.maxRunnerUnits });
  });

  it("rejects unknown semantics, caller scores, malformed JSON and invalid numerics", () => {
    for (const field of ["score", "optimal", "retries", "preemptive", "workflow", "runnerAffinity", "releaseTime"]) {
      const invalid = { ...fixture, [field]: true };
      expect(() => parseCiEnvironmentModel(JSON.stringify(invalid))).toThrow(/Unknown/);
      expect(() => planCiEnvironment(invalid)).toThrow(/Unknown/);
    }
    const text = JSON.stringify(fixture);
    expect(() => parseCiEnvironmentModel(text.replace('"horizonTicks":8', '"horizonTicks":8,"horizonTicks":8'))).toThrow(/Duplicate/);
    for (const token of ["1e999", "9007199254740993", "-0", "1.5", "true", "null", '"8"']) {
      expect(() => parseCiEnvironmentModel(text.replace('"horizonTicks":8', `"horizonTicks":${token}`))).toThrow();
    }
    for (const value of [NaN, Infinity, -Infinity, -0, -1, 0, 1.5, 17, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => planCiEnvironment({ ...fixture, horizonTicks: value })).toThrow();
    }
    for (const budget of [0, -1, 0.5, NaN, Infinity, CI_MODEL_LIMITS.maxSearchBudget + 1]) {
      expect(() => planCiEnvironment(fixture, { searchBudget: budget })).toThrow();
    }
    expect(() => parseCiEnvironmentModel(" ".repeat(CI_MODEL_MAX_BYTES + 1))).toThrow(/byte input limit/);
    expect(() => parseCiEnvironmentModel(text.replace('"prepare"', '"\\ud800"'))).toThrow(/surrogate/);
  });

  it("rejects cycles, unknown or duplicate identifiers, and unordered dependency graphs", () => {
    const invalid = [
      environment([job("a", [mode(1)], ["a"])]),
      environment([job("a", [mode(1)], ["b"]), job("b", [mode(1)], ["a"])]),
      environment([job("a", [mode(1)], ["b"]), job("b", [mode(1)])]),
      environment([job("a", [mode(1)], ["missing"])]),
      environment([job("a", [mode(1)]), job("b", [mode(1)], ["a", "a"])]),
      environment([job("a", [mode(1)]), job("a", [mode(1)])]),
      environment([job("a", [mode(1), mode(2)])]),
      environment([job("a", [])]),
      environment([job("a", [mode(1, 0, 0)])]),
      environment([job("a", [mode(0)])]),
      environment([job("a", [mode(33)])]),
      environment([job("a", [mode(1, -1)])]),
      environment([job("a", [mode(1, 1_000_001)])]),
      environment([job("a", [mode(1, 0, 9)])]),
      environment([], { runnerCapacity: 0 }),
      environment([], { timeUnitSeconds: 0 }),
      environment([], { maxCostUnits: 8_000_001 }),
      environment(Array.from({ length: 9 }, (_, i) => job(`j-${i}`, [mode(1)]))),
      environment([job("a", Array.from({ length: 5 }, (_, i) => mode(1, 0, 1, `m-${i}`)))]),
    ];
    for (const model of invalid) expect(() => planCiEnvironment(model)).toThrow();
  });

  it("recomputes model planning in the experiment-generator surface without bypassing promotion", () => {
    const context = { config: DEFAULT_HILL_CLIMB_CONFIG, running: [], history: [], rules: [] };
    const text = generatorContext({ ...context, ciModel: fixture });
    expect(text).toContain('"makespanTicks": 3');
    expect(text).toContain('"status": "optimal"');
    expect(text).toContain("never as measured evidence or permission to promote");
    expect(text).toContain("No workflow-to-model mapping");
    expect(generatorContext({ ...context, ciModel: fixture, ciSearchBudget: 1 })).toContain('"status": "budget-exhausted"');
    expect(generatorContext(context)).toContain("No CI environment model was supplied");
    expect(() => parseMeasurements(canonicalJson(planCiEnvironment(fixture)))).toThrow();
  });
});
