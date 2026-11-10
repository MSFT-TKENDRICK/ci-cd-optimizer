module Policy {
  // -1 means no assignment; 0=off, 1=info, 2=warn, 3=error.
  ghost function Last(updates: seq<int>): int {
    if |updates| == 0 then 0
    else if updates[|updates| - 1] != -1 then updates[|updates| - 1]
    else Last(updates[..|updates| - 1])
  }

  method Resolve(updates: seq<int>) returns (severity: int)
    requires forall j | 0 <= j < |updates| :: -1 <= updates[j] <= 3
    ensures severity == Last(updates)
    ensures 0 <= severity <= 3
    ensures (forall j | 0 <= j < |updates| :: updates[j] == -1) ==> severity == 0
    ensures |updates| > 0 && updates[|updates| - 1] != -1 ==> severity == updates[|updates| - 1]
  {
    severity := 0;
    var i := 0;
    while i < |updates|
      invariant 0 <= i <= |updates|
      invariant forall j | 0 <= j < |updates| :: -1 <= updates[j] <= 3
      invariant severity == Last(updates[..i])
      invariant 0 <= severity <= 3
      invariant (forall j | 0 <= j < i :: updates[j] == -1) ==> severity == 0
    {
      assert -1 <= updates[i] <= 3;
      if updates[i] != -1 { severity := updates[i]; }
      assert updates[..i + 1][..i] == updates[..i];
      i := i + 1;
    }
    assert i == |updates|;
    assert updates[..i] == updates;
  }

  lemma ExplicitOverride(prefix: seq<int>, level: int)
    requires 0 <= level <= 3
    ensures Last(prefix + [level]) == level
  {}
}
