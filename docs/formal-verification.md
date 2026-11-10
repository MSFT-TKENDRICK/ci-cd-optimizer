# Formal verification: guarantees and limits

The production experiment selector and lint severity resolver execute code generated from mechanically verified
Dafny models. Cache-key certificates execute a verified classifier and transformation. These are **model-specific
guarantees**, not proofs that arbitrary pipelines run faster or that every detector and suggested fix is correct.

The [complete rule assurance catalogue](../formal/rule-assurance.json) lists every built-in detector,
recommendation, autofix and shared engine contract separately. Currently no built-in detector or performance
recommendation is universally proved. The optional cache certificate does not silently elevate the
`caching/cache-key` heuristic into a proof about Actions. `rules --format json`, `lint --explain <rule>`, and the
[rule reference](rules.md) expose this distinction. Missing or metadata-stale built-ins fail CI; local plugins are
explicitly outside the built-in inventory.

## What is actually proved and executed

| Model | Machine-checked contract | Production call path |
|---|---|---|
| [`Selection.dfy`](../formal/Selection.dfy) | Exact bounded objective; eligibility equivalence; valid judges cannot alter eligibility/deterministic score; a total, transitive preference; eligible finite maximum; no-winner iff no eligible candidate; unfinished-candidate detection; reducer promotion/readiness/empty-universe contracts | `experiments/score.ts → formal/selection.ts → Selection.Evaluate`; `experiments/decide.ts → formal/selection.ts → Selection.Reduce` |
| [`Policy.dfy`](../formal/Policy.dfy) | The executable fold equals the independent recursive last-present-assignment specification; an empty/all-absent sequence resolves to `off` | `lint/config.ts → formal/policy.ts → Policy.Resolve` |
| [`CacheKey.dfy`](../formal/CacheKey.dfy) | Normalization preserves rendering; separated templates permit component recovery; coverage/determination imply exact equality partition; missing/extra components have concrete counterexamples; pruning undeclared components coarsens the partition, preserves declared coverage and yields a determined template | `formal cache-key` / `formal check → formal/cache-key.ts → CacheKey.Classify`, `Recommend`, `Base`, `Vary`, `Render` |

The lemmas quantify over their model inputs. They are not predicates that assume the conclusion, and the selector
does not merely check a caller's `qualifies` or `optimal` flag. Its loop invariants relate the running winner to
**every eligible candidate in the processed prefix**, then to the entire finite universe. The production reducer
uses the returned action/index; it does not run a separate handwritten `best()` implementation.

Severity resolution supplies assignments in the existing order: matching preset defaults, then the ruleset
override, then the explicit rule override. The proof covers the last-present fold, **not** YAML parsing, choosing
which presets match, option merging, suppressions, capabilities, detector completeness, or autofix semantics.

## Finite objective and reducer

Let `S = 10000`, integer metric deltas `dᵢ ∈ [-S,S]`, nonnegative integer weights `wᵢ` with positive sum,
minimum `m ∈ [0,S]`, judge `j ∈ [0,S]` or absent, and judge influence `q ∈ [0,5000]`. Arithmetic in the model
and generated integer kernel is unbounded, not binary64 weighted addition.

```text
Round(n, d) = floor((2*n + d) / (2*d)), d > 0     # nearest; ties toward +infinity
deterministic = Round(Σ(wᵢ*dᵢ), Σwᵢ)
rank = deterministic                           # judge absent
rank = Round((S-q)*deterministic + q*(2*j-S), S) # judge present
```

Both scores remain in `[-S,S]`. An eligible candidate has valid inputs, arm **and control** checks passed,
no arm/control evaluation error, no reported protected-path change, every selected metric measured, no scored
regression beyond its limit, and `deterministic >= m`. An error field, even an empty message, fails the gate.
Zero-weight selected metrics are still subject to readiness and regression gates.

The universe is **exactly the manifest's unique ASCII-named arms**, not the measurement file's array or all
possible policies. Missing arms remain pending; duplicate names/measurement records fail; unlisted measurements
cannot win. The adapter sorts unique names by ASCII, then the kernel maximizes:

1. rank;
2. deterministic score;
3. lowest sorted index (ascending ASCII arm name).

The reducer:

- skips a nonrunning experiment;
- promotes this maximum only if no nonfailed candidate is unfinished, **or** the experiment expired;
- expires without a winner after expiry;
- rejects a finished universe without an eligible candidate;
- otherwise waits.

