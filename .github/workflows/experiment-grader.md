---
description: Grades running hill-climbing experiments daily and promotes, rejects, or expires them.
on:
  schedule: daily
  workflow_dispatch:
  permissions:
    contents: read
    pull-requests: read
  steps:
    # Skip inference entirely when no experiment is running.
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
      if: fromJSON(steps.count.outputs.running) > 0
      run: echo "Experiments are available to grade."
if: needs.pre_activation.outputs.check_result == 'success'
permissions:
  actions: read
  checks: read
  contents: read
  copilot-requests: write
  issues: read
  pull-requests: read
engine: copilot
runs-on: ubuntu-24.04
timeout-minutes: 30
checkout:
  # Arm and trunk commits must exist locally: the agent job never holds git credentials.
  fetch: ["experiments/*"]
network:
  allowed: [defaults, github]
tools:
  bash: ["cat", "ls", "head", "tail", "grep", "wc", "jq", "git diff:*", "git log:*", "git show:*"]
steps:
  - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
    with:
      node-version-file: .nvmrc
      cache: npm
  - name: Collect measurements
    env:
      GITHUB_TOKEN: ${{ github.token }}
    run: |
      mkdir -p /tmp/gh-aw/hill-climb/measurements
      echo "One JSON file per running experiment." > /tmp/gh-aw/hill-climb/measurements/README.txt
      node dist-action/index.js experiments collect --output-dir /tmp/gh-aw/hill-climb/measurements
  # Builds and benchmarks each arm in its own worktree. Arm code is untrusted, so this step gets no token, the job is
  # read-only, and every decision is re-derived from these numbers by deterministic code in the grading job.
  - name: Benchmark rule arms on the corpus
    run: node dist-action/index.js experiments evaluate --measurements /tmp/gh-aw/hill-climb/measurements
  - name: Preview decisions
    env:
      GITHUB_TOKEN: ${{ github.token }}
    run: node dist-action/index.js experiments decide --measurements /tmp/gh-aw/hill-climb/measurements > /tmp/gh-aw/hill-climb/preview.md
  # Uploaded before the agent starts, so the grading job applies decisions to measurements the agent cannot alter.
  - name: Upload measurements
    uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
    with:
      name: hill-climb-measurements
      path: /tmp/gh-aw/hill-climb/measurements
      retention-days: 7
safe-outputs:
  jobs:
    grade-experiments:
      description: >-
        Record rubric judgments for experiment arms and apply the grading decisions: dispatch more CI runs, promote the
        winning arm, or reject or expire the experiment.
      runs-on: ubuntu-24.04
      output: Grading decisions applied.
      permissions:
        actions: write
        contents: write
        issues: write
        pull-requests: write
      inputs:
        judgments:
          description: 'JSON array of {"experiment", "arm", "score" (0-1), "rationale"}; use [] when no arm can be judged yet.'
          required: true
          type: string
      steps:
        - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
          with:
            name: hill-climb-measurements
            path: /tmp/hill-climb/measurements
        - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
          with:
            persist-credentials: false
            sparse-checkout: |
              .github
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
            permission-workflows: write
        - name: Apply decisions
          env:
            GITHUB_TOKEN: ${{ steps.app-token.outputs.token || secrets.CICD_OPTIMIZER_TOKEN || github.token }}
            CICD_OPTIMIZER_DISPATCH_TOKEN: ${{ github.token }}
          run: node dist-action/index.js experiments decide --measurements /tmp/hill-climb/measurements --agent-output "$GH_AW_AGENT_OUTPUT" --apply
---

# Hill-climbing experiment grader

You are the qualitative judge for running experiments. Deterministic code has already measured every arm against its
experiment's trunk (the control); your judgment is one input to the final score (the `judgeWeight` in
`.github/hill-climb.yml`), so be calibrated and critical.

## Inputs

- `/tmp/gh-aw/hill-climb/measurements/<experiment>.json`: per branch, `headSha`, `changedPaths`, corpus metrics
  (`rules` experiments) or CI duration samples in seconds (`pipeline` experiments), `testsPassed`, and any `error`.
  `control` is the trunk.
- `/tmp/gh-aw/hill-climb/preview.md`: the decision the grader would make with no judgments, with metric deltas and
  p-values.
- The manifest of each experiment: `git show <control headSha>:experiments/<experiment>/experiment.yml`.
- Each arm's change: `git diff <control headSha> <arm headSha>`.

## Judge each arm

For every arm with a `headSha`, read its diff and the manifest, then score it from 0 to 1:

- **Fidelity**: does it implement its own `approach` rather than drifting into another arm's?
- **Safety**: hermeticity, pinned actions, least-privilege permissions, no skipped or weakened tests or checks, easy to
  revert.
- **Generality**: would the pattern transfer to other repositories as a rule or recipe?
- **Quality**: focused, readable, tested; no benchmark gaming (special-casing corpus files, hard-coded expectations).

Score 0 for an arm that games the metrics or weakens security, whatever its numbers. Keep each rationale under 100
words and cite concrete lines of the diff.

## Output

Call `grade_experiments` exactly once with `judgments` set to a JSON array, for example
`[{"experiment":"cache-npm-downloads","arm":"setup-node-cache","score":0.8,"rationale":"..."}]`. Call it even when
no arm can be judged yet (pass `[]`): the grading job also dispatches the CI runs that pipeline experiments are
waiting for. Only when the measurements directory contains no `.json` files, call `noop` instead.
