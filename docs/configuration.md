# Configuration

CI/CD Optimizer reads `.github/ci-cd-optimizer.yml` (or `.yaml`) from the repository root. Every key is optional.
Unknown keys, rule ids, rulesets, and options are reported with "did you mean" suggestions rather than ignored.

```sh
npm run cli -- lint . -c .github/ci-cd-optimizer.yml   # validates the file as part of linting
```

## Linting

```yaml
schemaVersion: 1
enabled: true

# Presets: recommended (default), strict, agentic, github, insights, all. Later presets add rules.
extends: [recommended, agentic]

# Set every rule in a ruleset at once: off | info | warn | error.
rulesets:
  registries: info
  hermeticity: error

# Per-rule severity, or [severity, options]. Rule settings override rulesets and presets.
rules:
  hermeticity/pin-actions: [error, { ignoreOwners: [actions, github] }]
  workflow/job-timeout: [warn, { defaultMinutes: 20, maxMinutes: 90 }]
  registries/github-npm: [info, { scopes: ["@my-org"] }]
  containers/shared-base: off

# Glob patterns that are never linted. Setting this replaces the defaults below.
ignorePaths: [vendor/**, node_modules/**, "**/node_modules/**", dist/**, build/**, .github/workflows/*.lock.yml]

# Exit 1 (or a failing check run) at this severity: info | warn | error | never.
failOn: error

limits:
  maxFiles: 2000        # files fetched per scan
  maxFileBytes: 512000  # larger files are skipped
```

Presets:

| Preset | Intent |
|---|---|
| `recommended` | High-confidence speed and reproducibility rules; the default. |
| `agentic` | Adds rules that matter at high change volume: merge queue, change detection, cache mounts, `exports` maps. |
| `strict` | Stricter hermeticity and checkout hygiene, such as SHA-pinned actions and sparse checkout everywhere. |
| `github` | Recommends GHCR and the GitHub npm registry for organization-wide reuse. |
| `insights` | Architecture signals: monolith decomposition, shared base images. |
| `all` | Every rule. |

Rule options and defaults are listed per rule in [rules.md](rules.md). Generated gh-aw `.lock.yml` workflows are
ignored by default. Fix the `.md` source and recompile instead.

### Legacy keys

v0.1 keys are migrated with a warning:

| v0.1 key | v0.2 key |
|---|---|
| `disabledRules` | `rules: { <id>: off }` |
| `failOnSeverity` | `failOn` |
| `ignoredPaths` | `ignorePaths` |
| `maxFiles` / `maxFileBytes` | `limits` |

v0.1 rule ids such as `workflow-timeout` map to their v0.2 ids, for example `workflow/job-timeout`.

## Issues (`issues`)

Opens Dependabot-alert-style issues for findings that meet a threshold. Issues are fingerprinted, updated as findings
change, and closed when resolved. Disabled by default.

```yaml
issues:
  enabled: true
  minSeverity: warn        # info | warn | error (default error)
  minImpact: medium        # low | medium | high (default low)
  groupBy: rule            # rule: one issue per rule; finding: one per diagnostic
  labels: [ci-cd-optimizer]
  assignees: []
  maxOpen: 10              # cap on open finding issues
  closeResolved: true
  rules:                   # force (true) or suppress (false) issues regardless of severity
    hermeticity/frozen-lockfile: true
    registries/ghcr: false
  assignCopilot: true      # assign to the Copilot coding agent (needs COPILOT_ASSIGN_TOKEN)
  copilot:
    baseBranch: main
    customInstructions: Keep changes minimal and run the test suite.
    customAgent: ci-optimizer   # optional .github/agents/<name>.agent.md
    model: ""                   # optional model override
```

## Fix pull requests (`fixes`)

Groups safe autofixes into Dependabot-style pull requests. Disabled by default.

```yaml
fixes:
  enabled: true
  openPullRequestsLimit: 5
  branchPrefix: cicd-optimizer/
  draft: false
  labels: [ci-cd-optimizer, dependencies]
  reviewers: [my-org/platform]
  groups:                  # ungrouped fixable rules get one pull request per ruleset
    pinning:
      rulesets: [hermeticity]
    workflow-hygiene:
      rules: [workflow/concurrency, workflow/job-timeout]
  ignore:                  # rule ids or ruleset wildcards such as registries/*
    - rule: hermeticity/pin-runner
      paths: [.github/workflows/legacy-*.yml]
```

Comment on a fix pull request to control it:

- `@cicd-optimizer rebase` rebuilds the change on the latest base, unless someone else has pushed to the branch.
- `@cicd-optimizer recreate` rebuilds the change and overwrites manual edits.
- `@cicd-optimizer close` closes the pull request, and it won't reopen for the same change.
- `@cicd-optimizer ignore this rule [rule-id]` stops fixes for that rule. Without an id, it stops fixes for every rule
  in the pull request.
- `@cicd-optimizer ignore this group` closes the pull request and stops fixes for the group.

Ignores are recorded with the `cicd-optimizer:ignored` label; remove it to undo. Use `fixes.ignore` for permanent ignores.

## Duration alerts (`alerts`)

Raises issues when a workflow or job gets statistically significantly slower. Enabled by default.

```yaml
alerts:
  enabled: true
  branches: [main]          # empty = every branch
  window: 30                # baseline: up to this many prior successful runs
  minSamples: 10            # no alerts until the baseline has this many runs
  zThreshold: 3.5           # spike: robust z-score (median/MAD) of the latest run
  regressionWindow: 5       # regression: these recent runs vs the baseline...
  pValue: 0.01              # ...one-sided Mann-Whitney U below this p-value
  minIncreasePercent: 20    # and the increase must be material in relative...
  minIncreaseSeconds: 30    # ...and absolute terms
  recoveryRuns: 3           # close the alert after this many normal runs
  snoozeDays: 14            # after "close as not planned", stay quiet this long
  labels: [performance-regression]
  assignees: []
  assignCopilot: false
```

## Recipes (`recipes`)

Target-side preferences for recipes rolled out from other repositories, similar to a per-repository
`dependabot.yml`.

```yaml
recipes:
  enabled: true
  maxRisk: medium          # low: workflow-only, medium: containers and caches, high: packages and lockfiles
  ignore: [cache-npm-downloads]
  labels: [ci-cd-optimizer, recipe]
  assignCopilot: true      # adaptation issues go to the Copilot coding agent
```

## Hill climbing (`.github/hill-climb.yml`)

The experiment rubric, metrics, selection statistics, protected paths, and promotion policy live in a separate file.
See [experiments.md](experiments.md).
