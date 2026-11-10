// Primary-key string equality only, relative to declared component values.
// Not Actions cache lookup, hash collision resistance, dependency discovery, or performance.
module CacheKey {
  datatype CtxVar = Sha | RunId | RunNumber | RunAttempt | Ref | EventName
  datatype Comp = Lit(s: string) | RunnerOs | HashFiles(id: nat) | Ctx(c: CtxVar)
  datatype Dep = DOs | DFiles(id: nat) | DCtx(c: CtxVar)
  datatype Run = Run(os: string, files: map<nat, string>, ctx: map<CtxVar, string>)
  datatype Cls = Letters | Hex | Digits | Any

  function Val(c: Comp, r: Run): string {
    match c
    case Lit(s) => s
    case RunnerOs => r.os
    case HashFiles(id) => if id in r.files then r.files[id] else ""
    case Ctx(v) => if v in r.ctx then r.ctx[v] else ""
  }

  function Render(t: seq<Comp>, r: Run): string {
    if |t| == 0 then "" else Val(t[0], r) + Render(t[1..], r)
  }

  function ClassOf(c: Comp): Cls {
    match c
    case Lit(_) => Any
    case RunnerOs => Letters
    case HashFiles(_) => Hex
    case Ctx(v) => if v == Sha then Hex else if v == RunId || v == RunNumber || v == RunAttempt then Digits else Any
  }

  function FixedLen(c: Comp): nat { if c == Ctx(Sha) then 40 else 0 }

  predicate InClass(k: Cls, ch: char) {
    match k
    case Letters => ('a' <= ch <= 'z') || ('A' <= ch <= 'Z')
    case Hex => ('0' <= ch <= '9') || ('a' <= ch <= 'f')
    case Digits => '0' <= ch <= '9'
    case Any => true
  }

  predicate AllIn(k: Cls, s: string) { forall i | 0 <= i < |s| :: InClass(k, s[i]) }

  // Domain of a component's rendered value in a well-formed run.
  predicate InDomain(c: Comp, v: string) {
    match c
    case Lit(s) => v == s
    case RunnerOs => v == "Linux" || v == "Windows" || v == "macOS"
    case HashFiles(_) => (|v| == 0 || |v| == 64) && AllIn(Hex, v)
    case Ctx(x) =>
      if x == Sha then |v| == 40 && AllIn(Hex, v)
      else if x == RunId || x == RunNumber || x == RunAttempt then |v| > 0 && AllIn(Digits, v)
      else true
  }

  predicate WF(t: seq<Comp>, r: Run) { forall i | 0 <= i < |t| :: InDomain(t[i], Val(t[i], r)) }

  // Head component can be split off the rendered string unambiguously.
  predicate SepHead(t: seq<Comp>) requires |t| > 0 {
    t[0].Lit? || FixedLen(t[0]) > 0 || |t| == 1 ||
    (t[1].Lit? && |t[1].s| > 0 && ClassOf(t[0]) != Any && !InClass(ClassOf(t[0]), t[1].s[0]))
  }

  predicate Separated(t: seq<Comp>) decreases |t| {
    |t| == 0 || (SepHead(t) && Separated(t[1..]))
  }

  lemma PrefixCancel(a: string, b: string, c: string)
    requires a + b == a + c ensures b == c
  {
    assert b == (a + b)[|a|..];
    assert c == (a + c)[|a|..];
  }

  lemma SameLenSplit(a: string, b: string, c: string, d: string)
    requires a + b == c + d && |a| == |c| ensures a == c && b == d
  {
    assert a == (a + b)[..|a|];
    assert c == (c + d)[..|c|];
    assert b == (a + b)[|a|..];
    assert d == (c + d)[|c|..];
  }

  lemma WFTail(t: seq<Comp>, r: Run) requires |t| > 0 && WF(t, r) ensures WF(t[1..], r)
  {
    forall i | 0 <= i < |t[1..]| ensures InDomain(t[1..][i], Val(t[1..][i], r)) { assert t[1..][i] == t[i + 1]; }
  }

