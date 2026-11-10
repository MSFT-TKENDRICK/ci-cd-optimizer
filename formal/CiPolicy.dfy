// Exact, nonpreemptive integer-time scheduling over a declared finite CI environment.
// Durations, costs, resource demands and mode equivalence are inputs, not execution attestations.
module CiPolicy {
  const MaxJobs: int := 8
  const MaxModes: int := 4
  const MaxHorizon: int := 16
  const MaxDuration: int := 32
  const MaxCapacity: int := 8
  const MaxModeCost: int := 1000000
  const MaxSearchBudget: int := 250000
  const DefaultSearchBudget: int := 50000

  datatype Mode = Mode(duration: int, cost: int, demand: int)
  datatype Job = Job(modes: seq<Mode>, needs: seq<int>)
  datatype Environment = Environment(jobs: seq<Job>, horizon: int, capacity: int, costLimit: int)
  datatype Placement = Placement(mode: int, start: int)
  datatype Objective = Objective(makespan: int, cost: int)
  datatype Result =
    Invalid |
    Exhausted(required: int) |
    Infeasible(examined: int) |
    Optimal(examined: int, rank: int, policy: seq<Placement>, objective: Objective)

  predicate ValidMode(mode: Mode) {
    1 <= mode.duration <= MaxDuration &&
    0 <= mode.cost <= MaxModeCost && 1 <= mode.demand <= MaxCapacity
  }

  predicate Valid(environment: Environment) {
    |environment.jobs| <= MaxJobs &&
    1 <= environment.horizon <= MaxHorizon &&
    1 <= environment.capacity <= MaxCapacity &&
    0 <= environment.costLimit <= MaxJobs * MaxModeCost &&
    forall j | 0 <= j < |environment.jobs| ::
      1 <= |environment.jobs[j].modes| <= MaxModes &&
      (forall mode | mode in environment.jobs[j].modes :: ValidMode(mode)) &&
      (forall dependency | dependency in environment.jobs[j].needs :: 0 <= dependency < j)
  }

  predicate DomainParameters(jobs: seq<Job>, horizon: int) {
    horizon > 0 && forall job | job in jobs :: |job.modes| > 0
  }

  predicate Choices(jobs: seq<Job>, policy: seq<Placement>) {
    |jobs| == |policy| &&
    forall j | 0 <= j < |jobs| :: 0 <= policy[j].mode < |jobs[j].modes|
  }

  predicate InDomain(jobs: seq<Job>, horizon: int, policy: seq<Placement>) {
    Choices(jobs, policy) &&
    forall j | 0 <= j < |jobs| :: 0 <= policy[j].start < horizon
  }

  function Finish(jobs: seq<Job>, policy: seq<Placement>, j: int): int
    requires Choices(jobs, policy) && 0 <= j < |jobs|
  { policy[j].start + jobs[j].modes[policy[j].mode].duration }

  function Cost(jobs: seq<Job>, policy: seq<Placement>, n: nat): int
    requires Choices(jobs, policy) && n <= |jobs|
    decreases n
  {
    if n == 0 then 0 else
      Cost(jobs, policy, n - 1) + jobs[n - 1].modes[policy[n - 1].mode].cost
  }

  function Max(a: int, b: int): int { if a >= b then a else b }

  function Makespan(jobs: seq<Job>, policy: seq<Placement>, n: nat): int
    requires Choices(jobs, policy) && n <= |jobs|
    decreases n
  {
    if n == 0 then 0 else Max(Makespan(jobs, policy, n - 1), Finish(jobs, policy, n - 1))
  }

  // Half-open intervals release capacity exactly at their finish tick.
  function Load(jobs: seq<Job>, policy: seq<Placement>, tick: int, n: nat): int
    requires Choices(jobs, policy) && n <= |jobs|
    decreases n
  {
    if n == 0 then 0 else
      Load(jobs, policy, tick, n - 1) +
        (if policy[n - 1].start <= tick < Finish(jobs, policy, n - 1)
         then jobs[n - 1].modes[policy[n - 1].mode].demand else 0)
  }

  opaque predicate Feasible(environment: Environment, policy: seq<Placement>)
    requires Valid(environment)
  {
    Choices(environment.jobs, policy) &&
    (forall j | 0 <= j < |environment.jobs| ::
      0 <= policy[j].start && Finish(environment.jobs, policy, j) <= environment.horizon) &&
    Cost(environment.jobs, policy, |environment.jobs|) <= environment.costLimit &&
    (forall j | 0 <= j < |environment.jobs| ::
      forall dependency | dependency in environment.jobs[j].needs ::
        Finish(environment.jobs, policy, dependency) <= policy[j].start) &&
    (forall tick | 0 <= tick < environment.horizon ::
      Load(environment.jobs, policy, tick, |environment.jobs|) <= environment.capacity)
  }

