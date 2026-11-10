# Provable bounded CI policy planning

`experiments plan` computes a **global optimum of an explicitly declared finite CI environment**. It executes
the mechanically verified, generated [`CiPolicy.Optimize`](../formal/CiPolicy.dfy), not a handwritten optimizer
or a ranking of caller-supplied scores. Its policy space contains every choice of execution mode and every
admissible integer start time for every job, subject to the model's dependencies, capacity, horizon and cost limit.

This is a conditional scheduling guarantee. **No workflow-to-model mapping is verified.** Jobs, mode equivalence,
durations, costs and available capacity are declarations. Binding a model to a Git blob identifies its input
bytes; it does not prove correspondence to a workflow, correct execution, authenticated measurements or a future
speedup. The [empirical promotion gates](experiments.md#controlled-ci-observations-and-migration) remain separate.

## Run a model

From a source checkout with installed dependencies:

```sh
npm run cli -- experiments plan --model test/formal/fixtures/ci-environment.json --output plan.json
```

The [committed example](../test/formal/fixtures/ci-environment.json) is a synthetic two-job counterexample to
greedy optimization, **not measured telemetry**:

```json
{
  "schema": "cicd-optimizer/ci-environment-v1",
  "timeUnitSeconds": 30,
  "horizonTicks": 8,
  "runnerCapacity": 1,
  "maxCostUnits": 3,
  "jobs": [
    {
      "id": "prepare",
      "needs": [],
      "modes": [
        { "id": "fast", "durationTicks": 1, "costUnits": 3, "runnerDemand": 1 },
        { "id": "slow", "durationTicks": 2, "costUnits": 0, "runnerDemand": 1 }
      ]
    },
    {
      "id": "test",
      "needs": ["prepare"],
      "modes": [
        { "id": "fast", "durationTicks": 1, "costUnits": 3, "runnerDemand": 1 },
        { "id": "slow", "durationTicks": 6, "costUnits": 0, "runnerDemand": 1 }
      ]
    }
  ]
}
```

The exact result is `optimal`, policy identifier `130`, makespan **3 ticks**, cost **3 units**:
`prepare/slow` runs `[0,2)`; `test/fast` runs `[2,3)`. All **256** policies were examined.
Greedily choosing fast preparation consumes the budget and forces the six-tick test, taking seven ticks instead.
Thirty seconds per tick is only this example's declared scale, not a measured runtime prediction.

Other tested cases make runner capacity binding: two independent jobs of durations three and one take four
ticks on one runner, not the unlimited-runner critical-path bound of three. A faster mode requiring two runners
can also produce a worse complete schedule than a slower one that allows useful parallelism.

## Exact supported semantics

- Jobs appear in explicit topological order. `needs` names earlier jobs; cycles, self-dependencies, unknown or
  future references, duplicate job IDs, duplicate dependencies and duplicate per-job mode IDs are errors.
- Every job executes exactly once, in exactly one selected mode. Modes are declared to perform equivalent work;
  that declaration is not verified against arbitrary code.
- Starts are nonnegative integer ticks; durations are positive integers. Execution is nonpreemptive. All jobs
  are available initially except for their listed finish-to-start dependencies.
- A selected mode occupies `runnerDemand` fungible runner units throughout `[start,finish)`. Total occupied
  capacity cannot exceed the constant `runnerCapacity`. The pool is assumed dedicated: external queues,
  heterogeneous runner affinity and unmodeled contention are not represented.
- Every finish is at most `horizonTicks`. Execution cost is the sum of chosen mode costs, not runner time or
  an inferred cloud bill, and must be at most `maxCostUnits`.
- The objective is lexicographic: minimum actual modeled makespan, then minimum total cost, then minimum
  policy identifier. Makespan is the maximum job finish, or zero for no jobs.
- Job and mode array order determine exact ties, not identifier spelling or locale. A job's digit is
  `modeIndex * horizonTicks + startTick`; digits are joined in mixed radix, first job most significant.

Unknown fields are rejected, not ignored. Retries, conditional/dynamic jobs, release times, preemption,
fractional schedules, resource affinities and other semantics require a different model. There is no automatic
YAML extraction, rounding of observed times, discovery of equivalent modes, or extrapolation from telemetry.
Include setup and relevant cache effects in declared durations, and independently validate those assumptions.

### Input and search bounds

The [JSON Schema](../formal/ci-environment.schema.json) is an editor aid. The strict runtime decoder additionally
checks graph/identifier constraints, duplicate JSON keys, malformed Unicode and invalid numeric representations.
Do not add a `$schema` property to the input; associate the schema through editor configuration instead.

| Input | Supported range |
|---|---|
| Jobs | 0–8 |
| Modes per job | 1–4 |
| Horizon | 1–16 ticks |
| Duration per mode | 1–32 ticks |
| Capacity and mode demand | 1–8 runner units |
| Mode cost | 0–1,000,000 integer units |
| Total cost limit | 0–8,000,000 units |
| Seconds per tick | 1–86,400, a display/interpretation scale only |
| Identifiers | 1–64 ASCII characters matching `[A-Za-z0-9][A-Za-z0-9._-]*` |
| Model input | At most 64,000 UTF-8 bytes |
| Search budget | 1–250,000 policies; default 50,000 |

Durations exceeding the horizon or demands exceeding capacity are valid declarations that can make the model
infeasible. They are not silently dropped or reinterpreted.

Search is exponential. Its exact size is `product(horizonTicks * modes[j].length)`; the empty product is one.
The largest allowed raw space is `64^8 = 281474976710656`, counted exactly. The generated kernel uses unbounded
integer arithmetic; the adapter rejects unsafe conversions.

Before enumeration the optimizer compares the **whole** space with `--search-budget`. If too large, it returns
`budget-exhausted`, zero examined policies, no schedule/objective and no optimality or infeasibility claim.
It does not search a favorable subset, silently approximate, or return an incumbent as optimal. A budget counts
policies, not milliseconds; work per policy depends on the number of jobs, dependencies and horizon. Even a
valid bounded model can exceed the maximum permitted budget. Narrowing its declared domain changes the claim.

| Planning exit | Outcome |
|---|---|
| `0` | `optimal`: returned schedule is feasible and globally optimal **within this model** |
| `4` | `infeasible`: complete search established that no feasible modeled policy exists |
| `5` | `budget-exhausted`: no complete search; neither optimum nor infeasibility established |
| `1` | Invalid/unsupported model, malformed data or failed operation |
| `2` | CLI usage or search-budget option error |

Output includes the model digest, compiled proof-build identifiers, all assumptions, exact search counts and
the outcome. Optimal results additionally include the schedule, resource usage per tick and
`nextStep: "validate-as-experiment"`, never a promotion authorization.

## What makes the optimum complete

[`CiPolicy.dfy`](../formal/CiPolicy.dfy) defines executable feasibility independently of the optimizer's
enumeration. Positive duration and finish-at-most-horizon imply every feasible start is below the horizon
(`FeasibleInDomain`). `DecodeEncode` proves every policy in that full domain has an enumerated identifier;
`EncodeDecode` proves the converse identity.

The optimizer's loop relates its winner to every feasible already-examined identifier. After full enumeration,
the coverage lemmas lift that invariant to **every feasible placement sequence**, not an arbitrary supplied
candidate list. `MakespanSemantics` characterizes the maximum finish time. `Optimize` proves feasibility,
semantic objective values and `GlobalOptimum`, as well as complete-search infeasibility in both directions.
`UniqueOptimum`, the identifier bijection and the total ordering establish a deterministic canonical optimum.
Invalid inputs and budget exhaustion are distinct result constructors without a policy.

The proof concerns discrete schedules in the declared finite domain, not all policies of an actual workflow.
See the [trusted computing base](formal-verification.md#trusted-computing-base) for compiler/runtime and adapter
assumptions. Exhaustive independent small-model tests exercise the bridge; they do not replace these theorems.

## Source-bound, independently recomputed certificates

Commit your reviewed model, obtain its full commit ID with `git rev-parse HEAD`, then:

```sh
npm run cli -- formal ci-plan --source <repository> --commit <full-commit-id> \
  --path ci-environment.json --search-budget 50000 --output plan-certificate.json
npm run cli -- formal check plan-certificate.json --source <repository>
```

The checker reruns the verified optimizer from the embedded model and explicit budget. It recomputes the full
schedule, objective, resource use, search coverage, assumptions, installed proof metadata and digest; none are
trusted because the certificate asserts them. With `--source`, exact immutable `commit:path` bytes are compared.
Working-tree edits do not change an old committed model. A self-consistent invented commit cannot pass source binding.

These are **certificate validity** exits: `0` source-bound-valid, `3` model-valid without source binding,
`1` invalid, `2` usage. Inspect the separate `resultStatus` (`optimal`, `infeasible`, `budget-exhausted`).
A correctly recomputed exhaustion certificate can be source-bound-valid; that does not make it an optimum.
The digest is not a signature, and source binding is not a workflow correspondence proof.

## Production planning integration and typed API

The real experiment-generator briefing accepts the same model:

```sh
npm run cli -- experiments context --repo <owner/repository> --model ci-environment.json \
  --search-budget 50000 --output context.md
```

`generatorContext` recomputes the plan rather than accepting a claimed optimum. Without a model it explicitly
warns that telemetry and observed candidate scores do not prove scheduling optimality. The scheduled generator
does not invent a model automatically. A plan must be translated into a reviewed experimental candidate and
validated against actual workload and resource assumptions; it never replaces measured-evidence promotion gates.

After `npm run build`, TypeScript/ESM clients can import the independent planning module:

```js
import { parseCiEnvironmentModel, planCiEnvironment } from "./dist/experiments/plan.js";
const model = parseCiEnvironmentModel(modelJsonText);
const plan = planCiEnvironment(model, { searchBudget: 50000 });
```

`CiEnvironmentModel`, `CiEnvironmentPlan`, `CiPlanOptions` and generated-model limits are exported with declarations.
Typed callers are validated again at runtime. The lint `ENGINE_API_VERSION = 1` contract is unchanged.
Proof/toolchain commands and shipped-bundle checks are documented in [formal verification](formal-verification.md#verification-and-regeneration).