  lemma RenderLitHead(t: seq<Comp>, r: Run)
    requires |t| > 0 && t[0].Lit? && |t[0].s| > 0
    ensures |Render(t, r)| > 0 && Render(t, r)[0] == t[0].s[0]
  {}

  lemma DelimitedLen(k: Cls, v1: string, r1: string, v2: string, r2: string, d: char)
    requires v1 + r1 == v2 + r2 && AllIn(k, v1) && AllIn(k, v2)
    requires |r1| > 0 && r1[0] == d && |r2| > 0 && r2[0] == d && !InClass(k, d)
    ensures |v1| == |v2|
  {
    var s := v1 + r1;
    if |v1| < |v2| { assert s[|v1|] == d; assert s[|v1|] == v2[|v1|]; assert false; }
    if |v2| < |v1| { assert s[|v2|] == d; assert s[|v2|] == v1[|v2|]; assert false; }
  }

  // Theorem 1: a separated template's rendering determines every component value.
  lemma RenderInjective(t: seq<Comp>, r1: Run, r2: Run)
    requires Separated(t) && WF(t, r1) && WF(t, r2) && Render(t, r1) == Render(t, r2)
    ensures forall i | 0 <= i < |t| :: Val(t[i], r1) == Val(t[i], r2)
    decreases |t|
  {
    if |t| == 0 { return; }
    var v1, v2 := Val(t[0], r1), Val(t[0], r2);
    var rest1, rest2 := Render(t[1..], r1), Render(t[1..], r2);
    assert v1 + rest1 == v2 + rest2;
    if t[0].Lit? {
      PrefixCancel(v1, rest1, rest2);
    } else if FixedLen(t[0]) > 0 {
      assert InDomain(t[0], v1) && InDomain(t[0], v2);
      SameLenSplit(v1, rest1, v2, rest2);
    } else if |t| == 1 {
      assert rest1 == "" && rest2 == "";
      assert v1 + rest1 == v1 && v2 + rest2 == v2;
    } else {
      assert InDomain(t[0], v1) && InDomain(t[0], v2);
      assert t[1..][0] == t[1];
      RenderLitHead(t[1..], r1);
      RenderLitHead(t[1..], r2);
      DelimitedLen(ClassOf(t[0]), v1, rest1, v2, rest2, t[1].s[0]);
      SameLenSplit(v1, rest1, v2, rest2);
    }
    WFTail(t, r1);
    WFTail(t, r2);
    RenderInjective(t[1..], r1, r2);
    assert v1 == v2;
    forall i | 0 <= i < |t| ensures Val(t[i], r1) == Val(t[i], r2) { if i > 0 { assert t[1..][i - 1] == t[i]; } }
  }

  function CompOf(d: Dep): Comp {
    match d
    case DOs => RunnerOs
    case DFiles(id) => HashFiles(id)
    case DCtx(c) => Ctx(c)
  }

  predicate DepsEq(deps: set<Dep>, r1: Run, r2: Run) { forall d | d in deps :: Val(CompOf(d), r1) == Val(CompOf(d), r2) }
  predicate KeyEq(t: seq<Comp>, r1: Run, r2: Run) { Render(t, r1) == Render(t, r2) }

  predicate Covers(t: seq<Comp>, deps: set<Dep>) { forall d | d in deps :: CompOf(d) in t }
  predicate Determined(t: seq<Comp>, deps: set<Dep>) {
    forall i | 0 <= i < |t| :: t[i].Lit? || exists d | d in deps :: CompOf(d) == t[i]
  }

