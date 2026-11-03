# Architecture

CI/CD Optimizer follows the same low-friction review model as dependency update
tools: install a GitHub App, open or update a pull request, and receive a check
run with concrete findings.

## Request flow

1. A pull-request webhook starts an in-progress check run.
2. The app requests the recursive Git tree for the pull request head.
3. Only relevant workflow, manifest, lock, monorepo, and container files are
   downloaded. File count and size are bounded.
4. Pure analysis rules inspect the repository snapshot.
5. Findings are sorted by impact and emitted as a check summary and inline
   annotations.

## Telemetry flow

1. A completed workflow-run webhook retrieves the run's jobs and workflow
   definition.
2. Queue time, job duration, dependencies, and total elapsed time are normalized
   into a snapshot.
3. The snapshot is compared with recent successful runs of the same workflow
   and branch, then persisted in PostgreSQL.
4. A telemetry check publishes a Mermaid Gantt chart, dependency graph,
   estimated critical path, slowest jobs, regression delta, and focused
   observations.

Snapshots make recommendations progressively more repository-specific without
executing build code or downloading build outputs.

The analyzer does not execute repository code, expand workflow expressions, or
mutate the repository. This keeps untrusted pull requests isolated from the app
runtime.

## Rule design principles

- **Evidence over guesses:** Findings require a detectable pattern and carry a
  confidence level.
- **Actionable output:** Every finding includes impact, effort, explanation, and
  a concrete recommendation.
- **Advisory by default:** Findings produce a neutral check. Repositories may
  configure an enforcement threshold.
- **Repository-aware:** Rules can correlate workflows, lockfiles, package
  manifests, Dockerfiles, and monorepo configuration.
- **Extensible:** Each rule implements one small interface and is independently
  testable.

## Future evolution

- Parse opt-in step logs and OpenTelemetry data to distinguish cache misses,
  compilation, tests, network transfer, and artifact handling.
- Correlate changed paths with workflow run history to recommend job splitting,
  runner sizing, and affected-project boundaries.
- Add safe pull-request remediation for deterministic changes such as
  concurrency groups, cache inputs, and artifact retention.
- Add an organization dashboard for duplicate builds, cache hit rates, runner
  saturation, flaky jobs, and release lead time.
- Model shared build artifacts and package graphs across repositories while
  preserving tenant boundaries.