An empty running model universe rejects, or expires if expired. Valid experiment manifests normally require at
least one arm. At expiry a promoted maximum excludes unfinished candidates. Their unknown results, unproposed
alternatives and any global policy search are **not** covered. A low-scoring, failed or pending candidate cannot
be made eligible by any valid judge value. An out-of-range/NaN/infinite judge is invalid, not silently clamped.

### Trusted empirical preprocessing and numeric boundaries

The following steps are tested TypeScript, **not formal theorems about timing or statistics**:

- Select configured metrics, compute direction-aware relative deltas, and clamp to ±1. With control magnitude
  below `1e-9`, the delta is zero for no change and otherwise the sign of the improvement.
- For CI, take medians after at least `minSamples` samples per side. Choose a Mann-Whitney tail **after observing
  direction**, and zero the delta unless the unrounded p-value is below the configured threshold. Displayed
  p-values are rounded. This is an unadjusted repeated-comparison heuristic: it does not guarantee independent
  samples, equivalent work, causality, noise removal or a calibrated family-wise false-positive rate.
- Quantize the resulting JavaScript number's decimal representation to `S` ticks, nearest/ties toward +infinity.
  Quantize the minimum upward and regression limits downward. Judge and influence use nearest ticks.
  Regression gates apply to these **scored**, filtered deltas, not raw timing differences.
- Use exact decimal metric weights with at most six fractional places, each in `[0,1000000]`, scaled by
  `1000000` to integers. Intermediates can exceed JavaScript safe-integer bounds inside BigNumber; boundary
  integers themselves must be safe.
- Check corpus fractions in `[0,1]`, durations/CI samples in `[0,10¹²]`, finite values, and actual boolean check
  results. Limit each CI series to 10000 observations, selected metrics to 128 and candidates to 64.
  `minSamples` is an integer 2–10000; `maxArms`/`maxConcurrent` are integers 1–64; `maxAgeDays` is 1–3650.
  P-value thresholds are strictly between 0 and 1; minima/regression limits are fractions in `[0,1]`.

The formal guarantee starts at the integer candidate vector after this preprocessing. It does not validate
benchmark labels, changed-path observations, workflow sampling, the clock, or measurement authenticity.
**Arm code can fabricate observations or skip work.** Source binding does not fix that. Retain human review
and independent workload/evidence checks; do not interpret a proved ranking as a proved performance improvement.

## Primary-key partition model

The model renders literal strings and these component values:

| Component | Abstract domain |
|---|---|
| `runner.os` | `Linux`, `Windows`, `macOS` |
| `hashFiles('literal', ...)` | empty string **or** 64 lowercase hex characters |
| `github.sha` | exactly 40 lowercase hex characters |
| `github.run_id`, `github.run_number`, `github.run_attempt` | nonempty decimal strings |
| `github.ref`, `github.event_name` | arbitrary Unicode scalar strings, including empty |

Different `hashFiles` identities are their ordered literal argument lists, not actual filesystem reads.
Dafny strings contain Unicode **scalars**, not UTF-16 code units; the bridge preserves astral characters and
rejects lone surrogates. No collision resistance or independence of real GitHub context values is inferred.

`D` is a declared set of **component-value dependencies**. For a supported covered/determined template `K`,
the theorem is:

```text
for every pair of well-formed abstract runs a,b:
  Render(K,a) = Render(K,b)  iff  every component value in D agrees between a,b
```

This says nothing about whether `D` is the actual dependency set of a build. A constant key with empty `D` can
satisfy the theorem while being a terrible or unsafe cache policy for a particular workload.

The separated-template restriction is substantive. SHA has fixed width; `hashFiles` does **not**, because its
value can be empty. Middle variable-width components require a delimiter outside their value alphabet.
Arbitrary `ref`/`event_name` strings cannot be delimited safely by an arbitrary string; placing them last is
supported. Ambiguous templates fail closed instead of being assigned a positive certificate.

The generated normalizer merges literals/removes empty literals without changing rendering. The transformer
removes dynamic components outside `D` and normalizes again. It proves equality-partition coarsening, not a
speedup; it cannot invent a missing dependency. Original and recommended components are reclassified, and each
uncovered/undetermined witness is rendered and its equalities recomputed. The suggested Actions text is also
reparsed: if joining literals creates a new expression, `recommendation.key` is null and `supported` is false.
The component-model properties can still hold when no representable suggested key is emitted.

### Extraction boundary and exclusions

