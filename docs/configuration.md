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

# Presets: recommended (default), strict, agentic, github, insights, ssdf, all. Later presets add rules.
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

# Repository-relative .js/.mjs modules exporting local/* rules. The CLI loads them only with --allow-local-rules;
# the GitHub App and MCP/ACP agent interfaces never load them.
localRules: [.github/cicd-rules/approved-runners.mjs]
```

Presets:

| Preset | Intent |
|---|---|
| `recommended` | Common build, cache and reproducibility checks; the default. Confidence and runtime assumptions remain rule-specific. |
| `agentic` | Adds rules that matter at high change volume: merge queue, change detection, cache mounts, `exports` maps. |
| `strict` | Stricter hermeticity and checkout hygiene, such as SHA-pinned actions and sparse checkout everywhere. |
| `github` | Recommends GHCR and the GitHub npm registry for organization-wide reuse. |
| `insights` | Architecture signals: monolith decomposition, shared base images. |
| `ssdf` | Opt-in repository-visible evidence checks for NIST SP 800-218 SSDF v1.1. See [SSDF evidence reporting](ssdf.md). |
| `all` | Every rule. |

Rule options and defaults are listed per rule in [rules.md](rules.md). Generated gh-aw `.lock.yml` workflows are
ignored by default. Fix the `.md` source and recompile instead.

The rulesets include `hooks`, `nix` and `toolchains`; these work through every built-in entry point, with no separate
plugin or Nix/toolchain executable required. `rulesets: { nix: warn }` selects all 37 Nix rules regardless of preset;
individual `rules` entries can then narrow them. See [Nix behavior and assumptions](nix.md).

`rulesets: { hooks: warn }` selects Git-hook and pre-commit optimization rules. They flag direct dependency
installs on the interactive hook path and explicit whole-repository lint entries that also receive batched
filenames. Recommendations preserve secret scans, mandatory checks and CI gates; they never suggest bypassing
hooks or automatically narrowing a repository-wide check to staged files.

Absence-based rules need a complete inventory of relevant repository files. File limits, oversized content-bearing
files, API filtering/truncation, unreadable entries, and symlinks/submodules can make that inventory incomplete.
Excluding an existing relevant file with `ignorePaths` also makes absence unknown: ignoring `flake.lock`, a version
file, or an updater workflow must not become evidence that it is missing. This conservatively skips complete-inventory
rules even when an exclusion seems unrelated to a particular finding. Large presence-only lockfiles retain a header;
oversized `flake.lock` and `devenv.lock` do not. Ignore patterns with no matching relevant entries do not alone make
the inventory incomplete; an explicitly ignored expected flake lock is not reported missing either way.

Suppression comments, `--init`, `--print-config`, and writing local rules are covered in [linter.md](linter.md).

### Agent-interface restrictions

[MCP and ACP](agents.md) share these rule settings but always use built-in rules and read-only operations.
Local agent inventory limits are the lower of this configuration and hard ceilings of 250 files, 256 KiB per file,
and 4 MiB aggregate including unsaved overrides. Local configuration is limited to 64 KiB. Truncation and ignored
local rules are reported rather than silently treated as a clean scan.

Agent exposure/authentication is **process configuration**, not repository-controlled YAML. Remote MCP requires
`--enable-remote`, explicit `--repo` allowlists, and a provisioned token. Hosted ACP requires
`CICD_OPTIMIZER_ACP=true`, `CICD_OPTIMIZER_ACP_AUTH=github-user`, and
`CICD_OPTIMIZER_ACP_REPOSITORIES=owner/repo:numeric-id`; see [hosted setup](agents.md#hosted-acp-on-your-own-app-deployment)
for authentication, transport, limits, and deployment requirements. Hosted MCP has separate
`CICD_OPTIMIZER_MCP`, `CICD_OPTIMIZER_MCP_AUTH`, and `CICD_OPTIMIZER_MCP_REPOSITORIES` settings; see
[hosted MCP](agents.md#hosted-mcp-on-your-own-app-deployment). Repository settings cannot enable writes or
raise agent transport quotas.

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

Groups available autofixes into Dependabot-style pull requests. Disabled by default. Review and test each diff:
fixability does not establish semantic equivalence or measured performance improvement. Nix and toolchain rules
are advisory and do not produce automatic edits.

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

Scans reconcile missing configured labels and unfinished reviewer setup as `metadata` actions, also visible in dry-run
output. These do not rebuild the branch, including when someone has pushed human commits. Draft PRs retain pending
reviewer setup until a scan after they become ready. Interrupted PR updates are also reconciled as `metadata` actions
(`recoverUpdate: true`): an already-applied target needs only marker finalization, while an unapplied intent is
discarded before the normal planner considers current policy and base contents. Keep review notes outside the
generated body's hidden boundaries; marker-only recovery preserves all current body text.
Pending branch cleanup is also a `metadata` action (`cleanup: true`), including for closed PRs. It retains the original
observed head across retries; changed heads and observed open-PR reuse are preserved. A manually reopened PR with cleanup history
is held rather than immediately closed again. Normal fix PRs can resume with an explicit rebase/recreate command.
Removing a management/configured label alone does not opt out:
use the ignore controls below. See [partial-write recovery](github-app.md#durable-hosted-processing) for limits.

Discovery lists the labeled history first, then looks up each group's deterministic head branch against the base so a
pull request whose labeling failed is still found. Those per-group lookups are read-only and share a pool of at most
eight requests in flight, the same fan-out the scan already uses for repository blobs; results are applied in group
order, writes stay serial, and a failed lookup or a truncated one (1000 results) fails the scan closed instead of
reconciling from partial history. GitHub's REST guidance prefers serial requests to avoid secondary rate limits and the
client does not retry, so a rate-limit response ends the scan visibly rather than being absorbed.

Comment on a fix pull request to control it:

Commands require current repository **write**, **maintain**, or **admin** permission, checked through GitHub's API when
the command executes. Organization membership or collaborator association alone does not grant permission. If the
permission lookup is unavailable, no command is executed; transient API failures fail the webhook for later redelivery.

- `@cicd-optimizer rebase` rebuilds the change on the latest base, unless someone else has pushed to the branch.
- `@cicd-optimizer recreate` rebuilds the change and overwrites manual edits.
- `@cicd-optimizer close` closes the pull request, and it won't reopen for the same change.
- `@cicd-optimizer ignore this rule [rule-id]` stops fixes for that rule. Without an id, it stops fixes for every rule
  in the pull request.
- `@cicd-optimizer ignore this group` closes the pull request and stops fixes for the group.

Branch rebuilds are conditional on the head observed by the scan. Even `recreate` will fail rather than overwrite a
new push that arrives during the operation; rescan before trying again. Existing PRs retain their head branch when
`branchPrefix` changes; the new prefix applies to new PRs.

Ignores are recorded with the `cicd-optimizer:ignored` label; remove it to undo. Use `fixes.ignore` for permanent ignores.

## Duration alerts (`alerts`)

Raises issues for observed slowdowns that cross the configured statistical and materiality thresholds. Enabled
by default. These observational thresholds are not proof of causality, comparable work, independent samples, or
a calibrated false-positive guarantee across repeated workflow/job comparisons.

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

## Duration evidence and budgets (`durations`)

The configured App knowledge store supplies immutable, context-matched workflow and job duration evidence.
Budgets are explicit preferences, never values inferred from a historical median or percentile.

```yaml
durations:
  minSamples: 20           # integer 2-99; below this, quantiles are withheld
  objectives:             # optional, at most 100; no duplicate workflow/job selectors
    - workflow: .github/workflows/ci.yml
      maxDurationMs: 600000
    - workflow: .github/workflows/ci.yml
      job: build          # jobs.build; each observed matrix leg is assessed separately
      maxDurationMs: 180000
