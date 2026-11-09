---
description: Proposes one high-quality hill-climbing experiment per week from findings, telemetry, and past results.
on:
  schedule: weekly on monday
  workflow_dispatch:
  permissions:
    contents: read
    pull-requests: read
  steps:
    # Self-throttle before any inference: skip when the concurrent-experiment budget is already spent.
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      with:
        persist-credentials: false
        sparse-checkout: |
          .github
          dist-action
    - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
      with:
        node-version-file: .nvmrc
    - id: count
      env:
        GITHUB_TOKEN: ${{ github.token }}
      run: |
        CAPACITY=$(node dist-action/index.js experiments capacity)
        echo "$CAPACITY"
        jq -er '"running=\(.running)\nlimit=\(.limit)"' <<< "$CAPACITY" >> "$GITHUB_OUTPUT"
    - id: check
      if: fromJSON(steps.count.outputs.running) < fromJSON(steps.count.outputs.limit)
      run: echo "Capacity available for a proposal; the publisher enforces the configured limit."
if: needs.pre_activation.outputs.check_result == 'success'
permissions:
  actions: read
  contents: read
  copilot-requests: write
  issues: read
  pull-requests: read
engine: copilot
runs-on: ubuntu-24.04
timeout-minutes: 20
network:
  allowed: [defaults, github, node]
tools:
  edit:
  bash: ["cat", "ls", "head", "tail", "grep", "wc", "mkdir", "node dist-action/index.js lint:*"]
steps:
  - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
    with:
      node-version-file: .nvmrc
  - name: Restore telemetry snapshots
    uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
    with:
      path: .cicd-telemetry
      key: cicd-telemetry-${{ github.run_id }}
      restore-keys: cicd-telemetry-
  # Built before the agent starts, so the context reflects the default branch and cannot be shaped by the agent.
  - name: Build generator context
    env:
      GH_TOKEN: ${{ github.token }}
      GITHUB_TOKEN: ${{ github.token }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/hill-climb
      TELEMETRY=()
      RUN_ID=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml --branch "$GITHUB_REF_NAME" --status success \
        --limit 1 --json databaseId --jq '.[0].databaseId // empty')
      if [ -n "$RUN_ID" ] && node dist-action/index.js telemetry --run-id "$RUN_ID" --store .cicd-telemetry/runs.jsonl \
        --dry-run --no-alerts -f markdown -o /tmp/gh-aw/hill-climb/telemetry.md; then
        TELEMETRY=(--telemetry /tmp/gh-aw/hill-climb/telemetry.md)
      fi
      node dist-action/index.js experiments context "${TELEMETRY[@]}" -o /tmp/gh-aw/hill-climb/context.md
      wc -c /tmp/gh-aw/hill-climb/context.md
safe-outputs:
  jobs:
    create-experiment:
      description: >-
        Open a new hill-climbing experiment: validates the manifest against the rubric, creates the
        experiments/<name>/trunk branch with the manifest and any new benchmark cases, opens its draft pull request,
        and dispatches one agent per arm.
      runs-on: ubuntu-24.04
      output: Experiment created; arm agents dispatched.
      permissions:
        actions: write
        contents: write
        issues: write
        pull-requests: write
      inputs:
        manifest:
          description: The experiment manifest as a YAML document (see the format in the instructions).
          required: true
          type: string
        cases:
          description: Optional JSON array of new benchmark cases, each {"id", "case", "files"}. Required for kind rules when the corpus lacks coverage.
          required: false
          type: string
      steps:
        - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
          with:
            persist-credentials: false
            sparse-checkout: |
              .github
              corpus
              dist-action
        - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
          with:
            node-version-file: .nvmrc
        - name: Mint repository App token
          id: app-token
          if: vars.CICD_OPTIMIZER_APP_ID != ''
          uses: actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0
          with:
            client-id: ${{ vars.CICD_OPTIMIZER_APP_ID }}
            private-key: ${{ secrets.CICD_OPTIMIZER_APP_PRIVATE_KEY }}
            owner: ${{ github.repository_owner }}
            repositories: ${{ github.event.repository.name }}
            permission-actions: read
            permission-contents: write
            permission-issues: write
            permission-pull-requests: write
        # The CLI re-validates every proposal (schema, rubric bar, unique name, concurrency budget, case limits).
        - name: Create experiment
          env:
            GITHUB_TOKEN: ${{ steps.app-token.outputs.token || secrets.CICD_OPTIMIZER_TOKEN || github.token }}
            CICD_OPTIMIZER_DISPATCH_TOKEN: ${{ github.token }}
          run: node dist-action/index.js experiments create --agent-output "$GH_AW_AGENT_OUTPUT" --arm-workflow experiment-arm.lock.yml
