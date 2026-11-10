# Recipes: reusable fixes from promoted experiments

When an experiment wins in one repository, the improvement usually applies to many more. A **recipe** packages a promoted
`pipeline` experiment as a portable change, the way Dependabot packages a dependency update. A rollout then applies it to
other repositories in waves gated by a CI **compatibility score**. If the change doesn't fit a repository verbatim, a
coding agent adapts it there instead of failing.

```text
experiments/<name>/trunk merged ──▶ recipe-publish ──▶ recipes/<name>.yml (PR) ──▶ recipe-rollout (weekly)
                                                                                     │
          canaries ─▶ wave 1 ─▶ wave 2 ─▶ … (only while CI compatibility holds)      ▼
                                                     target repo: autofix PR, or adaptation issue → Copilot
```

## Publishing

[recipe-publish.yml](../.github/workflows/recipe-publish.yml) runs when an `experiments/<name>/trunk` pull request is
merged into `main`. It runs `recipes publish`, which reads the promoted manifest and the merged winning arm's pull request
and writes `recipes/<name>.yml`. A pull request then publishes the recipe for review.

`rules` experiments are skipped because they change the linter itself and ship with the next release. Experiment
bookkeeping is excluded from the patch: `experiments/**`, `corpus/**`, and `.github/hill-climb.yml`.

```yaml
schemaVersion: 1
id: npm-cache-restore-keys
revision: 1                     # bumps when the change targets receive changes, which resets compatibility
title: Restore partial npm caches on lockfile changes
summary: Agent pull requests change package-lock.json often…
risk: low                       # low | medium | high
rules: [caching/setup-cache]    # findings this recipe resolves; their autofixes apply to targets
files: []                       # globs that make the recipe applicable when it has no rules
instructions: "actions/cache with restore-keys: Replace setup-node's cache with …"   # brief for coding agents
evidence:                       # measured in the source experiment
  improvement: 0.21
  metrics:
    - { metric: ciWallClock, control: 412000, arm: 318000, delta: 0.228, pValue: 0.004 }
source: { repository: my-org/ci-cd-optimizer, experiment: npm-cache-restore-keys, arm: restore-keys, pullRequest: 87 }
patch: |                        # reference diff of the winning arm (may be truncated)
  diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
  …
patchFiles: [.github/workflows/ci.yml]
compatibility: { passed: 0, failed: 0 }   # results for the current revision, written by rollout --write
```

Applicability comes from the experiment manifest's `applicability.rules` and `applicability.files`. When neither is set,
the files the winner changed decide where the recipe applies.

### Risk

| Risk | Patch contents |
|---|---|
| `low` | Only workflows (`.github/workflows/*.yml`) and actions (`.github/actions/**`, `action.yml`). These can't change what gets built. |
| `medium` | Containerfiles, `.dockerignore`, compose files, or any other non-pipeline file. |
| `high` | Package manifests or lockfiles (`package.json`, `go.mod`, `pom.xml`, `*.csproj`, `nx.json`, and so on), or more than 10 files. |

## Applying to a repository

`recipes apply --recipe <file> --target <owner/name>` reads the target's default branch and its
`.github/ci-cd-optimizer.yml`, then picks one outcome:

| Status | When | Result in the target |
|---|---|---|
| `ignored` | `recipes.enabled: false`, the recipe id is in `recipes.ignore`, every recipe rule is turned off, or the target's config is invalid. | Nothing. |
| `too-risky` | The recipe's risk exceeds `recipes.maxRisk` (default `medium`). | Nothing. |
| `not-applicable` | None of the recipe's rules report findings, or no files match its `files` globs. | Nothing. Doesn't count toward compatibility. |
| `autofix` | The recipe rules' autofixes resolve every finding. | A pull request, like a [fix PR](configuration.md#fix-pull-requests-fixes), with the evidence, risk, and compatibility in the body. |
| `partial` | Autofixes resolve some findings. | A pull request plus an adaptation issue for the remaining findings. |
| `adapt` | No autofix applies, or the recipe is file-based. | An **adaptation issue** containing the recipe's instructions, evidence, and reference patch, assigned to the Copilot coding agent when `recipes.assignCopilot` is true and `COPILOT_ASSIGN_TOKEN` is set. |

