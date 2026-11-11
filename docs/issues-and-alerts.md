# Finding issues and duration alerts

CI/CD Optimizer manages two kinds of issues, similar to Dependabot and code scanning alerts. Each issue carries a
hidden marker, `<!-- cicd-optimizer:<kind> fingerprint=... -->`, so the tool can find its own issues again. It
updates them in place rather than opening duplicates, and it never touches issues it didn't create.

## Finding issues

These come from `scan` (CLI or Action) and from the App's push scans of the default branch. Enable them with
`issues.enabled: true` (see [configuration.md](configuration.md#issues-issues)).

A finding qualifies for an issue when its severity is at least `issues.minSeverity` and its impact is at least
`issues.minImpact`. `issues.rules` overrides that per rule: `true` always opens an issue and `false` never does.

| Behavior | Details |
|---|---|
| Grouping | `groupBy: rule` (default) opens one issue per rule, listing every location with permalinks. `groupBy: finding` opens one issue per diagnostic. |
| Labels | `cicd-optimizer`, `ruleset:<ruleset>`, `severity:<severity>`, `impact:<impact>`, plus `issues.labels`. These let triage automation and agents route issues. |
| Updates | Issues are re-rendered only when the set of findings changes, so scans don't create notification noise. |
| Resolution | When a finding disappears, its issue is closed with a comment (`closeResolved: true`). If it reappears, the same issue is reopened. |
| Dismissal | Closing an issue as **not planned** dismisses that finding. It isn't reopened, much like dismissing a code scanning alert. To undo, reopen the issue. |
| Rate limit | At most `maxOpen` finding issues are open at once. Higher severity, then higher impact, then more locations take priority. The rest are reported as skipped in the scan output. |

### Assigning issues to the Copilot coding agent

With `issues.assignCopilot: true`, each new or reopened issue is assigned to the Copilot coding agent, which opens
a pull request for it. The agent receives `issues.copilot` settings such as `baseBranch`, `customInstructions`, an
optional custom agent, and an optional model.

Assignment needs a token for a user with a Copilot license. Installation tokens and `GITHUB_TOKEN` can't assign
agents:

- **CLI and Action:** set `COPILOT_ASSIGN_TOKEN` to a fine-grained token with Issues read/write access to the
  repository.
- **App:** set `COPILOT_ASSIGN_TOKEN` on the server.

Without such a token, or if GitHub refuses assignment, the issue remains labeled `copilot:ready`. **This is a pending
handoff, not a running agent.** The scan summary reports it explicitly. Pending intent is stored with issue creation,
so a transient assignment failure does not lose the work. Once authorization is supplied or renewed, the next scan
retries open pending findings even when their content has not changed. The same reconciliation applies to recipe
adaptation issues and unchanged active duration alerts.

An accepted response must actually list Copilot as an assignee. Reconciliation checks live assignees before assigning,
so an already assigned issue is not started again; successful assignment removes `copilot:ready`. Label persistence
and unexpected API errors fail visibly. Closed/dismissed issues are not queued. Removing `copilot:ready` from an open
issue stops retries; subsequent content updates alone do not reassign it. Reopening a resolved finding is new work.
For an automatically reopened issue, the completed Copilot assignment is removed before reopening, so the recurrence
can start a fresh agent. Removal is verified; a failure leaves the issue closed for a later retry.

The [setup wizard](setup.md#3-github-app-owner) walks through registration, installation and the separate user token.
Give the token an expiry and renew it before that date. Installing the App alone cannot authorize an agent session.

The optional [label-triggered workflow](../examples/workflows/assign-copilot.yml) is another handoff path.
Labels added by `GITHUB_TOKEN` don't trigger workflows, so that optional path needs the App, an App token in the scan
workflow, or a `CICD_OPTIMIZER_TOKEN` personal access token. The scan's direct assignment and reconciliation do not
depend on label-triggered events.

Fixable findings can also become Dependabot-style pull requests directly, with no agent involved. See
[configuration.md](configuration.md#fix-pull-requests-fixes).

## Duration alerts

These come from `telemetry` (CLI or Action, triggered by `workflow_run: completed`) and from the App's `workflow_run`
handler. Alerts are on by default; turn them off with `alerts.enabled: false`.

### What is measured

Every completed run is snapshotted: jobs, steps, runner queue time, and the job dependency graph. The snapshots
form duration series:

- One series for the whole workflow.
- One series per job. Matrix legs share a job key, and the slowest leg counts as the job's wall time.

Only successful runs on `alerts.branches` (all branches when empty) are counted, so failing builds that exit early
don't drag the baseline down.

History comes from the first available source:

1. Postgres (`DATABASE_URL`), App only.
2. A JSON Lines snapshot store (`telemetry --store`), which a workflow can persist with `actions/cache`.
3. The Actions API, rebuilt on every run.

### Detection

Two complementary tests run on every series. A sustained regression takes precedence over a spike on the same series.

| Kind | Test | Fires when |
|---|---|---|
| **Spike** | Robust z-score of the latest run against the median and MAD of up to `window` prior runs. MAD has a floor of max(2% of median, 1 s). | z > `zThreshold` (3.5) and the increase is material. |
| **Regression** | One-sided Mann-Whitney U test of the last `regressionWindow` runs against the `window` runs before them. | p < `pValue` (0.01) and the median shift is material. |

"Material" means at least `minIncreasePercent` (20%) **and** `minIncreaseSeconds` (30 s) above the baseline median.
This prevents alerts on a 2-second job that becomes 3 seconds, or on a 2-hour job that varies by a minute. No series
alerts until it has `minSamples` (10) baseline runs.

Severity: a spike of +100% or more, or a regression of +50% or more, is **critical** (`severity:error`). Anything
else is a **warning** (`severity:warn`).

The robust statistics resist outliers already in the baseline. The rank test catches step changes, such as a
cache that stopped hitting or a new slow test, that are too small for any single run to stand out.

### Lifecycle

The tool keeps one alert issue per workflow and observed workload context, listing every anomalous series. Each one shows its baseline, the observed
duration, the statistic behind it, a duration chart, and links to the runs involved.

- **New anomaly:** the issue is opened, labeled `cicd-optimizer`, `alert:duration`, and `severity:*`, and assigned per
  `alerts.assignees` and `alerts.assignCopilot`.
- **Anomaly changes:** if a series, kind, or severity changes, the issue is updated with a comment. Otherwise it's
  updated silently.
- **Recovery:** the issue closes once every alerted series has `recoveryRuns` (3) consecutive runs back within the
  baseline it had when the alert opened. Comparing against the original baseline matters. Otherwise a lasting
  slowdown would become the new normal and look like a recovery.
  Missing jobs/series or a different context do not prove recovery.
- **Snooze:** closing an alert as **not planned** silences that workflow/context for `snoozeDays` (14).

Contexts distinguish branches, trigger events, executed job/matrix sets, dependencies and observed runner labels/groups.
Only successful first attempts with complete, versioned collection provenance are eligible. Partial/warmed retries,
legacy or incomplete collection, missing runner information and failed jobs cannot open, refresh or close these alerts.
Changed contexts have separate issue identities. A qualified replacement supersedes legacy workflow-only alerts and
same-branch contexts proven absent from the bounded active-context window; unknown or still-active contexts are
preserved. Existing dismissals continue to suppress replacement alerts during the snooze period.
See the [comparison contract](architecture.md#workload-comparison-contract).

### Reports

The telemetry report includes:

- A Mermaid Gantt chart of jobs, with critical-path jobs in red and a lane for time spent waiting for a runner.
- The job dependency graph with the critical path highlighted.
- Queue time, explicitly unavailable for retries.
- The longest jobs and slowest steps.
- Recommendations based on the critical path and queue time.
- Jobs slower than their baseline.
- Log-backed bottleneck candidates from a bounded set of critical/long jobs, with observed durations, next checks, and separate upper bounds for elapsed and runner time.
- Coverage gaps for unavailable, truncated, or unfetched logs and time not explained by reported steps.
- Why comparison is withheld or why no comparable baseline was found in the bounded evidence window.

Attribution requires a complete job inventory and resolved workflow definitions. Log retrieval is bounded to eight jobs
per report; unavailable or skipped logs remain visible as coverage gaps. Savings are upper bounds from observed time,
not predicted results or measured improvements, and overlapping findings must not be added together.

For critical test workloads, reports identify independent jobs with observed slack as candidates for
reusing already-prepared capacity before adding shards and repeating setup. This is not a compatibility
proof: validate runtimes, dependencies, isolation, acyclic scheduling, and unchanged coverage on every
trigger and failure path. Tied critical jobs need joint evaluation. Off-critical tests do not receive
unconditional sharding advice, since extra runners can increase work without shortening the run.

These opportunity reports are independent of experiment grading: rejection means none of the tested candidates
qualified, not that no optimization opportunities remain. Static scans also flag the same resolved Dockerfile
declared in multiple workflows as a low-confidence reuse candidate. They do not prove that the builds run together,
produce identical images, or can safely be removed; compare inputs and measure before changing the pipeline.
An intentionally excluded relevant file still makes the global inventory incomplete. Reports expose that scope
and skipped rules rather than treating the selected files as evidence that nothing else exists.

It's written to the step summary and, with `--check`, posted as a neutral check run on the commit. The App always
posts the check.