---

# Hill-climbing experiment generator

You design experiments that make this repository's CI/CD faster for high-volume, agent-authored changes, or that make
the CI/CD optimizer's lint rules more accurate. Each experiment tests one hypothesis with 1-4 competing **arms**; an
agent implements each arm on `experiments/<name>/<arm>`, and a daily grader promotes the arm that beats the control
(`experiments/<name>/trunk`) with statistical significance.

## Inputs

Read `/tmp/gh-aw/hill-climb/context.md` first. It contains the rubric and its weights, the configured metrics, the
current lint findings on the default branch, recent CI telemetry (critical path, slowest jobs, regressions) when
available, the experiments that are running, every past experiment and its outcome, and the available rules.

## Choose at most one experiment

1. Prefer the opportunity with the largest expected wall-clock saving per agent-authored change: critical-path jobs,
   repeated dependency installs, missing caches, cold container builds, full checkouts or full test runs where a sparse
   checkout or affected-only tests would do, or lint rules that miss (recall) or misreport (precision) such problems.
2. Do not repeat a running or past experiment unless you bring a materially new angle, and say what it is.
3. Make arms genuinely different approaches to the same hypothesis, each small enough to implement and review in one
   pull request. Every arm must be measurable with the experiment's metrics.
4. Score the proposal honestly against every rubric criterion (1-5). Proposals below the bar are refused, and inflated
   scores waste the experiment budget.
5. If nothing clears the bar, call `noop` with a one-paragraph explanation instead of proposing something weak.

## Manifest format

Call `create_experiment` once with `manifest` set to a YAML document like:

```yaml
name: cache-npm-downloads          # lowercase kebab-case, 2-48 chars, never used before
title: Cache npm downloads in every Node job
hypothesis: >-
  Restoring the npm download cache keyed on package-lock.json removes ~40s of network time from each Node job on the
  critical path.
kind: pipeline                     # pipeline: CI/CD files, measured by CI runs | rules: lint engine, measured on corpus/
metrics: [ciWallClock, ciTestJob]  # optional; ids from the metrics section of the context
rubric:
  scores: { impact: 4, evidence: 4, safety: 5, generality: 4, measurability: 4 }
  rationale: Why each score is deserved, citing the telemetry or findings that motivate it.
arms:
  - name: setup-node-cache         # kebab-case, not "trunk"
    title: setup-node built-in cache
    approach: Precise implementation brief for the arm agent - which files to change, how, and what not to touch.
  - name: actions-cache-keyed
    title: Explicit actions/cache keyed on the lockfile hash
    approach: ...
applicability:                     # what a winner generalizes to; seeds the reusable recipe for other repositories
  rules: [caching/setup-cache]
  files: [".github/workflows/*.yml"]
  description: Node.js workflows that run npm ci without a dependency cache.
source:
  findings: [caching/setup-cache]
  notes: Links or evidence the hypothesis is based on.
```

## Benchmark cases (kind: rules)

Rule experiments are scored on `corpus/` (precision, recall, autofix rate, speed). If the corpus does not already
contain cases that would reveal the improvement, add up to 10 new cases through the `cases` input as a JSON array:

```json
[{
  "id": "npm-ci-without-cache",
  "case": "description: npm ci on every run without a dependency cache.\nrules: [caching/setup-cache]\nexpected:\n  - { rule: caching/setup-cache, path: .github/workflows/ci.yml }\n",
  "files": { ".github/workflows/ci.yml": "name: CI\non: push\n..." }
}]
```

- `case` is the `case.yml` text: `description`, `rules` (rules whose findings are scored), `expected` findings
  (`rule`, `path`, optional `line`), and optionally `fixed` (expected file contents after autofix).
- `files` maps repository-relative paths to file contents. Include negative cases (correct configurations that must
  not be flagged) as well as positive ones, so precision is measured too.
- Ids must be new; existing cases are immutable. Check how the current engine scores a case before proposing it, by
  writing its files to a scratch directory under `/tmp/gh-aw/agent/` and running
  `node dist-action/index.js lint --preset all <dir>`.

Never ask arms to modify `corpus/`, `.github/hill-climb.yml`, or `experiments/*/experiment.yml`; arms that do are
disqualified.