  // Theorem 2 (soundness): equal keys imply equal declared dependencies.
  lemma Soundness(t: seq<Comp>, deps: set<Dep>, r1: Run, r2: Run)
    requires Separated(t) && Covers(t, deps) && WF(t, r1) && WF(t, r2) && KeyEq(t, r1, r2)
    ensures DepsEq(deps, r1, r2)
  {
    RenderInjective(t, r1, r2);
    forall d | d in deps ensures Val(CompOf(d), r1) == Val(CompOf(d), r2) {
      var i :| 0 <= i < |t| && t[i] == CompOf(d);
    }
  }

  lemma RenderCongruent(t: seq<Comp>, r1: Run, r2: Run)
    requires forall i | 0 <= i < |t| :: Val(t[i], r1) == Val(t[i], r2)
    ensures Render(t, r1) == Render(t, r2)
    decreases |t|
  {
    if |t| > 0 {
      forall i | 0 <= i < |t[1..]| ensures Val(t[1..][i], r1) == Val(t[1..][i], r2) { assert t[1..][i] == t[i + 1]; }
      RenderCongruent(t[1..], r1, r2);
    }
  }

  // Theorem 3 (completeness): equal declared dependencies imply equal keys.
  lemma Completeness(t: seq<Comp>, deps: set<Dep>, r1: Run, r2: Run)
    requires Determined(t, deps) && DepsEq(deps, r1, r2)
    ensures KeyEq(t, r1, r2)
  {
    forall i | 0 <= i < |t| ensures Val(t[i], r1) == Val(t[i], r2) {
      if !t[i].Lit? { var d :| d in deps && CompOf(d) == t[i]; }
    }
    RenderCongruent(t, r1, r2);
  }

  // Theorem 4 (coarsening): dropping components never splits a partition class.
  lemma Coarsening(t: seq<Comp>, t2: seq<Comp>, r1: Run, r2: Run)
    requires Separated(t) && WF(t, r1) && WF(t, r2) && KeyEq(t, r1, r2)
    requires forall c | c in t2 :: c.Lit? || c in t
    ensures KeyEq(t2, r1, r2)
  {
    RenderInjective(t, r1, r2);
    forall i | 0 <= i < |t2| ensures Val(t2[i], r1) == Val(t2[i], r2) {
      if !t2[i].Lit? { var j :| 0 <= j < |t| && t[j] == t2[i]; }
    }
    RenderCongruent(t2, r1, r2);
  }

  // Theorem 5 (exact partition): a checked template partitions runs exactly by the declared dependencies.
  lemma ExactPartition(t: seq<Comp>, deps: set<Dep>, r1: Run, r2: Run)
    requires Separated(t) && Covers(t, deps) && Determined(t, deps) && WF(t, r1) && WF(t, r2)
    ensures KeyEq(t, r1, r2) <==> DepsEq(deps, r1, r2)
  {
    if KeyEq(t, r1, r2) { Soundness(t, deps, r1, r2); }
    if DepsEq(deps, r1, r2) { Completeness(t, deps, r1, r2); }
  }

  // ---- Normalization: merge adjacent literals, drop empty literals ----
  function Norm(t: seq<Comp>): seq<Comp> decreases |t| {
    if |t| == 0 then []
    else
      var rest := Norm(t[1..]);
      if t[0].Lit? then
        if |t[0].s| == 0 then rest
        else if |rest| > 0 && rest[0].Lit? then [Lit(t[0].s + rest[0].s)] + rest[1..]
        else [t[0]] + rest
      else [t[0]] + rest
  }

  lemma NormRender(t: seq<Comp>, r: Run) ensures Render(Norm(t), r) == Render(t, r) decreases |t|
  {
    if |t| > 0 {
      NormRender(t[1..], r);
      var rest := Norm(t[1..]);
      if t[0].Lit? && |t[0].s| > 0 && |rest| > 0 && rest[0].Lit? {
        var n := [Lit(t[0].s + rest[0].s)] + rest[1..];
        assert n[1..] == rest[1..];
        assert Render(rest, r) == rest[0].s + Render(rest[1..], r);
        assert Render(n, r) == (t[0].s + rest[0].s) + Render(rest[1..], r);
      } else if !(t[0].Lit? && |t[0].s| == 0) {
        assert ([t[0]] + rest)[1..] == rest;
      }
    }
  }