  function Evaluate(environment: Environment, policy: seq<Placement>): Objective
    requires Choices(environment.jobs, policy)
  {
    Objective(Makespan(environment.jobs, policy, |environment.jobs|),
      Cost(environment.jobs, policy, |environment.jobs|))
  }

  lemma MakespanSemantics(jobs: seq<Job>, policy: seq<Placement>, n: nat)
    requires Choices(jobs, policy) && n <= |jobs|
    ensures 0 <= Makespan(jobs, policy, n)
    ensures forall j | 0 <= j < n :: Finish(jobs, policy, j) <= Makespan(jobs, policy, n)
    ensures Makespan(jobs, policy, n) == 0 ||
      exists j | 0 <= j < n :: Makespan(jobs, policy, n) == Finish(jobs, policy, j)
    decreases n
  {
    if n > 0 {
      MakespanSemantics(jobs, policy, n - 1);
    }
  }

  lemma FeasibleInDomain(environment: Environment, policy: seq<Placement>)
    requires Valid(environment) && Feasible(environment, policy)
    ensures InDomain(environment.jobs, environment.horizon, policy)
  {
    reveal Feasible();
    forall j | 0 <= j < |environment.jobs|
      ensures 0 <= policy[j].start < environment.horizon
    {
      assert ValidMode(environment.jobs[j].modes[policy[j].mode]);
    }
  }

  // Each job chooses one mode and any integer start in [0,horizon).
  // Positive duration makes that start range complete for every feasible schedule.
  function PolicyCount(jobs: seq<Job>, horizon: int): int
    requires DomainParameters(jobs, horizon)
    ensures PolicyCount(jobs, horizon) > 0
    decreases |jobs|
  {
    if |jobs| == 0 then 1 else
      horizon * |jobs[0].modes| * PolicyCount(jobs[1..], horizon)
  }

  lemma ProductNonnegative(a: int, b: int)
    requires 0 <= a && 0 <= b
    ensures 0 <= a * b
  {}

  lemma QuotientBounds(n: int, d: int, size: int)
    requires d > 0 && size > 0 && 0 <= n < d * size
    ensures 0 <= n / d < size
  {
    assert n == (n / d) * d + n % d;
    if n / d >= size {
      ProductNonnegative(n / d - size, d);
      assert false;
    }
  }

  lemma DivisionParts(q: int, d: int, r: int)
    requires 0 <= q && d > 0 && 0 <= r < d
    ensures (q * d + r) / d == q && (q * d + r) % d == r
  {
    var n := q * d + r;
    var actual := n / d;
    assert n == actual * d + n % d;
    if actual < q {
      ProductNonnegative(q - actual - 1, d);
      assert n % d >= d;
      assert false;
    }
    if actual > q {
      ProductNonnegative(actual - q - 1, d);
      assert r >= d;
      assert false;
    }
  }

  lemma JoinedRankBounds(digit: int, tail: int, radix: int, tailCount: int)
    requires 0 <= digit < radix && 0 <= tail < tailCount
    ensures 0 <= digit * tailCount + tail < radix * tailCount
  {
    ProductNonnegative(digit, tailCount);
    ProductNonnegative(radix - digit - 1, tailCount);
  }

  function Decode(jobs: seq<Job>, horizon: int, rank: int): seq<Placement>
    requires DomainParameters(jobs, horizon)
    requires 0 <= rank < PolicyCount(jobs, horizon)
    ensures InDomain(jobs, horizon, Decode(jobs, horizon, rank))
    decreases |jobs|
  {
    if |jobs| == 0 then [] else
      var tailCount := PolicyCount(jobs[1..], horizon);
      QuotientBounds(rank, tailCount, horizon * |jobs[0].modes|);
      var digit := rank / tailCount;
      QuotientBounds(digit, horizon, |jobs[0].modes|);
      [Placement(digit / horizon, digit % horizon)] +
        Decode(jobs[1..], horizon, rank % tailCount)
  }

