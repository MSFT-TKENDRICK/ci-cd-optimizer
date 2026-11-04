---
name: Experiment arm
run-name: "Experiment arm ${{ github.event.inputs.experiment }}/${{ github.event.inputs.arm }}"
description: Implements one arm of a hill-climbing experiment and opens its pull request into the experiment trunk.
on:
  workflow_dispatch:
    inputs:
      experiment:
        description: Experiment name (experiments/<experiment>/trunk must exist)
        required: true
        type: string
      arm:
        description: Arm name from the experiment manifest
        required: true
        type: string
permissions:
  actions: read
  contents: read
  copilot-requests: write
  issues: read
  pull-requests: read
engine: copilot
runs-on: ubuntu-24.04
timeout-minutes: 45
# experiments create dispatches every arm at once; each experiment/arm pair gets its own slot so arms build in parallel.
concurrency:
  group: experiment-arm-${{ github.event.inputs.experiment }}-${{ github.event.inputs.arm }}
  cancel-in-progress: false
  job-discriminator: ${{ github.event.inputs.experiment }}-${{ github.event.inputs.arm }}
checkout:
  ref: experiments/${{ github.event.inputs.experiment }}/trunk
network:
  allowed: [defaults, github, node]
tools:
  edit:
  bash: ["npm:*", "node:*", "git:*", "cat", "ls", "head", "tail", "grep", "wc", "find", "diff", "mkdir", "yq"]
steps:
  - name: Validate inputs and start the arm branch
    env:
      EXPERIMENT: ${{ github.event.inputs.experiment }}
      ARM: ${{ github.event.inputs.arm }}
    run: |
      set -euo pipefail
      NAME='^[a-z0-9][a-z0-9-]{1,47}$'
      [[ "$EXPERIMENT" =~ $NAME ]] || { echo "::error::invalid experiment name"; exit 1; }
      [[ "$ARM" =~ $NAME && "$ARM" != trunk ]] || { echo "::error::invalid arm name"; exit 1; }
      MANIFEST="experiments/$EXPERIMENT/experiment.yml"
      test -f "$MANIFEST" || { echo "::error::$MANIFEST not found on the trunk"; exit 1; }
      [ "$(yq '.status' "$MANIFEST")" = running ] || { echo "::error::experiment is not running"; exit 1; }
      yq -e '.arms[] | select(.name == strenv(ARM))' "$MANIFEST" > /dev/null || { echo "::error::arm not in manifest"; exit 1; }
      git switch -c "experiments/$EXPERIMENT/$ARM"
  - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
    with:
      node-version-file: .nvmrc
      cache: npm
  - run: npm ci --no-audit --no-fund
safe-outputs:
  create-pull-request:
    title-prefix: "[experiment] "
    labels: [experiment]
    # Arm pull requests must not be drafts: the grader squash-merges the winner into the trunk.
    draft: false
    max: 1
    base-branch: experiments/${{ github.event.inputs.experiment }}/trunk
    allowed-branches: ["experiments/*/*"]
    preserve-branch-name: true
    if-no-changes: error
    # Pipeline arms change .github/workflows, which GITHUB_TOKEN cannot push; set CICD_OPTIMIZER_TOKEN to allow it.
    github-token: ${{ secrets.CICD_OPTIMIZER_TOKEN || secrets.GITHUB_TOKEN }}
    protected-files: request-review
---

# Implement experiment arm `${{ github.event.inputs.arm }}` of `${{ github.event.inputs.experiment }}`

You are on branch `experiments/${{ github.event.inputs.experiment }}/${{ github.event.inputs.arm }}`, created from the
experiment trunk, with dependencies installed. Read `experiments/${{ github.event.inputs.experiment }}/experiment.yml`:
its `hypothesis`, `kind`, and `metrics` describe the experiment, and the `approach` of the arm named
`${{ github.event.inputs.arm }}` is your implementation brief. Other arms test competing approaches; implement only
yours, faithfully, so the comparison is fair.

## Rules

- Never modify `corpus/`, `.github/hill-climb.yml`, or any `experiments/*/experiment.yml`. Arms that touch them are
  disqualified.
- Keep the change focused on the approach. No unrelated refactors, formatting churn, or dependency upgrades.
- Do not weaken security: keep actions pinned to full commit SHAs, permissions minimal, and secrets out of logs.
- Never game the metrics, for example by special-casing benchmark files or skipping tests.

## Kind `rules` (the lint engine, scored on `corpus/`)

1. Change `src/` and add or update tests under `test/` (the rule tester in `test/lint/rule-tester.ts` is the pattern).
2. Run `npm run typecheck`, `npm test`, and `npm run lint`; all must pass.
3. Benchmark before you change anything and again afterwards: `npm run build` then
   `node dist-action/index.js experiments evaluate --engine dist/lint/api.js --corpus corpus -o /tmp/gh-aw/agent/<before|after>.json`.
   Do not open a pull request that lowers precision or recall.
4. Run `npm run bundle` and `npm run docs:rules` so `dist-action/` and `docs/rules.md` match the source; CI fails
   otherwise.

## Kind `pipeline` (CI/CD configuration, scored on CI wall-clock time)

1. Change workflows, composite actions, Dockerfiles, or build scripts as the approach describes.
2. Validate with `node dist-action/index.js lint --preset all --fail-on warn` and confirm `npm test` still passes.
3. Keep every job that exists today and keep the `test` job name stable; metrics compare those jobs across runs.

## Open the pull request

Commit on the current branch, then call `create_pull_request` exactly once with branch
`experiments/${{ github.event.inputs.experiment }}/${{ github.event.inputs.arm }}`. The body must state the approach,
the files changed, how you validated the change, and before/after numbers where you measured them. If the approach
cannot be implemented safely, call `noop` and explain why instead.
