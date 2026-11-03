# CI/CD Optimizer

CI/CD Optimizer is a GitHub App that reviews pull requests for opportunities to
make builds and releases faster, more reproducible, and better suited to
high-frequency agentic development.

It behaves like a performance-oriented Dependabot: the app inspects workflow,
dependency, monorepo, and container configuration, then publishes prioritized
findings through a GitHub Check Run. It is advisory by default and never
executes code from the repository it analyzes.

Completed Actions runs also become durable performance snapshots. The app
compares each run with recent successful history and publishes a visual Gantt
timeline, job dependency graph, estimated critical path, bottleneck
observations, queue time, and regression delta.

## What it finds

- Missing dependency and BuildKit caches
- Non-hermetic dependency installation
- Docker layers that reinstall dependencies after ordinary source changes
- Missing multi-stage builds
- Monorepo workflows that rebuild unaffected projects
- Superseded runs that continue consuming runner capacity
- Unbounded jobs and long-lived transient artifacts
- Opportunities to use GHCR and GitHub Packages for organization-local reuse
- Slow critical-path jobs, runner queueing, orchestration gaps, and duration
  regressions across workflow runs

See the complete [rule catalog](docs/rules.md) and
[architecture](docs/architecture.md).

## Local development

Requirements:

- Node.js 22
- A GitHub App with read access to contents and pull requests, write access to
  checks, read access to Actions, and pull request and workflow run webhooks
- PostgreSQL for cross-run telemetry snapshots

```sh
cp .env.example .env
npm install
npm run dev
```

Use a webhook proxy such as Smee for local delivery, then set the GitHub App
webhook URL and credentials in `.env`.

## Repository configuration

Repositories can add `.github/ci-cd-optimizer.yml`:

```yaml
enabled: true
failOnSeverity: never
disabledRules:
  - workflow-timeout
ignoredPaths:
  - generated/**
maxFiles: 500
maxFileBytes: 256000
```

`failOnSeverity` accepts `never`, `low`, `medium`, or `high`. Advisory mode is
recommended until teams have calibrated the rules against their workloads.

## Deployment

Build the container and deploy it to any HTTPS platform that can receive GitHub
webhooks:

```sh
docker build -t ghcr.io/your-org/ci-cd-optimizer:latest .
docker run --env-file .env -p 3000:3000 ghcr.io/your-org/ci-cd-optimizer:latest
```

Store the private key and webhook secret in the platform's managed secret
store. Set `DATABASE_URL` to a durable PostgreSQL database. The included
workflow publishes immutable commit-tagged images to GHCR. Container repository
names must remain lowercase even when the GitHub account contains uppercase
characters.

## Product direction

Static analysis and timing snapshots are the safe first layers. The next layer
should ingest opt-in step telemetry and logs to calculate cache hit rates,
duplicate work, flaky retries, transfer volume, and release lead time. Those
signals can support high-confidence recommendations for test sharding, runner
sizing, remote execution, build graph pruning, reusable workflows, and
cross-repository artifact reuse.