  function Encode(jobs: seq<Job>, horizon: int, policy: seq<Placement>): int
    requires DomainParameters(jobs, horizon) && InDomain(jobs, horizon, policy)
    ensures 0 <= Encode(jobs, horizon, policy) < PolicyCount(jobs, horizon)
    decreases |jobs|
  {
    if |jobs| == 0 then 0 else
      var digit := policy[0].mode * horizon + policy[0].start;
      var tailCount := PolicyCount(jobs[1..], horizon);
      var tailRank := Encode(jobs[1..], horizon, policy[1..]);
      JoinedRankBounds(policy[0].mode, policy[0].start, |jobs[0].modes|, horizon);
      JoinedRankBounds(digit, tailRank, horizon * |jobs[0].modes|, tailCount);
      digit * tailCount + tailRank
  }

  // This is the coverage theorem, not an assumption that supplied candidates are complete.
  lemma DecodeEncode(jobs: seq<Job>, horizon: int, policy: seq<Placement>)
    requires DomainParameters(jobs, horizon) && InDomain(jobs, horizon, policy)
    ensures Decode(jobs, horizon, Encode(jobs, horizon, policy)) == policy
    decreases |jobs|
  {
    if |jobs| > 0 {
      DecodeEncode(jobs[1..], horizon, policy[1..]);
      var digit := policy[0].mode * horizon + policy[0].start;
      DivisionParts(digit, PolicyCount(jobs[1..], horizon), Encode(jobs[1..], horizon, policy[1..]));
      DivisionParts(policy[0].mode, horizon, policy[0].start);
      assert policy == [policy[0]] + policy[1..];
    }
  }

  lemma EncodeDecode(jobs: seq<Job>, horizon: int, rank: int)
    requires DomainParameters(jobs, horizon) && 0 <= rank < PolicyCount(jobs, horizon)
    ensures Encode(jobs, horizon, Decode(jobs, horizon, rank)) == rank
    decreases |jobs|
  {
    if |jobs| > 0 {
      var tailCount := PolicyCount(jobs[1..], horizon);
      EncodeDecode(jobs[1..], horizon, rank % tailCount);
      var digit := rank / tailCount;
      assert digit == (digit / horizon) * horizon + digit % horizon;
      assert rank == digit * tailCount + rank % tailCount;
    }
  }

  // Makespan first; declared execution cost second; mixed-radix policy rank last.
  predicate Preferred(a: Objective, ai: int, b: Objective, bi: int) {
    a.makespan < b.makespan ||
    (a.makespan == b.makespan && (a.cost < b.cost || (a.cost == b.cost && ai <= bi)))
  }

  lemma Total(a: Objective, ai: int, b: Objective, bi: int)
    ensures Preferred(a, ai, b, bi) || Preferred(b, bi, a, ai)
  {}

  lemma Transitive(a: Objective, ai: int, b: Objective, bi: int, c: Objective, ci: int)
    requires Preferred(a, ai, b, bi) && Preferred(b, bi, c, ci)
    ensures Preferred(a, ai, c, ci)
  {}

  lemma Antisymmetric(a: Objective, ai: int, b: Objective, bi: int)
    requires Preferred(a, ai, b, bi) && Preferred(b, bi, a, ai)
    ensures a == b && ai == bi
  {}

  ghost predicate GlobalOptimum(environment: Environment, policy: seq<Placement>)
    requires Valid(environment)
  {
    Feasible(environment, policy) && InDomain(environment.jobs, environment.horizon, policy) &&
    (forall other: seq<Placement> | Feasible(environment, other) ::
      InDomain(environment.jobs, environment.horizon, other) &&
      Preferred(Evaluate(environment, policy), Encode(environment.jobs, environment.horizon, policy),
        Evaluate(environment, other), Encode(environment.jobs, environment.horizon, other)))
  }

  lemma UniqueOptimum(environment: Environment, a: seq<Placement>, b: seq<Placement>)
    requires Valid(environment) && GlobalOptimum(environment, a) && GlobalOptimum(environment, b)
    ensures a == b
  {
    Antisymmetric(Evaluate(environment, a), Encode(environment.jobs, environment.horizon, a),
      Evaluate(environment, b), Encode(environment.jobs, environment.horizon, b));
    DecodeEncode(environment.jobs, environment.horizon, a);
    DecodeEncode(environment.jobs, environment.horizon, b);
  }