The trusted extractor accepts literal `jobs.<id>.steps[index]` mappings using `actions/cache`, `/restore` or
`/save` with a literal reference and scalar YAML key. It records both the decoded string and the **exact UTF-8
scalar bytes and offsets** in the whole source blob. YAML aliases, merge keys, duplicate/case-colliding inputs,
parse warnings, unsupported key expressions, and the presence of `restore-keys` or `enableCrossOsArchive`
(including empty/false and case variants) are rejected.

Only the expressions in the table are supported; `hashFiles` accepts 1–32 single-quoted literal patterns
(doubled quote escaping), each at most 1024 UTF-16 code units. A template is bounded at 8192 UTF-16 code units
and 128 components; at most 128 declared dependencies are accepted. These are checker resource bounds,
**not** assertions about Actions' key-length limits or which resolved keys Actions accepts.

The extractor is tested, not proved equivalent to GitHub's YAML/expression evaluator. Nothing here models
cache scope/version, prefix lookup (including primary-key prefix behavior), restore ordering, cross-OS archives,
save races, eviction, hits, runtime dependencies, consumer code, or elapsed time. The recommendation is not
automatically applied as a workflow patch. An empty model key, for example, must not be mistaken for an approved
Actions input.

## Creating and checking certificates

Use the built CLI (`npm run build`, then `node dist/bin.js`) or `npm run cli --` from a source checkout.
Certificates need no network or SMT solver at runtime; they execute the statically included verified kernel.
Git must be installed for source-bound creation/checking.

### Cache key

Commit the workflow first. Obtain a full commit object id with `git rev-parse HEAD`; mutable refs such as `HEAD`
are intentionally not accepted by `--commit`. For step zero in job `build`:

```sh
npm run cli -- formal cache-key --source <repository> --commit <full-commit-id> \
  --path .github/workflows/ci.yml --job build --step 0 \
  --dependencies dependencies.json --output cache-certificate.json
npm run cli -- formal check cache-certificate.json --source <repository>
```

`dependencies.json` is a JSON array, for example
`["runner.os","hashFiles('package-lock.json')"]`. Paths passed to `--path` are repository-relative Git paths.
Omitting `--dependencies` is permitted but explicitly recorded as
`inferred-excluding-run-contexts`: take the key's dynamic components except SHA/run counters.
That policy is **not workload dependency discovery**. Review/change `D` before interpreting a recommendation.

### Finite decision

Record the exact scoring configuration, manifest and **raw** measurements in the same commit, in an appropriate
repository without secrets. Collection time, check results, changes, errors, corpus/CI metrics and optional judge
judgments remain untrusted input. Do not supply precomputed `qualifies` or `optimal` claims; the strict decoder
rejects unknown fields.

```sh
npm run cli -- formal decision --source <repository> --commit <full-commit-id> \
  --manifest experiments/example/experiment.yml --config .github/hill-climb.yml \
  --measurements evidence/measurements.json --at 2026-11-05T00:00:00.000Z \
  --output decision-certificate.json
npm run cli -- formal check decision-certificate.json --source <repository>
```

The recorded time is explicit, canonical UTC with milliseconds. The checker recomputes production `decide`,
the private integer candidates, objective thresholds, outcomes, full manifest universe, ignored measurements,
unfinished candidates, exclusions and action. This checks a calculation over those bytes; it neither applies a
decision nor authorizes a merge. Existing publication ownership/head/manifest checks remain separate.

### Outcomes and canonical data

| Exit | Result | Meaning |
|---|---|---|
| `0` | `source-bound-valid` | Full recomputation agrees, and every recorded `commit:path` blob matches the explicitly selected local repository |
| `3` | `model-valid` | Full recomputation agrees, but no repository was supplied to `formal check`; commit/path assertions are **not established** |
| `1` | invalid | Tampering, incompatible proof build, unsupported input/model, invalid numeric data, missing source or stale binding |
| `2` | usage | Missing/unknown CLI options, malformed commit selector or decision time |

Help also exits zero. **A valid certificate need not say the original key is correct or an arm qualifies.**
It can validly report counterexamples, missing dependencies, rejection or waiting. Exit zero validates the
certificate/binding, not a cache fix or performance claim.

