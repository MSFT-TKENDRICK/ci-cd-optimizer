# CI/CD Optimizer

CI/CD Optimizer is Dependabot for build and release performance. It lints GitHub Actions workflows, Dockerfiles,
and package manifests against platform-engineering best practices: hermetic builds, caching, dependency layers,
sparse checkout, affected-only testing, GHCR and GitHub Packages, and package decomposition. It then acts on the
findings the way GitHub Advanced Security and Dependabot do. It also measures every Actions run, flags statistically
significant slowdowns, and runs hill-climbing experiments with GitHub Agentic Workflows to evolve its own rules and
your pipelines.

It is tuned for agentic development, where many small, agent-authored changes make CI latency the bottleneck.

| GitHub feature | CI/CD Optimizer equivalent |
|---|---|
| Code scanning alerts | Lint findings uploaded as SARIF under **Security › Code scanning** |
| Dependabot alerts → issues | Severity-gated finding issues, deduplicated and auto-closed, assignable to the Copilot coding agent |
| Dependabot version updates | Grouped autofix pull requests with `@cicd-optimizer rebase / recreate / ignore` commands |
| Dependabot compatibility score | Recipes: promoted experiment fixes rolled out to other repos in waves gated by CI pass rate |
| — | Duration alerts: robust z-score spikes and Mann-Whitney step regressions per workflow and job |
| — | Telemetry reports: Gantt timeline, job dependency graph, critical path, slowest steps |

## Three ways to run it

**CLI (the linter MVP).** Works offline on any checkout.

```sh
npm ci && npm run build
npm run cli -- lint .                        # stylish output, exits 1 on errors
npm run cli -- lint . --base origin/main     # only findings this change introduces
npm run cli -- lint . --fix                  # apply safe autofixes
npm run cli -- lint . -f sarif -o cicd.sarif # for code scanning
npm run cli -- rules --format markdown       # rule catalog
```

To use it as a standalone linter (`cicd-lint`, path and stdin input, suppression comments, local rules, a reusable
workflow, and pre-commit), see [docs/linter.md](docs/linter.md).

**GitHub Action.** Runs any CLI command in a workflow; see [examples/](examples/).

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0       # --base needs the base commit
    filter: blob:none    # partial clone: history without old file contents
- uses: MSFT-TKENDRICK/ci-cd-optimizer@v0 # or pin a release commit SHA
  with:
    command: lint
    args: --base origin/${{ github.base_ref }} -f github
```

`command: scan` runs the full Dependabot-style pass through the API: SARIF, issues, and fix PRs.
`command: telemetry` reports on a completed run and raises duration alerts.

For App-authored fixes and coding-agent handoff from Actions, run `npm run setup -- --repo OWNER/REPOSITORY`, or ask
Copilot to set up the App after `npm ci`: an MCP App renders the same ceremony inside chat on hosts that support MCP Apps (`.github/mcp.json`; not yet validated in Copilot Desktop).
The guided ceremony registers and installs the App, stores its credentials, and separately authorizes the
Copilot-licensed user token needed to launch agents. See [setup](docs/setup.md#3-github-app-owner).

**GitHub App.** A Probot service that does the same without any workflow:
- On every pull request, a check run with introduced findings.
- On pushes to the default branch and on install, a repository scan.
- After every completed workflow run, telemetry and alerts.

See [docs/github-app.md](docs/github-app.md). To take any of these to production (repository security, GHCR, App
credentials, tokens, and releases), follow the checklist in [docs/setup.md](docs/setup.md).

## What it finds

33 rules in 8 rulesets, configurable like ESLint: presets, per-rule severity and options, and path ignores.

| Ruleset | Examples |
|---|---|
| `workflow` | Concurrency cancellation, job timeouts, merge queue support, outdated action majors, artifact retention |
| `checkout` | Sparse checkout, partial clone (`filter: blob:none`), correct base refs for affected detection |
| `affected` | Change detection, affected-only test selection instead of `nx run-many`, `turbo run`, `lerna run`, `pnpm -r`, workspace-wide npm/Yarn, or `bazel test //...`, path-filtered required checks |
| `caching` | setup-* dependency caches, build-tool caches, cache key hygiene, Docker layer cache (`type=gha`/registry) |
| `hermeticity` | Frozen lockfiles, pinned actions, runners, container images, and base image digests |
| `containers` | Dependency layer before source, multi-stage builds, BuildKit cache mounts, `.dockerignore`, shared base images |
| `packages` | Monolith decomposition signals, `exports` maps, `files` allowlists, version drift across a monorepo |
| `registries` | Publishing images to GHCR and packages to the GitHub npm registry for org-wide reuse |

