# Hill-climbing experiments

CI/CD Optimizer improves itself, and the pipelines it lints, through controlled experiments that agents propose and
implement and that statistics decide. Three [GitHub Agentic Workflows](https://github.github.com/gh-aw/) (gh-aw) run the
loop on a schedule. Every decision is made by deterministic code from measurements the agents can't alter.

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
| `pipeline` | CI/CD itself, such as caching, sparse checkout, job graph, or container layers. | Successful CI runs on each arm's head commit vs the trunk: wall clock and test job duration. |

## The loop

### 1. Generator: weekly ([experiment-generator.md](../.github/workflows/experiment-generator.md))

1. A pre-activation step counts open `experiments/*/trunk` pull requests. When the concurrency budget is spent, it exits
   before any inference.
2. Before the agent starts, `experiments context` builds a briefing from the default branch:
   - the lint findings
   - the latest CI telemetry (critical path, slow jobs)
   - the rubric and metrics
   - the history of running, promoted, rejected, and expired experiments, so ideas aren't retried blindly

   The briefing is built before the agent runs, so the agent can't shape its own evidence.
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

1. `experiments collect` gathers CI results for each arm and the trunk.
2. `experiments evaluate` builds every `rules` arm and the control in separate worktrees and scores them on the
   corpus. This step has **no token**. Arm code is untrusted.
3. The measurements are uploaded as an artifact **before** the agent starts.
4. The agent reviews each arm's diff against the rubric and records a judgment from 0 to 1 with a rationale.
5. The `grade-experiments` safe-output job downloads the original measurements, combines them with the judgments, and
   applies `experiments decide --apply`:

| Decision | When | Effect |
|---|---|---|
| `wait` | An arm is still collecting evidence: it isn't built yet, its checks are running, it has fewer than `minSamples` CI runs, or a metric is unmeasured. | Dispatches the configured CI workflow on the arms and trunk that need more runs. Pushes and pull requests made with `GITHUB_TOKEN` don't trigger CI, so the grader dispatches it explicitly. |
| `promote` | The top-ranked qualifying arm exists, and either no arm is still pending or the experiment expired. | Squash-merges the winner into the trunk and closes the other arms. Records `status: promoted`, the winner, and the measured evidence in the manifest. Marks the trunk PR ready for review, requests `promotion.reviewers`, and adds labels. |
| `reject` | No arm is still pending and none qualifies. | Closes the arms and labels the trunk `experiment:rejected`. |
| `expire` | `maxAgeDays` (or the manifest's `expiresAt`) passed with no qualifying arm. | Closes the arms and labels the trunk `experiment:expired`. |

Merging a promoted trunk into `main` publishes a [recipe](recipes.md) so the winning change can be applied to other
repositories.

## Scoring

For each metric, an arm's relative improvement over the control is computed and clamped to ±100%:

- **Corpus metrics** are deterministic. The arm and control run on the same corpus in the same job.
- **CI metrics** compare medians of at least `minSamples` successful runs per branch. A one-sided Mann-Whitney U test
  must reject noise at `pValue`. Otherwise the change scores 0.

The **deterministic score** is the weighted mean of those improvements. An arm **qualifies** only when:

- its deterministic score is at least `minImprovement`,
- its checks pass,
- no metric regresses beyond its `maxRegression`,
- it changed no `protectedPaths`, and
- its evaluation didn't fail.

The agent's judgment only reorders qualifying arms: `rank = (1 − w) · deterministic + w · (2 · judge − 1)`, where
`w = judgeWeight` (capped at 0.5). A persuasive but unmeasured change can never be promoted.

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
rubric, metrics, or protected paths, edit this file on `main`. Arms can't change it.

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
node dist-action/index.js experiments context -o context.md               # the generator's briefing
node dist-action/index.js experiments create --manifest experiment.yml --dry-run
node dist-action/index.js experiments collect --output-dir measurements   # needs GITHUB_TOKEN
node dist-action/index.js experiments evaluate --measurements measurements
node dist-action/index.js experiments decide --measurements measurements  # preview; add --apply to act
node dist-action/index.js experiments evaluate --engine dist/lint/api.js --corpus corpus   # score the current build
```

## Tokens

The loop works with `GITHUB_TOKEN` alone for `rules` experiments. `pipeline` experiments change
`.github/workflows/*`, which `GITHUB_TOKEN` can't push or merge. Set `CICD_OPTIMIZER_TOKEN` to one of these:

- a GitHub App installation token with **Contents**, **Pull requests**, **Actions**, and **Workflows** write access
- a fine-grained personal access token with the same permissions

The agent jobs use `copilot-requests: write` for inference, so no personal access token is needed for the agent.

## Threat model

| Risk | Mitigation |
|---|---|
| An arm games its own score, for example by editing the corpus, the metrics, or the manifest. | Changes to `protectedPaths` disqualify the arm. New corpus cases land on the trunk before any arm branches, and existing cases are immutable. |
| Untrusted arm code runs during evaluation. | It runs only in the grader's `evaluate` step, which has no token in a read-only job. The numbers are uploaded as an artifact before the agent runs and are re-read by the grading job. |
| A prompt-injected agent pushes a persuasive but harmful change. | Agents never hold write tokens. gh-aw safe outputs validate and apply their requests, and gh-aw threat detection scans their output. Judgments only reorder arms that already qualify on measurements. |
| A winning arm merges without oversight. | Winners merge only into the experiment trunk. `main` changes only when a human approves the trunk pull request, unless `promotion.autoMerge` is enabled. |
| Workflow changes are used for privilege escalation. | Keep the repository's default `GITHUB_TOKEN` permissions read-only, require review for `.github/workflows/**` via CODEOWNERS, and scope `CICD_OPTIMIZER_TOKEN` to this repository. |
| Runaway cost. | Pre-activation checks skip inference when there's nothing to do. `maxConcurrent`, `maxArms`, `maxAgeDays`, and per-job timeouts bound the work. |