The adaptation path is how recipes handle "breaking changes". Dependabot can only bump a version, but a recipe falls back
to an agent that applies the same pattern to the target's own layout and verifies it with that repository's CI.

Re-running is idempotent: unchanged pull requests and issues are left alone, open ones are re-synced, and obsolete ones
are closed. Target-side preferences are covered in [configuration.md](configuration.md#recipes-recipes).

## Compatibility score

As with Dependabot's compatibility score, each target's result for the **current revision** counts as evidence:

| Outcome | Counts as |
|---|---|
| Pull request merged, or all checks passed | passed |
| Any check failed, timed out, or was cancelled | failed |
| Pull request closed unmerged with no CI evidence | failed (declined) |
| Adaptation issue closed as completed / as not planned | passed / failed |
| Checks running, or issue open | pending |
| Open pull request with no checks | unknown |

The score is the **Wilson 95% lower bound** of the pass rate. It stays conservative on small samples: 3 of 3 passes
scores about 44%, and 30 of 30 scores about 89%. `recipes status --write` and `recipes rollout --write` store the counts
in the recipe file. The rollout workflow commits them as a pull request, so the score that target pull requests display
is versioned and reviewed.

## Evidence-backed application history

`recipes apply` and `recipes rollout` accept `--record-knowledge` to save proposals in the App's Postgres evidence
database (`DATABASE_URL`). This is opt-in; ordinary CLI commands do not silently connect to a database. Dry runs never
initialize, read, or write this store, even with the flag. The hosted rollout workflow enables the flag only when
`secrets.CICD_OPTIMIZER_DATABASE_URL` is configured. The database must be reachable over an appropriately protected
connection from the runner; this does not provision infrastructure or grant network access.

Recording first reads `recipes/<id>.yml` from an authenticated immutable source revision and requires it to match
the local recipe definition. Install the App on the **source catalog repository as well as the targets**, with
Contents read. A local file cannot populate a private source catalog simply by naming that repository. Persisted
definitions exclude compatibility counts and historical prose-based success claims. Definition-affecting changes
(including title, summary, risk and provenance) now bump the recipe revision and reset compatibility.

Target topology is pinned to the snapshot used for planning. Proposed PRs pin their actual head commit; adaptation
issues are tracked separately. Project attribution remains empty until execution evidence establishes it. GitHub
merge state can mark the pinned proposal applied, but never successful. Issue completion or a subsequently changed
PR head remains unknown. With `DATABASE_URL`, the App refreshes recorded lifecycle state on completed runs when
recipes are enabled and source access is available. The latest 100 applications are considered; this is bounded
coverage, not a complete historical scan.

The authorized CLI makes that history usable without a raw database query:

```sh
ci-cd-optimizer knowledge applications --repo acme/web --limit 20
ci-cd-optimizer knowledge inspect --repo acme/web --application <application-id>
ci-cd-optimizer knowledge runs --repo acme/web --limit 20
ci-cd-optimizer knowledge refresh --repo acme/web --application <application-id>
ci-cd-optimizer knowledge evaluate --repo acme/web --application <application-id> \
  --control <observation-id-1>,<observation-id-2> --treatment <observation-id-3>,<observation-id-4>
```

Commands output JSON. IDs are immutable database evidence IDs, not Actions run numbers. All commands recheck
current GitHub access; reading/evaluating measured outcomes also requires Actions read for the exact attempts and
Contents read for their exact source revisions. `refresh` and `evaluate` write only to the database. Evaluations
reject retries, conflicting corrections, overlapping logical runs, incomparable contexts and runs that do not bracket
the recorded application. Small samples remain inconclusive. The two-sided test is exploratory: caller-selected
windows, temporal dependence, repeated testing and unobserved changes prevent interpreting it as causal proof or a
prediction for another project. A statistically detected duration change does not replace functional CI compatibility.

If GitHub accepts a change but persistence fails, the command fails visibly. Retry it to recover the existing
PR/issue and append the missing evidence; it does not claim atomicity across GitHub and Postgres. Rollout exits
nonzero when any target fails. Do not configure this database secret in untrusted experiment-arm execution.

## Rollout

[recipe-rollout.yml](../.github/workflows/recipe-rollout.yml) runs weekly, or on dispatch with an optional recipe id and
dry run. For each `recipes/*.yml`, it applies the recipe to the next wave of targets listed in `.github/recipe-targets.yml`
([example](../examples/recipe-targets.yml)):

```yaml
repositories: [my-org/web, my-org/api, my-org/mobile, my-org/platform-tools, my-org/data-pipeline]
canaries: [my-org/platform-tools]   # applied first, in order; must also be listed in repositories
rollout:
  waves: [1, 3, "25%", "100%"]      # cumulative counts or percentages of applicable repositories
  minSamples: 5                      # before this many results, any failure halts
  minCompatibility: 0.7              # after that, the Wilson lower bound must stay at or above this
```

Targets are ordered canaries first, then by a stable hash of `recipe id + repository`. The hash spreads early waves
across different repositories for different recipes, and the order is the same on every run. Repositories where the
recipe is not applicable, ignored, or too risky are skipped and don't use up wave slots.

| Decision | When |
|---|---|
| `complete` | Every applicable repository has the change, or none are applicable. |
| `wait` | Changes from the current wave are still running CI or awaiting review. |
| `halt` | Changes were opened but produced no CI evidence, any change failed before `minSamples` results, or the compatibility lower bound fell below `minCompatibility`. A human decides whether to fix the recipe (a new revision restarts the score) or ignore it. |
| `advance` | Opens the next wave. |

Run the same steps locally:

```sh
node dist-action/index.js recipes status  --recipe recipes/npm-cache-restore-keys.yml --targets .github/recipe-targets.yml
node dist-action/index.js recipes rollout --recipe recipes/npm-cache-restore-keys.yml --targets .github/recipe-targets.yml --dry-run
node dist-action/index.js recipes apply   --recipe recipes/npm-cache-restore-keys.yml --target my-org/web --dry-run
```

## Setup

| Setting | Used by | Why |
|---|---|---|
| `vars.CICD_OPTIMIZER_APP_ID`, `secrets.CICD_OPTIMIZER_APP_PRIVATE_KEY` | recipe-publish, recipe-rollout | Mints repository-scoped tokens for publication/score PRs and a separate installation token for configured targets. The [App](github-app.md) must be installed on the source and targets. Target rollout is skipped when the variable isn't set. |
| `secrets.CICD_OPTIMIZER_TOKEN` (optional) | recipe-publish | Publication fallback when the App is not configured. The final `GITHUB_TOKEN` fallback needs permission to create PRs and does not trigger their CI. |
| `secrets.COPILOT_ASSIGN_TOKEN` (optional) | recipe-rollout | A user token that can assign adaptation issues to the Copilot coding agent. Without it, issues get the `copilot:ready` label (see [assign-copilot.yml](../examples/workflows/assign-copilot.yml)). |
| `secrets.CICD_OPTIMIZER_DATABASE_URL` (optional) | recipe-rollout | Records authenticated recipe definitions and pinned target proposals in the App's evidence database. Requires protected runner-to-database connectivity; dry runs never use it. |

Generated recipe branches and their PRs use the same publication credential; checkout credentials are not retained.
Repeated publication uses an explicit lease on the observed remote branch head, refusing a concurrent push rather than
overwriting it. These are bot-owned generated branches: propose manual recipe edits on a different branch.
