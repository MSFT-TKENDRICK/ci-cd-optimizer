// Integer objective and finite experiment reducer. Measurement extraction is outside this model.
module Selection {
  const Scale: int := 10000
  datatype Metric = Metric(delta: int, weight: int, measured: bool, regressionLimit: int)
  datatype Candidate = Candidate(metrics: seq<Metric>, tests: int, controlTests: int,
    armError: bool, controlError: bool, protectedPath: bool, invalid: bool, judge: int)
  datatype Score = Score(deterministic: int, rank: int, failed: bool, pending: bool, eligible: bool)
  datatype Action = Skip | Wait | Promote(index: int) | Reject | Expire

  predicate ValidMetric(m: Metric) {
    -Scale <= m.delta <= Scale && 0 <= m.weight && -1 <= m.regressionLimit <= Scale
  }
  function Weight(ms: seq<Metric>): int {
    if |ms| == 0 then 0 else ms[0].weight + Weight(ms[1..])
  }
  function Weighted(ms: seq<Metric>): int {
    if |ms| == 0 then 0 else ms[0].weight * ms[0].delta + Weighted(ms[1..])
  }
  predicate Valid(c: Candidate, minimum: int, influence: int) {
    !c.invalid && 0 <= minimum <= Scale && 0 <= influence <= Scale / 2 &&
    -1 <= c.tests <= 1 && -1 <= c.controlTests <= 1 && -1 <= c.judge <= Scale &&
    |c.metrics| > 0 && (forall m | m in c.metrics :: ValidMetric(m)) && Weight(c.metrics) > 0
  }

  // Nearest integer, with exact halfway values rounded towards positive infinity.
  function Round(numerator: int, denominator: int): int
    requires denominator > 0
  { (2 * numerator + denominator) / (2 * denominator) }

  lemma ProductNonnegative(a: int, b: int)
    requires 0 <= a && 0 <= b
    ensures 0 <= a * b
  {}

  lemma RoundBounds(n: int, d: int, lo: int, hi: int)
    requires d > 0 && lo * d <= n <= hi * d
    ensures lo <= Round(n, d) <= hi
  {
    var q := Round(n, d);
    var rem := (2 * n + d) % (2 * d);
    assert 2 * n + d == q * (2 * d) + rem;
    assert 0 <= rem < 2 * d;
    assert 2 * lo * d <= 2 * n + d;
    assert 2 * n + d < 2 * (hi + 1) * d;
    if q < lo {
      ProductNonnegative(lo - q - 1, 2 * d);
      assert q * (2 * d) + rem < 2 * lo * d;
      assert false;
    }
    if q > hi {
      ProductNonnegative(q - hi - 1, 2 * d);
      assert q * (2 * d) + rem >= 2 * (hi + 1) * d;
      assert false;
    }
  }

  lemma WeightedBounds(ms: seq<Metric>)
    requires forall m | m in ms :: ValidMetric(m)
    ensures Weight(ms) >= 0
    ensures -Scale * Weight(ms) <= Weighted(ms) <= Scale * Weight(ms)
    decreases |ms|
  {
    if |ms| > 0 {
      WeightedBounds(ms[1..]);
      assert ValidMetric(ms[0]);
      ProductNonnegative(ms[0].weight, ms[0].delta + Scale);
      ProductNonnegative(ms[0].weight, Scale - ms[0].delta);
      assert -Scale * ms[0].weight <= ms[0].weight * ms[0].delta <= Scale * ms[0].weight;
    }
  }

  function Mean(ms: seq<Metric>): int
    requires (forall m | m in ms :: ValidMetric(m)) && Weight(ms) > 0
    ensures -Scale <= Mean(ms) <= Scale
  {
    WeightedBounds(ms);
    RoundBounds(Weighted(ms), Weight(ms), -Scale, Scale);
    Round(Weighted(ms), Weight(ms))
  }

  function Rank(score: int, judge: int, influence: int): int
    requires -Scale <= score <= Scale && -1 <= judge <= Scale && 0 <= influence <= Scale / 2
    ensures -Scale <= Rank(score, judge, influence) <= Scale
  {
    if judge == -1 then score else
      var numerator := (Scale - influence) * score + influence * (2 * judge - Scale);
      ProductNonnegative(Scale - influence, score + Scale);
      ProductNonnegative(Scale - influence, Scale - score);
      ProductNonnegative(influence, 2 * judge);
      ProductNonnegative(influence, 2 * Scale - 2 * judge);
      assert -Scale * Scale <= numerator <= Scale * Scale;
      RoundBounds(numerator, Scale, -Scale, Scale);
      Round(numerator, Scale)
  }

  predicate Regression(ms: seq<Metric>) {
    exists m | m in ms :: m.measured && m.regressionLimit >= 0 && m.delta < -m.regressionLimit
  }
  predicate HardFailure(c: Candidate, minimum: int, influence: int) {
    !Valid(c, minimum, influence) || c.tests == 0 || c.controlTests == 0 ||
    c.armError || c.controlError || c.protectedPath || Regression(c.metrics)
  }
  predicate Pending(c: Candidate) {
    c.tests == -1 || c.controlTests == -1 || exists m | m in c.metrics :: !m.measured
  }

  function Evaluate(c: Candidate, minimum: int, influence: int): Score
    ensures -Scale <= Evaluate(c, minimum, influence).deterministic <= Scale
    ensures -Scale <= Evaluate(c, minimum, influence).rank <= Scale
  {
    var valid := Valid(c, minimum, influence);
    var score := if valid then Mean(c.metrics) else 0;
    var rank := if valid then Rank(score, c.judge, influence) else 0;
    var failed := HardFailure(c, minimum, influence);
    var pending := Pending(c);
    Score(score, rank, failed, pending, !failed && !pending && score >= minimum)
  }