  lemma NormComps(t: seq<Comp>) ensures forall c: Comp | !c.Lit? :: (c in Norm(t) <==> c in t) decreases |t|
  {
    if |t| > 0 {
      NormComps(t[1..]);
      var rest := Norm(t[1..]);
      if t[0].Lit? && |t[0].s| > 0 && |rest| > 0 && rest[0].Lit? {
        var n := [Lit(t[0].s + rest[0].s)] + rest[1..];
        forall c: Comp | !c.Lit? ensures c in n <==> c in rest {
          if c in rest { var k :| 0 <= k < |rest| && rest[k] == c; assert k > 0; assert n[k] == c; }
          if c in n { var k :| 0 <= k < |n| && n[k] == c; assert k > 0; assert rest[k] == c; }
        }
      }
      forall c: Comp | !c.Lit? ensures c in t <==> (c == t[0] || c in t[1..]) {
        if c in t { var k :| 0 <= k < |t| && t[k] == c; if k > 0 { assert t[1..][k - 1] == c; } }
      }
    }
  }

  function DSet(deps: seq<Dep>): set<Dep> { set e | e in deps }

  // ---- Verified classifier ----
  datatype Verdict = Unsupported(at: nat) | Checked(uncovered: seq<Dep>, undetermined: seq<Comp>)

  function DepOf(c: Comp): Dep requires !c.Lit? {
    match c
    case RunnerOs => DOs
    case HashFiles(id) => DFiles(id)
    case Ctx(x) => DCtx(x)
  }

  function FirstUnsep(t: seq<Comp>): nat
    ensures FirstUnsep(t) <= |t|
    ensures FirstUnsep(t) == |t| <==> Separated(t)
    ensures FirstUnsep(t) < |t| ==> !SepHead(t[FirstUnsep(t)..])
    decreases |t|
  {
    if |t| == 0 then 0 else if !SepHead(t) then 0 else
      var k := FirstUnsep(t[1..]);
      assert k < |t[1..]| ==> t[1..][k..] == t[k + 1..];
      k + 1
  }

  function Uncovered(t: seq<Comp>, deps: seq<Dep>): seq<Dep>
    ensures forall d :: d in Uncovered(t, deps) <==> (d in deps && CompOf(d) !in t)
  {
    if |deps| == 0 then [] else
      var rest := Uncovered(t, deps[1..]);
      assert forall d :: d in deps <==> (d == deps[0] || d in deps[1..]);
      if CompOf(deps[0]) in t then rest else [deps[0]] + rest
  }

  function Undetermined(t: seq<Comp>, deps: seq<Dep>): seq<Comp>
    ensures forall c :: c in Undetermined(t, deps) <==> (c in t && !c.Lit? && DepOf(c) !in deps)
  {
    if |t| == 0 then [] else
      var rest := Undetermined(t[1..], deps);
      assert forall c :: c in t <==> (c == t[0] || c in t[1..]);
      if t[0].Lit? || DepOf(t[0]) in deps then rest else [t[0]] + rest
  }

  function Classify(t: seq<Comp>, deps: seq<Dep>): Verdict {
    var n := Norm(t);
    var k := FirstUnsep(n);
    if k < |n| then Unsupported(k) else Checked(Uncovered(n, deps), Undetermined(n, deps))
  }

  function Prune(t: seq<Comp>, deps: seq<Dep>): seq<Comp>
    ensures forall c | c in Prune(t, deps) :: c in t && (c.Lit? || DepOf(c) in deps)
    ensures forall d | d in deps :: (CompOf(d) in Prune(t, deps) <==> CompOf(d) in t)
  {
    if |t| == 0 then [] else
      var rest := Prune(t[1..], deps);
      if t[0].Lit? || DepOf(t[0]) in deps then [t[0]] + rest else rest
  }

