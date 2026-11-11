# Hill-climbing experiments

CI/CD Optimizer evaluates proposed changes to itself and the pipelines it lints through finite candidate experiments.
Three [GitHub Agentic Workflows](https://github.github.com/gh-aw/) (gh-aw) run the loop on a schedule. Deterministic
grading uses supplied observations and an explicit scoring policy. **Those observations do not attest equivalent work:
CI promotion metadata is rechecked against GitHub, but arm code can fabricate corpus results, skip work, or exploit
an incomplete benchmark.** The mechanically verified selector
proves its finite ranking and hard-gate contract, not the truth of inputs, causal speedups, or a global policy optimum.
See [formal verification](formal-verification.md) for executable proofs and source-bound certificates.

For a complete scheduling optimum rather than observed-arm ranking, use
[`experiments plan --model`](ci-policy-planning.md). It exactly optimizes every feasible job/mode/start policy
in a declared bounded CI environment with dependencies, resource capacity and a cost limit. That theorem is
conditional on the supplied model; no workflow correspondence or duration profile is verified. An optimal
plan is experimental input, never measured evidence or permission to promote.

```text
main
└── experiments/<name>/trunk          control: main + manifest + any new benchmark cases (draft PR → main)
    ├── experiments/<name>/<arm-a>    one candidate implementation (PR → trunk)
    ├── experiments/<name>/<arm-b>
    └── experiments/<name>/<arm-c>
```

The winning arm is squash-merged into the trunk. The trunk pull request then becomes ready for a human to review and
merge into `main`. Losing arms are closed, and their pull requests and grading comments remain as the record of what
was tried.

## Experiment kinds

| Kind | Changes | Measured by |
|---|---|---|
| `rules` | The linter: new rules, fewer false positives, better fixes. | The benchmark [corpus](../corpus/README.md): precision, recall, fix rate, lint duration. Each arm is built in its own worktree. |
| `pipeline` | CI/CD itself, such as caching, sparse checkout, job graph, or container layers. | Successful first-attempt `workflow_dispatch` runs reporting each recorded head/branch: run timestamp span or a named job's duration. See the workload caveats below. |

The app CI smoke starts its disposable PostgreSQL container through
`test/service/container-postgres.mjs` while preparing the production image. The whole startup runs in a bounded
worker: `docker run --detach` alone still waits for an image pull. Smoke execution waits for the original database
health policy, and the always-run cleanup joins startup before removing the container and its anonymous volumes.
Startup, readiness and cleanup failures fail CI. Overlapping work is not itself proof of a speedup: compare complete
run latency and runner work across fixed-head samples, not only the removed service-initialization step.

## The loop

### 1. Generator: weekly ([experiment-generator.md](../.github/workflows/experiment-generator.md))

1. `experiments capacity` counts open `experiments/*/trunk` pull requests, exhausting pagination rather than sampling recent PRs, and reads
   `selection.maxConcurrent` from the configuration. When the budget is spent, a separate activation step is skipped:
   this is a successful no-work run, not a workflow failure. API and configuration errors still fail.
2. Before the agent starts, `experiments context` builds a briefing from the default branch:
   - the lint findings
   - the latest CI telemetry (critical path, slow jobs)
   - the rubric and metrics
   - the history of running, promoted, rejected, and expired experiments, so ideas aren't retried blindly
   - when explicitly supplied with `--model`, a recomputed bounded CI policy plan and its assumptions; without
     a model, the briefing explicitly warns against claiming scheduling optimality from scores or telemetry

   The briefing is fixed before that agent invocation. This does not authenticate historical measurements or benchmark labels.
3. The Copilot agent proposes **one** experiment: a manifest with a hypothesis, 1–4 arms with distinct approaches, and
   self-scored rubric criteria. For `rules` experiments, it can also add new benchmark cases.
4. The `create-experiment` safe-output job re-validates the proposal with `experiments create`. It checks the schema,
   the rubric bar, name uniqueness, the concurrency budget, and case limits (10 cases, 50 files each, 200 KB).
   Existing corpus cases are immutable. The job then:
   - creates the trunk branch with the manifest and new cases
   - opens a draft pull request to `main`
   - dispatches one arm run per arm

### 2. Arms: on dispatch ([experiment-arm.md](../.github/workflows/experiment-arm.md))

Each arm runs in parallel:

1. Checks out the trunk and validates the inputs against the manifest.
2. Creates `experiments/<name>/<arm>`.
3. Implements only that arm's approach.
4. Runs the tests and benchmarks before and after the change.
5. Opens a non-draft pull request into the trunk.

Changes to protected files require review.

### 3. Grader: daily ([experiment-grader.md](../.github/workflows/experiment-grader.md))

The same capacity check skips inference successfully when no experiment is open.

1. `experiments collect` gathers CI results for each arm and the trunk.
2. `experiments evaluate` builds every `rules` arm and the control in separate worktrees and scores them on the
   corpus. This step has **no token**. Arm code is untrusted.
3. The measurements are uploaded as an artifact **before** the agent starts.
4. The agent reviews each arm's diff against the rubric and records a judgment from 0 to 1 with a rationale.
5. The `grade-experiments` safe-output job downloads the original measurements, combines them with the judgments, and
   applies `experiments decide --apply`:

| Decision | When | Effect |
|---|---|---|
| `wait` | An arm is still collecting evidence: it isn't built yet, its checks are running, it has fewer than `minSamples` supported CI observations, or a metric is unmeasured. Legacy/unsupported timing arrays do not count. | Dispatches the configured CI workflow on the arms and trunk that need more runs. Pushes and pull requests made with `GITHUB_TOKEN` don't trigger CI, so the grader dispatches it explicitly. |
| `promote` | The top-ranked qualifying arm exists, and either no arm is still pending or the experiment expired. | Squash-merges the winner into the trunk and closes the other arms. Records `status: promoted`, the winner, and the measured evidence in the manifest. Marks the trunk PR ready for review, requests `promotion.reviewers`, and adds labels. |
| `reject` | No arm is still pending and none qualifies. | Closes the arms and labels the trunk `experiment:rejected`. |
| `expire` | `maxAgeDays` (or the manifest's `expiresAt`) passed with no qualifying arm. | Closes the arms and labels the trunk `experiment:expired`. |

Merging a promoted trunk into `main` publishes a [recipe](recipes.md) so the winning change can be applied to other
repositories.

Applied promotion, rejection and expiry require collected commit SHAs and PR numbers for the control and every
currently open arm. The CLI reads the manifest at the observed trunk commit and rejects missing or stale evidence
before applying these decisions.
Older measurement files without the control PR number must be recollected (and corpus experiments re-evaluated).
Dry-run grading remains available without applying these writes.

Before a merge, the executor rereads the trunk and arms to verify repository ownership, branch/base, PR identity,
state and head. A merge must explicitly return `merged: true` and its commit SHA, and the squash commit's sole parent
must be the measured control commit. The promoted manifest is committed on that exact merge commit, and an
expected-head `updateRefs` write refuses a changed trunk. Ref writes also require current repository metadata and
refuse the observed default branch, including when the experiment trunk has been selected as the default.
Arm cleanup is deferred
until the manifest write and the promotion PR's marker/readiness are confirmed. Missing ready-for-review
acknowledgements fail the operation; an unavailable optional auto-merge request is reported in the grading notes.

Rejection and expiry verify every open target before starting the outcome batch. Each closure (including a
promotion's losing arms) rereads PR identity before the outcome comment and again immediately before closing.
After the close request, the executor must observe the same unmerged PR, head, base and repository in the closed
state before cleanup or reporting that PR as closed. Failed or unpersisted closures, retargeting, changed heads and
reopening stop that operation. Unknown or fork ownership is refused before posting outcome comments, not merely
used to retain the branch afterward.

This is not a transaction across GitHub operations. PR-state/base checks cannot lock out retargeting or other
metadata changes after preflight; require protected default branches and coordinate all writers. A merge or manifest
write can succeed before a later step fails. Such partial promotions require operator reconciliation, not a blind
retry or an assumption that the merge was rolled back. Cleanup retains a branch observed in use by another open PR.
Closures are also non-transactional: earlier verified targets may already be closed and cleaned when a later target
fails. A lost close response may leave a closed PR with its branch retained; no durable experiment cleanup intent is
recorded, so reconcile such retained branches manually rather than replaying cleanup from old closed-PR history.

## Controlled CI observations and migration

`experiments collect` keeps the numeric `ci[metricId]` arrays for existing displays and adds
`ciEvidence[metricId]` with schema `cicd-optimizer/ci-evidence-v1`. **Keep both fields when moving or augmenting
measurements.** Bare duration arrays from older collectors are unmeasured for eligibility; recollect them rather
than inventing provenance. Normal `evaluate` and `decide` commands use the same duplicate-aware strict measurement
decoder as formal certificates.

The collector and scorer enforce this deliberately narrow observation contract:

- The run is completed/successful, has `event: workflow_dispatch` and `run_attempt: 1`, reports the exact full
  recorded SHA and expected experiment branch, and was created at or after the experiment's creation timestamp.
  PR-event runs, push/schedule events, retries, old heads, unknown heads and foreign repository contexts do not count.
  A PR run's reported `head_sha` is **not** evidence that its checkout used that commit: default PR checkout can use a
  synthetic merge, and a draft control can skip work that a non-draft arm performs.
- Each observation records run ID, attempt, workflow ID/path, event, status/conclusion, head/branch and timestamps.
  The series records repository and configured workflow. Duration is recomputed from timestamps and must equal the
  numeric projection. IDs are deduplicated during collection; duplicates in serialized evidence invalidate that series.
  Control and arm must use the same repository/workflow identity and cannot reuse each other's runs.
- Runs are paginated until `max(30, minSamples)` supported observations have been found per metric/branch or the API
  inventory is exhausted. This is a bounded sample, not all historical runs. For job metrics, the collector exhausts
  the **attempt-1** job inventory and requires exactly one job with the configured name, a successful completed status,
  the same run/attempt/head, and timestamps within the run. Ambiguous matrix names and incomplete job inventories
  are not usable observations.
- Both the control's and arm's reported check inventories are paginated. A passing gate requires all returned checks
  completed/nonfailing and at least one success; all-skipped or absent checks remain pending. This does not discover
  required tests or prove that successful jobs did meaningful work. Missing comparison files or the API's 300-file
  comparison ceiling fail closed rather than presenting potentially truncated protected-path evidence as complete.

Before `experiments decide --apply` publishes a performance promotion, it re-reads every consumed run's metadata
and any selected attempt-specific job from GitHub. Forged timestamps, changed attempts, and context mismatches abort
before publication. This is a point-in-time API comparison, not a transaction locking executions against subsequent
changes. The App needs only **Actions: read** for these checks; dispatch retains its separate job-local credential.

These safeguards remove the PR-merge/draft/retry mixing problem, **not all experimental confounders**.
`workflow_dispatch` and the API's head metadata do not prove a custom checkout's ref, identical inputs, equivalent
work, required-test coverage, runner equality, honest corpus reports, or statistical independence. A workflow can
skip work and still succeed. Review workflow changes and verify workload equivalence independently before accepting
a performance recommendation. Offline source-bound certificates verify the recorded calculation without contacting
GitHub; they do not authenticate the recorded API responses.

## Scoring

For each configured metric, a relative delta over the control is computed, clamped to ±100%, and quantized to
10,000 integer ticks per unit:

- **Corpus metrics** compare results on the same labeled corpus. Counts depend on engine behavior and labels;
  duration is a noisy timing measurement, not a deterministic correctness fact.
- **CI metrics** compare medians of at least `minSamples` supported, provenance-backed dispatch observations per branch. A Mann-Whitney tail chosen
  after observing the direction must have an unrounded p-value below `pValue`; otherwise the delta scores zero.
  This is an unadjusted repeated-comparison heuristic, not a test that can guarantee removal of noise, statistical
  independence, equivalent work, or causality. Displayed p-values are rounded.

The generated Dafny kernel computes the **deterministic score** as an exact integer-weighted mean rounded to a tick
(ties toward positive infinity). Weights have at most six decimal places and positive total. An arm **qualifies**
only when the generated kernel establishes all of these conditions on its supplied inputs:

- its score meets `minImprovement`, with that threshold rounded **up** to a tick;
- both its checks and the control's checks are reported passed;
- every selected metric is measured and no **scored** delta breaches its regression limit, rounded **down** to a tick;
- no reported changed path matches `protectedPaths`;
- neither evaluation reports an error, and numeric inputs/configuration are valid.

The judge only reorders eligible arms: the kernel rounds
`rank = (1 − w) · deterministic + w · (2 · judge − 1)` to a tick, with valid `w <= 0.5`.
Missing judgments leave rank equal to the deterministic score. Invalid/NaN/infinite judgments fail closed, rather
than being silently clamped. A valid judge value cannot bypass any eligibility gate—this is a proved runtime
contract, not just an intention. It does **not** prevent an arm from supplying fabricated measurements that satisfy
those gates.

The candidate universe is exactly the manifest's unique ASCII-named arms. Ties use descending rank, descending
deterministic score, then ascending ASCII name (not host locale). Missing arms remain pending; measurements for
unlisted arms are excluded. Before expiry the reducer waits for every nonfailed candidate to finish. At expiry it
may promote the maximum among currently eligible measured candidates despite unfinished arms; no claim is made
about their unknown outcomes or unproposed alternatives. The production `decide` path calls this generated reducer.

The [complete rule assurance catalogue](../formal/rule-assurance.json) separately records every built-in detector
and recommendation as heuristic/conditional. Verified selection does not turn a selected rule improvement into a
proof of detector correctness or of a real bottleneck reduction.

## Configuration: `.github/hill-climb.yml`

```yaml
rubric:
  minScore: 3.5             # weighted 1-5 score a proposal must reach
  criteria:
    - { id: impact, weight: 0.3, description: Expected reduction in build, test, or release time. }
    - { id: evidence, weight: 0.2, description: Grounded in telemetry, findings, or authoritative docs. }
    - { id: safety, weight: 0.2, description: Preserves security, hermeticity, and required checks. }
    - { id: generality, weight: 0.15, description: Likely to transfer to other repositories. }
    - { id: measurability, weight: 0.15, description: Measurable with the configured metrics. }

metrics:
  - { id: precision, source: corpus, direction: maximize, weight: 0.35, maxRegression: 0.02 }
  - { id: recall, source: corpus, direction: maximize, weight: 0.35, maxRegression: 0.05 }
  - { id: fixRate, source: corpus, direction: maximize, weight: 0.15 }
  - { id: durationMs, source: corpus, direction: minimize, weight: 0.15, maxRegression: 0.5 }
  - { id: ciWallClock, source: ci, workflow: ci.yml, direction: minimize, weight: 0.6, maxRegression: 0.1 }
  - { id: ciTestJob, source: ci, workflow: ci.yml, job: test, direction: minimize, weight: 0.4, maxRegression: 0.15 }

selection:
  judgeWeight: 0.2
  minSamples: 5
  pValue: 0.05
  minImprovement: 0.02
  maxAgeDays: 14
  maxConcurrent: 3
  maxArms: 4

protectedPaths: [.github/hill-climb.yml, experiments/*/experiment.yml, corpus/**]

promotion:
  autoMerge: false          # true enables auto-merge on the trunk PR once required reviews pass
  reviewers: [my-org/platform]
  labels: [hill-climb]

evaluation:
  corpus: corpus
  engine: dist/lint/api.js  # module each arm builds; must export the engine contract version
  install: npm ci --ignore-scripts --no-audit --no-fund
  build: npm run build
  test: npm test
  timingRuns: 3
```

Experiments use every metric whose `source` matches their kind, unless the manifest lists `metrics`. To change the
rubric, metrics, or protected paths, edit this file on `main`. Reported changes to protected configuration paths
disqualify an arm; this gate is not a sandbox against malicious evaluation code.

## Manifest: `experiments/<name>/experiment.yml`

```yaml
name: npm-cache-restore-keys          # 2-48 lowercase letters, digits, dashes
title: Restore partial npm caches on lockfile changes
hypothesis: >-
  Agent pull requests change package-lock.json often. Restoring the nearest npm cache instead of starting cold
  should cut the install step by at least 30%.
kind: pipeline                        # rules | pipeline
metrics: [ciWallClock, ciTestJob]     # optional subset
rubric:
  scores: { impact: 4, evidence: 4, safety: 5, generality: 4, measurability: 4 }
  rationale: Install is 38% of the critical path in the last 20 CI runs.
arms:
  - name: restore-keys
    title: actions/cache with restore-keys
    approach: Replace setup-node's cache with actions/cache keyed on the lockfile hash plus an OS-only restore key.
  - name: offline-mirror
    title: npm ci --prefer-offline
    approach: Keep setup-node's cache and add --prefer-offline so npm reuses cached tarballs without revalidating them.
applicability:                        # seeds the portable recipe
  files: [".github/workflows/*.yml"]
  description: Node repositories whose pull requests frequently change the lockfile.
source:
  findings: [caching/setup-cache]
createdAt: "2026-11-02T06:00:00Z"
expiresAt: "2026-11-16T06:00:00Z"
status: running                       # running | promoted | rejected | expired
```

## Running it by hand

```sh
node dist-action/index.js experiments capacity                          # running / limit / available
node dist-action/index.js experiments context -o context.md               # the generator's briefing
node dist-action/index.js experiments create --manifest experiment.yml --dry-run
node dist-action/index.js experiments collect --output-dir measurements   # needs GITHUB_TOKEN
node dist-action/index.js experiments evaluate --measurements measurements
node dist-action/index.js experiments decide --measurements measurements  # preview; add --apply to act
node dist-action/index.js experiments evaluate --engine dist/lint/api.js --corpus corpus   # score the current build
```

### Recover interrupted publication

Creating the trunk, opening its PR, labeling it, and dispatching arms are separate GitHub operations. If PR publication
fails, the CLI reports the retained branch and full commit SHA. It never deletes that branch or retries a failed draft
request as a ready-for-review PR.

Fix the credential problem, inspect the retained commit and any existing PR, then preview recovery:

```sh
node dist-action/index.js experiments resume --repo OWNER/REPO \
  --experiment EXPERIMENT_NAME --expected-head FULL_INSPECTED_COMMIT_SHA --dry-run
```

Repeat without `--dry-run` to publish or repair the matching PR. Add `--base BRANCH` only when the original promotion
target was not the repository's current default branch. Recovery reads the manifest at the supplied immutable SHA,
requires a running, unexpired experiment that still passes the proposal rubric, checks available capacity for a new PR,
and verifies the resulting draft PR, label, and branch head before reporting success. Changed heads, foreign/retargeted
or already-ready PRs, ambiguous history, and closed or completed experiments are refused. Existing matching PRs are reused, including when a
previous creation response was lost. GitHub operations are not atomic; if a later check fails, inspect the retained PR
instead of assuming earlier writes were rolled back.

Outcome labels (`experiment:promote`, `experiment:rejected`, `experiment:expired`) also prevent publication recovery,
even when a failed finalization left the PR open with a running manifest. Reconcile that interrupted outcome instead;
`resume` does not erase it or restart the experiment. Outcome labels are checked again before confirming publication.

Recovery **does not dispatch arms** or reset the experiment's age. Inspect arm PRs and workflow runs first; dispatch only
missing arms, one at a time, against the trusted default branch:

```sh
gh workflow run experiment-arm.lock.yml --repo OWNER/REPO --ref TRUSTED_DEFAULT_BRANCH \
  -f experiment=EXPERIMENT_NAME -f arm=MISSING_ARM_NAME
```

## Tokens

The workflows automatically use the configured App (`CICD_OPTIMIZER_APP_ID` and
`CICD_OPTIMIZER_APP_PRIVATE_KEY`) for branch and PR publication. Short-lived tokens are scoped to this repository and
minted only in the isolated publishing jobs, never in the agent or evaluator. Legacy numeric App IDs work with the
token action's `client-id` input. Pipeline changes additionally require the App's **Workflows: write** permission.

The App keeps **Actions: read**. `create` arm dispatches and `decide --apply` measurement dispatches use the publishing
job's built-in token through `CICD_OPTIMIZER_DISPATCH_TOKEN`; those jobs grant **Actions: write**. This variable is
job-local, not an additional stored secret. For a local CLI invocation, either set it to a separate Actions-write
credential or give the primary CLI token Actions-write access.

Without App configuration, publication falls back to `CICD_OPTIMIZER_TOKEN` (a repository-scoped App token or
fine-grained PAT), then `GITHUB_TOKEN`. The fallback publisher needs **Contents**, **Issues**, and **Pull requests: write**,
plus **Workflows: write** for pipeline edits. `GITHUB_TOKEN` cannot edit workflow files and cannot create PRs unless
the repository permits it; its PRs do not trigger CI automatically. Prefer the App rather than loosening repository
settings. Workflow dispatch still works with the separate built-in Actions token.

The agent jobs use `copilot-requests: write` for inference when the account supports it; see
[setup](setup.md#4-optional-tokens-owner) for the personal-account alternative. They never receive publication tokens.

### Regenerating workflows

The checked-in locks use **gh-aw v1.0.1**. Install that version (`gh extension install github/gh-aw --pin v1.0.1` for a new
installation), confirm `gh aw --version`, then run:

```sh
gh aw compile experiment-generator experiment-arm experiment-grader --no-check-update --approve
```

Review and commit the `.md` sources and generated `.lock.yml` files together. Do not edit the locks manually or compile
them with an older global extension; compiler versions differ in their protected-file and App-token schemas.

## Threat model

| Risk | Mitigation |
|---|---|
| An arm games its own score, for example by editing the corpus, the metrics, or the manifest. | Reported changes to `protectedPaths` disqualify the arm. New corpus cases land on the trunk before arms branch. The gate does not stop runtime tampering, fabricated observations, or exploitation of incomplete labels. |
| Untrusted arm code runs during evaluation. | It runs only in the grader's `evaluate` step, which has no token in a read-only job. The numbers are uploaded as an artifact before the agent runs and are re-read by the grading job. |
| A prompt-injected agent pushes a persuasive but harmful change. | Agents never hold write tokens. gh-aw safe outputs validate and apply their requests, and gh-aw threat detection scans their output. Judgments only reorder arms that already qualify on measurements. |
| A winning arm merges without oversight. | Winners merge only into the experiment trunk. `main` changes only when a human approves the trunk pull request, unless `promotion.autoMerge` is enabled. |
| An arm forges its measurements or does less work. | Corpus-report forgery and workload changes are **not prevented**. CI promotion rechecks recorded dispatch metadata/timing against GitHub, so an edited duration alone is insufficient, but a workflow can skip work and genuinely finish faster. Grading is not execution or workload attestation. Human review of the trunk pull request is the trust boundary: confirm the winning diff still does the same work. Do not enable `promotion.autoMerge` when arms may come from untrusted proposers. |
| A formal certificate is mistaken for execution attestation or universal optimality. | The checker recomputes from recorded `commit:path` blobs and a pinned generated kernel. This binds the calculation to bytes, not to an honest execution. The arm selector covers declared eligible candidates; the scheduling optimizer covers every feasible policy in its explicit bounded environment, assuming the declared workload/timing correspondence; cache-key proofs cover declared dependency values. Budget exhaustion is not an optimum or infeasibility proof. |
| Workflow changes are used for privilege escalation. | Keep the repository's default `GITHUB_TOKEN` permissions read-only, require review for `.github/workflows/**` via CODEOWNERS, and scope `CICD_OPTIMIZER_TOKEN` to this repository. |
| Runaway cost. | Pre-activation checks skip inference when there's nothing to do. `maxConcurrent`, `maxArms`, `maxAgeDays`, and per-job timeouts bound the work. |