  // The enumeration space is constructed from the environment, never a caller's list of scores.
  // Insufficient budget exits before enumeration and never returns a partial policy.
  method Optimize(environment: Environment, budget: int) returns (result: Result)
    ensures result.Invalid? <==> (!Valid(environment) || !(1 <= budget <= MaxSearchBudget))
    ensures result.Exhausted? ==> (Valid(environment) && 1 <= budget <= MaxSearchBudget &&
      result.required == PolicyCount(environment.jobs, environment.horizon) && result.required > budget)
    ensures (Valid(environment) && 1 <= budget <= MaxSearchBudget &&
      PolicyCount(environment.jobs, environment.horizon) > budget) ==> result.Exhausted?
    ensures (result.Infeasible? || result.Optimal?) ==> (Valid(environment) &&
      result.examined == PolicyCount(environment.jobs, environment.horizon) && result.examined <= budget)
    ensures result.Infeasible? ==> (forall policy: seq<Placement> :: !Feasible(environment, policy))
    ensures (Valid(environment) && 1 <= budget <= MaxSearchBudget &&
      PolicyCount(environment.jobs, environment.horizon) <= budget) ==>
        (result.Infeasible? <==> (forall policy: seq<Placement> :: !Feasible(environment, policy)))
    ensures result.Optimal? ==> (GlobalOptimum(environment, result.policy) &&
      result.objective == Evaluate(environment, result.policy) &&
      result.rank == Encode(environment.jobs, environment.horizon, result.policy))
  {
    if !Valid(environment) || !(1 <= budget <= MaxSearchBudget) {
      result := Invalid;
      return;
    }
    var jobs, horizon := environment.jobs, environment.horizon;
    var count := PolicyCount(jobs, horizon);
    if count > budget {
      result := Exhausted(count);
      return;
    }
    var winner := -1;
    var rank := 0;
    while rank < count
      invariant 0 <= rank <= count
      invariant -1 <= winner < rank
      invariant winner == -1 ==>
        (forall k | 0 <= k < rank :: !Feasible(environment, Decode(jobs, horizon, k)))
      invariant winner >= 0 ==> Feasible(environment, Decode(jobs, horizon, winner))
      invariant winner >= 0 ==>
        (forall k | 0 <= k < rank && Feasible(environment, Decode(jobs, horizon, k)) ::
          Preferred(Evaluate(environment, Decode(jobs, horizon, winner)), winner,
            Evaluate(environment, Decode(jobs, horizon, k)), k))
    {
      var policy := Decode(jobs, horizon, rank);
      if Feasible(environment, policy) {
        if winner == -1 {
          winner := rank;
        } else if Preferred(Evaluate(environment, policy), rank,
          Evaluate(environment, Decode(jobs, horizon, winner)), winner) {
          forall k | 0 <= k < rank && Feasible(environment, Decode(jobs, horizon, k))
            ensures Preferred(Evaluate(environment, policy), rank,
              Evaluate(environment, Decode(jobs, horizon, k)), k)
          {
            Transitive(Evaluate(environment, policy), rank,
              Evaluate(environment, Decode(jobs, horizon, winner)), winner,
              Evaluate(environment, Decode(jobs, horizon, k)), k);
          }
          winner := rank;
        } else {
          Total(Evaluate(environment, policy), rank,
            Evaluate(environment, Decode(jobs, horizon, winner)), winner);
        }
      }
      rank := rank + 1;
    }
    if winner == -1 {
      forall policy: seq<Placement>
        ensures !Feasible(environment, policy)
      {
        if Feasible(environment, policy) {
          FeasibleInDomain(environment, policy);
          DecodeEncode(jobs, horizon, policy);
          assert !Feasible(environment, Decode(jobs, horizon, Encode(jobs, horizon, policy)));
        }
      }
      result := Infeasible(count);
    } else {
      var policy := Decode(jobs, horizon, winner);
      FeasibleInDomain(environment, policy);
      EncodeDecode(jobs, horizon, winner);
      forall other: seq<Placement> | Feasible(environment, other)
        ensures InDomain(jobs, horizon, other) &&
          Preferred(Evaluate(environment, policy), Encode(jobs, horizon, policy),
            Evaluate(environment, other), Encode(jobs, horizon, other))
      {
        FeasibleInDomain(environment, other);
        DecodeEncode(jobs, horizon, other);
        assert Preferred(Evaluate(environment, policy), winner,
          Evaluate(environment, Decode(jobs, horizon, Encode(jobs, horizon, other))),
          Encode(jobs, horizon, other));
      }
      result := Optimal(count, winner, policy, Evaluate(environment, policy));
    }
  }
}