  function Recommend(t: seq<Comp>, deps: seq<Dep>): seq<Comp> { Norm(Prune(t, deps)) }

  lemma RecommendationCorrect(t: seq<Comp>, deps: seq<Dep>, r1: Run, r2: Run)
    requires Separated(Norm(t)) && WF(t, r1) && WF(t, r2)
    ensures KeyEq(t, r1, r2) ==> KeyEq(Recommend(t, deps), r1, r2)
    ensures Determined(Recommend(t, deps), DSet(deps))
    ensures Covers(t, DSet(deps)) ==> Covers(Recommend(t, deps), DSet(deps))
  {
    var p := Prune(t, deps);
    var n := Norm(t);
    NormComps(p); NormComps(t);
    NormRender(t, r1); NormRender(t, r2);
    NormRender(p, r1); NormRender(p, r2);
    assert WF(n, r1) && WF(n, r2) by {
      forall i | 0 <= i < |n| ensures InDomain(n[i], Val(n[i], r1)) && InDomain(n[i], Val(n[i], r2)) {
        if !n[i].Lit? { var j :| 0 <= j < |t| && t[j] == n[i]; }
      }
    }
    forall c | c in p ensures c.Lit? || c in n {
      if !c.Lit? { assert c in t; }
    }
    if KeyEq(t, r1, r2) { Coarsening(n, p, r1, r2); }
    forall i | 0 <= i < |Recommend(t, deps)|
      ensures Recommend(t, deps)[i].Lit? || exists d | d in DSet(deps) :: CompOf(d) == Recommend(t, deps)[i]
    {
      var c := Recommend(t, deps)[i];
      if !c.Lit? { assert c in p; assert DepOf(c) in deps; assert CompOf(DepOf(c)) == c; }
    }
    if Covers(t, DSet(deps)) {
      forall d | d in DSet(deps) ensures CompOf(d) in Recommend(t, deps) {
        assert CompOf(d) in p;
      }
    }
  }

  // ---- Witness runs ----
  function Rep(ch: char, n: nat): string ensures |Rep(ch, n)| == n ensures forall i | 0 <= i < n :: Rep(ch, n)[i] == ch {
    seq(n, _ => ch)
  }
  function BaseCtx(): map<CtxVar, string> {
    map[Sha := Rep('0', 40), RunId := "1", RunNumber := "1", RunAttempt := "1"]
  }
  function Base(): Run { Run("Linux", map[], BaseCtx()) }
  function AltCtx(x: CtxVar): string {
    if x == Sha then Rep('1', 40) else if x == RunId || x == RunNumber || x == RunAttempt then "2" else "x"
  }
  function Vary(d: Dep): Run {
    match d
    case DOs => Base().(os := "Windows")
    case DFiles(id) => Base().(files := map[id := Rep('a', 64)])
    case DCtx(x) => Base().(ctx := BaseCtx()[x := AltCtx(x)])
  }

  lemma VaryVal(c: Comp, d: Dep)
    ensures Val(c, Vary(d)) == Val(c, Base()) <==> c != CompOf(d)
    ensures InDomain(c, Val(c, Base())) && InDomain(c, Val(c, Vary(d)))
  {
    assert Rep('0', 40)[0] != Rep('1', 40)[0];
    assert Rep('a', 64) != "";
  }

  lemma WFWitness(t: seq<Comp>, d: Dep) ensures WF(t, Base()) && WF(t, Vary(d))
  {
    forall i | 0 <= i < |t| ensures InDomain(t[i], Val(t[i], Base())) && InDomain(t[i], Val(t[i], Vary(d))) { VaryVal(t[i], d); }
  }

  ghost predicate ExactOn(t: seq<Comp>, deps: set<Dep>) {
    forall r1: Run, r2: Run | WF(t, r1) && WF(t, r2) :: KeyEq(t, r1, r2) <==> DepsEq(deps, r1, r2)
  }