Presets are `recommended` (default), `strict`, `agentic`, `github`, `insights`, and `all`. The full catalog with
rationale, examples, and references is in [docs/rules.md](docs/rules.md). Configuration is covered in
[docs/configuration.md](docs/configuration.md).

## Acting on findings

- **Issues.** Findings at or above `issues.minSeverity`/`minImpact` open one issue per rule (or per finding).
  Issues are fingerprinted, updated in place, closed when resolved, and capped by `maxOpen`. With
  `assignCopilot: true` they are assigned to the Copilot coding agent with custom instructions.
- **Fix pull requests.** Safe autofixes are grouped (by ruleset or by named groups) into branches under
  `cicd-optimizer/`, with Dependabot-style commands in the PR body.
- **Duration alerts.** Each workflow run is compared with up to `alerts.window` prior successful runs. Two checks run:
  - **Spike:** a single run with robust z ≥ 3.5, using median and MAD.
  - **Regression:** a sustained step change, where the last 5 runs are slower by a one-sided Mann-Whitney U test with
    p < 0.01.

  Both also need a material increase (20% and 30 s by default). Alerts open an issue with a duration chart and
  close themselves after recovery.

Details: [docs/issues-and-alerts.md](docs/issues-and-alerts.md).

## Hill climbing with GitHub Agentic Workflows

Rules and pipelines evolve through experiments on `experiments/<name>/<arm>` branches:

1. **[experiment-generator](.github/workflows/experiment-generator.md)** (weekly) reads telemetry and findings,
   proposes an experiment scored against the rubric in [.github/hill-climb.yml](.github/hill-climb.yml), and creates
   `experiments/<name>/trunk` with a manifest.
2. **[experiment-arm](.github/workflows/experiment-arm.md)** runs once per arm, in parallel. It implements the arm's
   approach and opens a pull request into the trunk.
3. **[experiment-grader](.github/workflows/experiment-grader.md)** (daily) measures each arm:
   - corpus precision, recall, and fix rate for `rules` experiments;
   - CI durations with a one-sided Mann-Whitney U test against the control for `pipeline` experiments.

   It then promotes the winner into the trunk and opens the trunk → `main` PR for human review.

See [docs/experiments.md](docs/experiments.md), including the threat model.

## Recipes: reusing a winning fix elsewhere

When a promoted `pipeline` experiment merges, [recipe-publish](.github/workflows/recipe-publish.yml) turns its
change set into `recipes/<name>.yml`. The recipe records the rules it fixes, the files it touches, a risk class, and
the measured improvement.

[recipe-rollout](.github/workflows/recipe-rollout.yml) applies it to the repositories in `.github/recipe-targets.yml`:
- canaries first, then waves that only advance while the Wilson lower bound of the CI pass rate stays above the
  threshold;
- an autofix PR where the linter can reproduce the change;
- otherwise an adaptation issue for the Copilot coding agent.

See [docs/recipes.md](docs/recipes.md).

## Evidence-backed project history

The hosted App uses PostgreSQL to link revision-specific project/technology declarations, immutable run attempts,
conservative duration cohorts, and versioned mitigation applications/evaluations. Opt-in `recipes apply|rollout
--record-knowledge` verifies a published recipe before recording target proposals. `knowledge applications|runs|inspect`
provides authorized history; `knowledge refresh|evaluate` records lifecycle state and explicit observational comparisons.
Merging a PR, closing an issue, or passing compatibility checks is not treated as proof of performance benefit.

