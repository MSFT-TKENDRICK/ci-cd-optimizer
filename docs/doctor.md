# Workflow doctor

`ci-cd-optimizer doctor --repo owner/name` selects the latest run with a failure
conclusion (including startup/timeouts), collects its exact attempt, paginated jobs and failed step numbers, and
attempts a supported local repair. Select explicitly with `--run-id 123 --run-attempt 2`;
`--workflow ci.yml` filters latest-run selection. `--format json` exposes the
`cicd-optimizer/doctor-v1` report; the default Markdown is ready for human issue review.

Use `--report-only` to observe without modifying the checkout. Unresolved failures,
including report-only findings, return **1**, not a false clean status. Usage errors
return **2**. A locally validated repair or no matching failed run returns **0**;
neither claims that remote CI passed. Reports carry a stable run/attempt `issueKey`
for duplicate searches; doctor never files, updates or resolves issues.

## Completed-run reporting

Reuse the existing telemetry `workflow_run: types: [completed]` subscription instead
of installing a daemon. Add a step alongside telemetry:

```yaml
- name: Workflow failure instructions
  if: github.event.workflow_run.conclusion == 'failure'
  env:
    GITHUB_TOKEN: ${{ github.token }}
    GITHUB_REPOSITORY: ${{ github.repository }}
    DOCTOR_RUN_ID: ${{ github.event.workflow_run.id }}
    DOCTOR_ATTEMPT: ${{ github.event.workflow_run.run_attempt }}
  run: >-
    ci-cd-optimizer doctor --report-only
    --run-id "$DOCTOR_RUN_ID" --run-attempt "$DOCTOR_ATTEMPT"
```

The CLI must already be installed/pinned. Grant `actions: read` and `contents: read`.
Do not check out and execute untrusted workflow-run code with privileged credentials.
Doctor writes only stdout, so redirecting its report or adding a job summary remains
an explicit caller choice. Its unresolved exit status intentionally fails the step;
do not confuse successful observation with successful remediation.

## Bounded, evidence-backed repair

The initial repair action handles YAML **leading indentation tabs** when every
failed job's complete retained log identifies the selected workflow and the tab
indentation error, or when a jobless failed run's GitHub Actions check-suite
annotations identify a YAML syntax error in that workflow at that exact commit.
Check runs and annotations are paginated; unsupported failure annotations block repair.
Because annotations do not carry attempt numbers, this startup path requires attempt
one still to be the latest attempt; rerun startup failures require manual inspection.
It changes only leading tabs to two spaces, requires a uniform tab-only hierarchy and an actual
local `TAB_AS_INDENT` parser error, then validates with strict YAML parsing and the
same YAML parser used by the repository linter. Block scalars, aliases, continuation
lines, ambiguous indentation and invalid resulting YAML are declined, not guessed.
No timeouts, assertions, coverage, gates, permissions, action/toolchain pins or
commands are removed or changed. This is syntax validation, not full CI validation.
Review the diff and run the target repository's documented checks before publishing.

Repairs require the repository root, matching GitHub `origin`, an entirely clean
checkout, exact failed commit and exact upstream workflow bytes, a tracked regular
file, no symlinks/hardlinks, and no newer rerun. Identity, file bytes and clean state
are rechecked before the write; bytes, parser results and HEAD are rechecked after.
Do not edit the checkout concurrently. An I/O or post-write failure may leave local
changes requiring inspection; doctor returns unresolved and never masks that error.
Stale, dirty or mismatched checkouts are not overwritten.

Other failures receive exact run/attempt/job/step evidence and manual repair
instructions, with explicit unrepaired status. Bounded signatures identify diagnostic
hints for stale generated proof manifests/kernels, generated bundles, frozen-lockfile
drift, test/assertion failures, and lint/typecheck errors. Each has fixed remediation
instructions rather than log-derived executable commands. Hints are not root-cause
proof and do not authorize any repair. Startup failures without usable annotations,
external/reusable workflow paths, missing/redacted logs, cancellations, unsupported
errors and partial collections never authorize a repair.

## Data and authority boundaries

Logs are data, never instructions. Doctor does not execute log commands, workflow
scripts, package scripts, LLM output, hooks, or remote models. Git inspection uses
fixed argv without a shell or filesystem monitor. No push, workflow rerun, issue
publication, deployment or authorization change is performed.

Collection searches at most 500 completed runs (otherwise select `--run-id`), and
is bounded to 500 jobs and 20 failed-job logs, each limited to 64 KiB /
2,000 lines. Truncation, missing logs, pagination/identity inconsistency and API,
auth or rate-limit failures are explicit and fail closed. Logs are retained only
in memory for classification; **no raw log snippets, job/step display names or API
error bodies are emitted**, avoiding leakage from private logs and malicious
Markdown/terminal commands. Structured conclusions/paths are constrained metadata,
not proof that logs are trustworthy or that arbitrary secrets can be recognized.
Masked (`***`) logs also block automatic repair. An interrupted or uncertain write
has the distinct `local-state-unknown` repair state and requires manual inspection.