The certificate JSON profile rejects duplicate decoded keys, invalid/nonfinite/unsafe numeric values, negative
zero, lone surrogates, sparse/decorated/accessor arrays, accessors and nonplain objects. Keys are sorted using
JavaScript UTF-16 ordering; it is a documented restricted profile, not a claim of RFC 8785 compatibility.
Certificate numeric fields are safe integers. Fractional observations remain inside the committed source-content
string and undergo a separate strict finite, decimal-round-trippable JSON decoder. Input certificates are bounded
at 8 MB/64 levels; individual source blobs at 2 MB. Unsupported/lossy input is rejected rather than repaired.

The digest is SHA-256 over `"cicd-optimizer/cert-v1\0"` plus canonical unsigned JSON. **It is not a signature.**
Rehashing an invented result does not help: the checker reconstructs assumptions, metadata, extraction,
witnesses, candidates and results, then compares the entire canonical certificate. The schema and model/runtime/
source/dependency build hashes come from the installed checker, never from attacker-selected executable code.

Source binding uses full commit ids and raw Git blobs, disables replacement refs, recomputes blob object ids,
and compares exact UTF-8 bytes. It does not read working-tree files or textconv filters. Dirty working files do
not invalidate a certificate for an older committed blob; falsely assigning old bytes to a newer commit/path
does. Trust the selected Git repository/object database and Git executable; no repository identity, author,
signature, execution, or observational truth is attested.

## Verification and regeneration

From a repository checkout with Node 22 and its locked dependencies:

```sh
npm ci
npm run formal:setup
npm run formal:verify
npm run assurance:check
npm run formal:check
npx vitest run test/formal test/experiments/formal-integration.test.ts
```

[`toolchain.json`](../formal/toolchain.json) pins official **Dafny 4.11.0 / Z3 4.12.1** archives by SHA-256.
Setup downloads to `.proof-tools` and validates the archive before extraction. Every verify/generate/check also
hashes the complete installed distribution: sort each relative path, then hash
`path + NUL + SHA256(fileBytes) + LF` records. The aggregate pin covers all 290 distribution files, not just a
version string or solver executable. Unexpected files, modifications, missing tools and unsupported hosts fail.
Hosts supported by these pins are x64 Linux, x64 Windows and Windows ARM64 using x64 emulation.

The scripts explicitly select Z3 4.12.1 (not the other solver bundled by Dafny), verify included files, use manual
lemma induction, enforce deterministic translation and reject unverified assumptions/axioms/externs.
`formal:check` invokes verified JavaScript translation, then compares the generated runtime and build stamp byte
for byte; it does not skip SMT verification. `formal:verify` runs the standalone verifier. The checked-in runtime
is used by applications without installing Dafny.

After editing a rule's metadata, review the claim and run:

```sh
npm run assurance:generate
npm run docs:rules
npm run formal:generate
npm run formal:check
```

After changing any production TypeScript, dependency manifest/lock, model or proof-generator source, regenerate
the proof build stamp too. It records normalized model sources, raw translator output, adapted runtime, complete
non-kernel/non-manifest production TypeScript, generator sources, toolchain pins and package manifest/lock.
Recording a source hash **does not claim that all hashed source is proved**.

The only generated-code adaptations are the static ESM BigNumber import, erased module type annotations and
exports. BigNumber 9.3.1 is an actual production dependency used by this runtime. Generated files alone may use
`@ts-nocheck`; adapters and checkers are ordinary strict TypeScript.

The `formal` CI job always verifies/regenerates and checks the all-rule catalogue. Runtime tests include an
independent BigInt objective oracle, exhaustive short candidate/policy sequences, production selection,
Unicode/empty-hash/cache separation, canonicalization, tampering, stale/forged sources and exit semantics.
The build job also executes certificates through the **real Action bundle** and rejects tampering. These tests
exercise the trusted boundary; they are not substituted for the Dafny proofs.

When CI reports a stale Action bundle, retrieve its `action-bundle-<sha>` artifact and commit `dist-action/index.js`
from that artifact; do not mistake a passing source proof for a current shipped bundle.

### Trusted computing base

The proof relies on Dafny/Boogie/Z3 soundness, the pinned translator/runtime, BigNumber/JavaScript execution,
and correct use of their primitive domains. The surrounding TypeScript, YAML/JSON/Git extraction, statistics,
configuration/manifest validation and adapters are **tested trusted code**, not mechanically verified translations
of GitHub Actions or consumer workloads. A corrupted checker or modified runtime is outside the certificate
threat model. CI source/runtime/dependency stamps support reproducibility; they are not a code-signing scheme.

The exact finite and string-partition guarantees remain useful within this boundary. They must not be
restated as “all improvements proved,” “authenticated observations,” or “globally optimal pipeline policy.”