  // All hard gates, including readiness, are necessary and sufficient for eligibility at the fixed objective.
  lemma Eligibility(c: Candidate, minimum: int, influence: int)
    ensures Evaluate(c, minimum, influence).eligible <==>
      (Valid(c, minimum, influence) && c.tests == 1 && c.controlTests == 1 &&
       !c.armError && !c.controlError && !c.protectedPath && !Regression(c.metrics) &&
       (forall m | m in c.metrics :: m.measured) && Mean(c.metrics) >= minimum)
  {}

  lemma JudgeCannotBypass(c: Candidate, minimum: int, influence: int, judge: int)
    requires -1 <= c.judge <= Scale && -1 <= judge <= Scale
    ensures Evaluate(c, minimum, influence).eligible ==
      Evaluate(c.(judge := judge), minimum, influence).eligible
    ensures Evaluate(c, minimum, influence).deterministic ==
      Evaluate(c.(judge := judge), minimum, influence).deterministic
  {}

  // The input sequence is ordered by unique ASCII arm names at the checked adapter.
  // Lower index breaks exact score ties. No platform-dependent collation is involved.
  predicate Preferred(a: Score, ai: int, b: Score, bi: int) {
    a.rank > b.rank ||
    (a.rank == b.rank && (a.deterministic > b.deterministic ||
      (a.deterministic == b.deterministic && ai <= bi)))
  }
  lemma Total(a: Score, ai: int, b: Score, bi: int)
    ensures Preferred(a, ai, b, bi) || Preferred(b, bi, a, ai)
  {}
  lemma Transitive(a: Score, ai: int, b: Score, bi: int, c: Score, ci: int)
    requires Preferred(a, ai, b, bi) && Preferred(b, bi, c, ci)
    ensures Preferred(a, ai, c, ci)
  {}

  ghost predicate Maximum(cs: seq<Candidate>, minimum: int, influence: int, winner: int) {
    0 <= winner < |cs| && Evaluate(cs[winner], minimum, influence).eligible &&
    forall j | 0 <= j < |cs| && Evaluate(cs[j], minimum, influence).eligible ::
      Preferred(Evaluate(cs[winner], minimum, influence), winner, Evaluate(cs[j], minimum, influence), j)
  }

  method Select(cs: seq<Candidate>, minimum: int, influence: int) returns (winner: int, unfinished: bool)
    ensures winner == -1 || Maximum(cs, minimum, influence, winner)
    ensures winner == -1 <==> (forall j | 0 <= j < |cs| :: !Evaluate(cs[j], minimum, influence).eligible)
    ensures unfinished <==> (exists j | 0 <= j < |cs| ::
      Evaluate(cs[j], minimum, influence).pending && !Evaluate(cs[j], minimum, influence).failed)
  {
    winner := -1;
    unfinished := false;
    var i := 0;
    while i < |cs|
      invariant 0 <= i <= |cs|
      invariant -1 <= winner < i
      invariant winner == -1 <==> (forall j | 0 <= j < i :: !Evaluate(cs[j], minimum, influence).eligible)
      invariant winner >= 0 ==> Evaluate(cs[winner], minimum, influence).eligible
      invariant winner >= 0 ==> (forall j | 0 <= j < i && Evaluate(cs[j], minimum, influence).eligible ::
        Preferred(Evaluate(cs[winner], minimum, influence), winner, Evaluate(cs[j], minimum, influence), j))
      invariant unfinished <==> (exists j | 0 <= j < i ::
        Evaluate(cs[j], minimum, influence).pending && !Evaluate(cs[j], minimum, influence).failed)
    {
      var next := Evaluate(cs[i], minimum, influence);
      unfinished := unfinished || (next.pending && !next.failed);
      if next.eligible {
        if winner == -1 {
          winner := i;
        } else if Preferred(next, i, Evaluate(cs[winner], minimum, influence), winner) {
          forall j | 0 <= j < i && Evaluate(cs[j], minimum, influence).eligible
            ensures Preferred(next, i, Evaluate(cs[j], minimum, influence), j)
          {
            Transitive(next, i, Evaluate(cs[winner], minimum, influence), winner, Evaluate(cs[j], minimum, influence), j);
          }
          winner := i;
        } else {
          Total(next, i, Evaluate(cs[winner], minimum, influence), winner);
        }
      }
      i := i + 1;
    }
  }

  // This method, not a second handwritten reducer, is called by production decide().
  method Reduce(cs: seq<Candidate>, minimum: int, influence: int, running: bool, expired: bool) returns (action: Action)
    ensures action.Skip? <==> !running
    ensures action.Promote? ==> Maximum(cs, minimum, influence, action.index)
    ensures action.Promote? && !expired ==> !(exists j | 0 <= j < |cs| ::
      Evaluate(cs[j], minimum, influence).pending && !Evaluate(cs[j], minimum, influence).failed)
    ensures running && (forall j | 0 <= j < |cs| :: !Evaluate(cs[j], minimum, influence).eligible) ==> !action.Promote?
    ensures running && |cs| == 0 ==> (if expired then action.Expire? else action.Reject?)
    ensures action.Reject? || action.Expire? ==> (forall j | 0 <= j < |cs| :: !Evaluate(cs[j], minimum, influence).eligible)
  {
    if !running { action := Skip; return; }
    var winner, unfinished := Select(cs, minimum, influence);
    if winner >= 0 && (!unfinished || expired) {
      action := Promote(winner);
    } else if expired {
      action := Expire;
    } else if !unfinished {
      action := Reject;
    } else {
      action := Wait;
    }
  }
}