`execution capture` can wrap a runner command and record timing, checkout context and reported tool/cache observations.
`execution import|list` checks exact run/attempt/job access while retaining **operator-supplied**, non-attested provenance.
Reports never execute code during import and do not silently become trusted duration samples or project attribution.

History is retained by default. Operator-only `maintenance prune|purge` previews its impact and requires a current
confirmation digest before any deletion; referenced evidence is preserved during pruning. No automatic deletion on
App removal is enabled. See [runtime report usage](docs/github-app.md#optional-task-execution-reports),
[retention/removal procedures](docs/github-app.md#knowledge-retention-and-removal), and
[model boundaries](docs/architecture.md#project-declaration-evidence-srcknowledge).

## Project review program

Open-source maintainers can ask for a recurring review of a public repository's CI/CD configuration. To do that,
commit a consent file and open a PR that adds `projects/<name>/project.yaml`, as in
[OSS-Fuzz](https://github.com/google/oss-fuzz). Reviews are static, API-only, and re-verify consent each time.
Public reports redact security-sensitive findings. See [docs/review-program](docs/review-program/README.md) for how
to submit, opt out, and how disclosure works.

## Tokens and permissions

| Credential | Used by | Needed for |
|---|---|---|
| `GITHUB_TOKEN` | All workflows | Lint, SARIF upload, issues, telemetry checks |
| `secrets.CICD_OPTIMIZER_TOKEN` (optional App token or fine-grained PAT) | Scan, gh-aw safe outputs, recipe PRs | Pushing fixes that edit `.github/workflows` (`workflows` permission); PRs that trigger CI |
| `vars.CICD_OPTIMIZER_APP_ID` + `secrets.CICD_OPTIMIZER_APP_PRIVATE_KEY` | Scan, recipe rollout | Installation tokens; cross-repository recipe PRs |
| `secrets.COPILOT_ASSIGN_TOKEN` (user token) | Scan, telemetry, rollout | Assigning issues to the Copilot coding agent |
| `secrets.CICD_OPTIMIZER_DATABASE_URL` (optional) | Recipe rollout | Protected access to the App's evidence database; never expose it to untrusted experiment arms |
| `permissions: copilot-requests: write` | gh-aw workflows | Copilot inference without a PAT (requires an org Copilot subscription; otherwise set `COPILOT_GITHUB_TOKEN`) |

> **Security review note.** `CICD_OPTIMIZER_TOKEN` is the only secret the agentic workflows add. It is used only in
> gh-aw safe-output jobs and the grader's `decide --apply` step, never in the agent job. That is because arms that
> change workflow files can only be pushed with a token that holds the `workflows` permission. Without the secret,
> everything falls back to `GITHUB_TOKEN`, and workflow-changing arms are rejected. Keep the repository's default
> workflow permissions read-only.

## Development

Requires Node.js 22 (see `.nvmrc`).

```sh
npm ci
npm run typecheck && npm run lint && npm test
npm run bundle           # rebuild dist-action/index.js (CI fails when it is stale)
npm run build:ui         # rebuild dist-setup/, the setup panel (CI fails when it is stale)
npm run preview:mcp      # preview the setup panel in a stand-in MCP Apps host against a fake GitHub (docs/setup.md)
npm run docs:rules       # regenerate docs/rules.md
npm run cli -- experiments evaluate --engine dist/lint/api.js --corpus corpus   # benchmark
```

Postgres integration tests run when `DATABASE_URL` is set. Use only a disposable test database: they create/drop
isolated schemas, and readiness permission tests create a temporary NOLOGIN role (requiring `CREATEROLE`) and remove
its grants and role afterward. CI provides its own disposable Postgres service; never use production credentials.

Rules live in `src/lint/rules/<ruleset>/<rule>.ts` and are tested with the ESLint-style `RuleTester` in
`test/lint/rule-tester.ts`. Every rule needs valid and invalid cases plus autofix output checks. New rules should
also add a corpus case ([corpus/README.md](corpus/README.md)) so precision and recall stay measured.

Architecture: [docs/architecture.md](docs/architecture.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).