```

Workflow paths are exact, not globs. Budgets must be positive safe integers in milliseconds; equality is within
budget. Missing job selectors are reported as unassessed, not passed. Ambiguous display-name mappings (including
collisions with matrix prefixes or name templates) withhold comparison/budget assessment rather than selecting the
first matching job. Objectives apply to eligible successful
first attempts, not shortened failed/cancelled runs. Skipped jobs are neither sampled nor budgeted; an objective whose
job was skipped in the current run is reported as unmatched. Current configuration is compared with the current run and
eligible history; this is **not** a record of which objective applied when a historical run executed, nor SLO
compliance or a deployment gate. The definition digest changes when the budget/selector changes; raw measurements
and sample quantiles do not. Configuration remains versioned in Git.

The report shows p50/p95; JSON also includes p90, observed min/max, sample identities, exclusions, budget assessments
and unmatched job objectives. Quantiles use [R7 linear interpolation](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/quantile.html).
These are descriptive successful-run estimates, not prediction intervals, confidence guarantees or learned targets.
The default 20-sample display threshold is not a statistical guarantee.

The App uses complete, nonconflicting, comparable immutable run groups for its baseline and alerts when a knowledge
store is configured. It does not fill gaps with mutable telemetry/API history; cold stores therefore need new
eligible observations before comparisons recover. Legacy telemetry-only installations retain their existing
backfill behavior. CLI `telemetry --knowledge` previews show current budgets but do not read or initialize a durable
knowledge database. See [duration evidence](architecture.md#immutable-duration-evidence) for query bounds and exclusions.

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