  // Main theorem: the classifier's verdict is semantically correct.
  lemma ClassifyCorrect(t: seq<Comp>, deps: seq<Dep>)
    ensures Classify(t, deps).Checked? ==> Separated(Norm(t))
    ensures Classify(t, deps).Checked? && |Classify(t, deps).uncovered| == 0 && |Classify(t, deps).undetermined| == 0
      ==> ExactOn(t, DSet(deps))
    ensures Classify(t, deps).Checked? ==> forall d | d in Classify(t, deps).uncovered ::
      WF(t, Base()) && WF(t, Vary(d)) && KeyEq(t, Base(), Vary(d)) && !DepsEq(DSet(deps), Base(), Vary(d))
    ensures Classify(t, deps).Checked? ==> forall c | c in Classify(t, deps).undetermined ::
      WF(t, Base()) && WF(t, Vary(DepOf(c))) && !KeyEq(t, Base(), Vary(DepOf(c))) && DepsEq(DSet(deps), Base(), Vary(DepOf(c)))
  {
    var n := Norm(t);
    var D := DSet(deps);
    NormComps(t);
    if Classify(t, deps).Checked? {
      var v := Classify(t, deps);
      forall r1: Run, r2: Run | WF(t, r1) && WF(t, r2) && |v.uncovered| == 0 && |v.undetermined| == 0
        ensures KeyEq(t, r1, r2) <==> DepsEq(D, r1, r2)
      {
        NormRender(t, r1); NormRender(t, r2);
        assert WF(n, r1) && WF(n, r2) by {
          forall i | 0 <= i < |n| ensures InDomain(n[i], Val(n[i], r1)) && InDomain(n[i], Val(n[i], r2)) {
            if !n[i].Lit? { assert n[i] in t; var j :| 0 <= j < |t| && t[j] == n[i]; }
          }
        }
        forall d | d in D ensures CompOf(d) in n { assert CompOf(d) !in n ==> d in v.uncovered; }
        forall i | 0 <= i < |n| ensures n[i].Lit? || exists d | d in D :: CompOf(d) == n[i] {
          if !n[i].Lit? { assert n[i] !in v.undetermined; assert DepOf(n[i]) in deps; assert CompOf(DepOf(n[i])) == n[i]; }
        }
        ExactPartition(n, D, r1, r2);
      }
      forall d | d in v.uncovered
        ensures WF(t, Base()) && WF(t, Vary(d)) && KeyEq(t, Base(), Vary(d)) && !DepsEq(D, Base(), Vary(d))
      {
        WFWitness(t, d);
        forall i | 0 <= i < |t| ensures Val(t[i], Base()) == Val(t[i], Vary(d)) {
          VaryVal(t[i], d);
          if t[i] == CompOf(d) { assert CompOf(d) in t; assert CompOf(d) in n; }
        }
        RenderCongruent(t, Base(), Vary(d));
        VaryVal(CompOf(d), d);
      }
      forall c | c in v.undetermined
        ensures WF(t, Base()) && WF(t, Vary(DepOf(c))) && !KeyEq(t, Base(), Vary(DepOf(c))) && DepsEq(D, Base(), Vary(DepOf(c)))
      {
        var e := DepOf(c);
        assert CompOf(e) == c;
        WFWitness(t, e); WFWitness(n, e);
        forall d | d in D ensures Val(CompOf(d), Base()) == Val(CompOf(d), Vary(e)) {
          VaryVal(CompOf(d), e);
          if CompOf(d) == c { assert d == e; }
        }
        if KeyEq(t, Base(), Vary(e)) {
          NormRender(t, Base()); NormRender(t, Vary(e));
          RenderInjective(n, Base(), Vary(e));
          var j :| 0 <= j < |n| && n[j] == c;
          VaryVal(c, e);
          assert false;
        }
      }
    }
  }
}


